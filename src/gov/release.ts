// Turn a Fellowship runtimes release into the referenda that enact it. A release holds the runtimes
// of both networks, and each network is upgraded by its own pair of referenda: a public one on its
// Asset Hub, and one of the Polkadot Fellowship, which whitelists Kusama's call over the bridge.
//
// The calls are built by the `opengov` library (the same code as the `opengov` command line tool,
// compiled to WebAssembly). That library encodes against metadata compiled into it, so every call
// it returns is decoded here against the live runtimes and checked before anything is offered for
// signing.

import type * as Opengov from "opengov"
import { fromHex, toHex } from "polkadot-api/utils"
import {
  assetHubApi,
  CHAIN_IDS,
  CHAINS,
  type ChainId,
  collectivesApi,
  getClient,
  type Network,
  NETWORKS,
} from "../chains"
import { blake2Hex, type CallNode, decodeCall, isCallTo, walk } from "./decode"

/**
 * The `opengov` WebAssembly module, once initialized. Passed in so that the browser and Node can
 * each load it their own way.
 */
export type OpengovLib = typeof Opengov

const REPO = "polkadot-fellows/runtimes"
/** Blocks after approval at which the upgrade enacts, as the command line tool defaults to. */
const ENACT_AFTER = 10
const VERSION_TIMEOUT_MS = 15_000
/** Fellowship rank needed to submit a Fellowship referendum (`SubmitOrigin` on Collectives). */
export const FELLOWSHIP_SUBMIT_RANK = 3

/** A file attached to a release. */
export interface ReleaseAsset {
  /** File name. */
  name: string
  /** Size in bytes. */
  size: number
  /** "sha256:…" as reported by GitHub, when available. */
  digest: string | null
}

/** A release of the Fellowship runtimes repository. */
export interface Release {
  /** Tag, such as "v2.6.0". */
  tag: string
  /** Page of the release on GitHub. */
  url: string
  /** Time of publication, as an ISO 8601 string. */
  publishedAt: string
  /** Files attached to the release, runtimes among them. */
  assets: ReleaseAsset[]
}

/** Accepts "v2.6.0", "2.6.0", or a release URL ending in the tag. Returns "v2.6.0". */
export function parseTag(input: string): string | null {
  const match = /(?:^|\/)v?(\d+\.\d+\.\d+)\/?$/.exec(input.trim())
  return match ? `v${match[1]}` : null
}

/** Release details from the GitHub API, which allows cross-origin reads. */
export async function fetchRelease(tag: string | "latest"): Promise<Release> {
  const path = tag === "latest" ? "latest" : `tags/${tag}`
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/${path}`)
  if (response.status === 404) throw new Error(`There is no release ${tag} of ${REPO}.`)
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the release.`)
  const body = await response.json()
  return {
    tag: body.tag_name,
    url: body.html_url,
    publishedAt: body.published_at,
    assets: (body.assets as { name: string; size: number; digest?: string | null }[]).map((a) => ({
      name: a.name,
      size: a.size,
      digest: a.digest ?? null,
    })),
  }
}

/** What a release would do to one chain. */
export interface ChainPlan {
  /** The chain. */
  chain: ChainId
  /** File name of the chain's runtime in the release. */
  file: string
  /** Null when the release has no runtime for this chain. */
  asset: ReleaseAsset | null
  /** `spec_version` of the release, such as 2006000 for "v2.6.0". */
  newVersion: number
  /** `spec_version` of the live runtime, or null if the chain could not be reached. */
  currentVersion: number | null
}

const timeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))])

async function liveSpecVersion(chain: ChainId): Promise<number | null> {
  try {
    const version = await timeout(
      getClient(chain).getUnsafeApi().constants.System.Version() as Promise<{
        spec_version: number
      }>,
      VERSION_TIMEOUT_MS,
    )
    return version?.spec_version ?? null
  } catch {
    return null
  }
}

/**
 * For each chain of both networks: the runtime the release offers and the version it runs now.
 */
export async function planRelease(lib: OpengovLib, release: Release): Promise<ChainPlan[]> {
  const [major, minor, patch] = release.tag.slice(1).split(".").map(Number)
  const newVersion = major * 1_000_000 + minor * 1_000 + patch
  return Promise.all(
    CHAIN_IDS.map(async (chain) => {
      const file = lib.runtime_file_name(CHAINS[chain].runtime, release.tag)
      return {
        chain,
        file,
        asset: release.assets.find((a) => a.name === file) ?? null,
        newVersion,
        currentVersion: await liveSpecVersion(chain),
      }
    }),
  )
}

/** How to read a release asset. In the browser this goes through the stateless proxy. */
export type FetchAsset = (tag: string, file: string) => Promise<Uint8Array>

/**
 * Read a release asset through the `/release-asset` proxy, since GitHub does not allow cross-origin
 * downloads.
 */
export const fetchAssetViaProxy: FetchAsset = async (tag, file) => {
  const response = await fetch(`/release-asset/${tag}/${file}`)
  if (!response.ok) {
    const reason = (await response.text().catch(() => "")).slice(0, 80)
    throw new Error(`Could not download ${file}: ${reason || `status ${response.status}`}.`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return toHex(new Uint8Array(digest)).slice(2)
}

/**
 * An upgrade proposal and its referenda, built from a release and checked against the live
 * runtimes.
 */
export interface BuiltUpgrade {
  /** The network being upgraded. */
  network: Network
  /** Tag of the release the runtimes come from. */
  tag: string
  /** The chains being upgraded and the hash of each new runtime. */
  runtimes: { chain: ChainId; codeHash: string }[]
  /**
   * The call on the network's Asset Hub that the Fellowship whitelists and the public referendum
   * dispatches.
   */
  proposal: Opengov.NetworkCall
  /** The proposal, decoded against the live runtimes. */
  tree: CallNode
  /** The referendum submissions and preimages, as `opengov` built them. */
  calls: Opengov.ReferendumCalls
  /** What submitting the public referendum reserves on the Asset Hub, besides the preimage. */
  submissionDeposit: bigint
}

const hexArg = (node: CallNode, key: string) => {
  const value = (node.args as Record<string, unknown>)[key]
  return value instanceof Uint8Array ? toHex(value) : String(value)
}

/**
 * Throws unless the Fellowship referendum in `calls`, decoded on the live Collectives runtime,
 * whitelists the call with the given hash on the network's Asset Hub.
 */
async function checkFellowshipCalls(
  calls: Opengov.ReferendumCalls,
  hash: string,
  network: Network,
): Promise<void> {
  if (!calls.fellowship_referendum || calls.whitelisted_call_hash !== hash)
    throw new Error("The generated Fellowship referendum does not whitelist the proposal.")
  const submit = await decodeCall(
    { id: "collectives" },
    fromHex(calls.fellowship_referendum.encoded),
  )
  // What the Fellowship votes on is inside the submission: inline, or as the preimage noted with
  // it.
  const bounded = (submit.args as { proposal?: { type: string; value: unknown } }).proposal
  let voted: Uint8Array | null = null
  if (bounded?.type === "Inline" && bounded.value instanceof Uint8Array) voted = bounded.value
  else if (bounded?.type === "Lookup" && calls.fellowship_preimage) {
    const note = await decodeCall({ id: "collectives" }, fromHex(calls.fellowship_preimage.encoded))
    const noted = (note.args as { bytes?: unknown }).bytes
    if (isCallTo(note, "Preimage", "note_preimage") && noted instanceof Uint8Array) voted = noted
  }
  const whitelists =
    voted !== null &&
    [...walk(await decodeCall({ id: "collectives" }, voted))].some(
      (n) =>
        isCallTo(n, "Whitelist", "whitelist_call") &&
        "id" in n.chain &&
        n.chain.id === NETWORKS[network].assetHub &&
        hexArg(n, "call_hash") === hash,
    )
  if (!isCallTo(submit, "FellowshipReferenda", "submit") || !whitelists)
    throw new Error(
      "The generated Fellowship referendum does not decode as expected on Collectives.",
    )
}

/**
 * The Fellowship referendum that whitelists an existing call on a network's Asset Hub, for a
 * public referendum that is already open without one. `call` is the encoded call that the public
 * referendum dispatches. Throws unless the result, decoded against the live Collectives runtime,
 * whitelists exactly that call.
 */
export async function fellowshipCallsFor(
  lib: OpengovLib,
  network: Network,
  call: Uint8Array,
): Promise<Pick<BuiltUpgrade, "calls">> {
  const calls = lib.referendum_calls({
    proposal: toHex(call),
    network,
    track: "whitelistedcaller",
    dispatch: { after: ENACT_AFTER },
    ...(network === "kusama" ? { fellowship_on_polkadot: true } : {}),
  })
  await checkFellowshipCalls(calls, blake2Hex(call), network)
  return { calls }
}

/**
 * Download the selected runtimes of one network, hash them, and build the upgrade proposal and its
 * referenda. The chains are batched in the order of `CHAIN_IDS`, whatever the order of `plans`, so
 * that the same selection always gives the same call hash. Throws unless the result, decoded
 * against the live runtimes, is exactly the intended upgrade.
 */
export async function buildUpgrade(
  lib: OpengovLib,
  release: Release,
  network: Network,
  selection: ChainPlan[],
  fetchAsset: FetchAsset,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<BuiltUpgrade> {
  const assetHub = NETWORKS[network].assetHub
  const plans = [...selection].sort(
    (a, b) => CHAIN_IDS.indexOf(a.chain) - CHAIN_IDS.indexOf(b.chain),
  )
  if (plans.some((p) => CHAINS[p.chain].network !== network))
    throw new Error(`Not every selected chain belongs to ${NETWORKS[network].name}.`)
  let done = 0
  onProgress(0, plans.length)
  const runtimes = await Promise.all(
    plans.map(async ({ chain, file, asset }) => {
      if (!asset) throw new Error(`The release has no runtime for ${CHAINS[chain].name}.`)
      const bytes = await fetchAsset(release.tag, file)
      // The proxy is not trusted: the bytes must match what GitHub says the asset is.
      if (bytes.length !== asset.size)
        throw new Error(`${file} is ${bytes.length} bytes, but the release lists ${asset.size}.`)
      if (asset.digest?.startsWith("sha256:") && (await sha256Hex(bytes)) !== asset.digest.slice(7))
        throw new Error(`${file} does not match the SHA-256 digest of the release asset.`)
      const codeHash = lib.check_and_hash_runtime(bytes, false)
      onProgress(++done, plans.length)
      return { chain, codeHash }
    }),
  )

  const proposal = lib.build_upgrade({
    relay: network,
    runtimes: runtimes.map((r) => ({ network: CHAINS[r.chain].runtime, code_hash: r.codeHash })),
  })
  const calls = lib.referendum_calls({
    proposal: proposal.encoded,
    network,
    track: "whitelistedcaller",
    dispatch: { after: ENACT_AFTER },
    // Kusama's call is whitelisted by the Polkadot Fellowship, over the bridge.
    ...(network === "kusama" ? { fellowship_on_polkadot: true } : {}),
  })

  // Check 1: on the live runtimes, the proposal authorizes exactly these upgrades and nothing else.
  const tree = await decodeCall({ id: assetHub }, fromHex(proposal.encoded))
  const nodes = [...walk(tree)]
  const leaves = nodes.filter((n) => n.children.length === 0)
  const authorized = leaves
    .filter((n) => !n.undecoded && isCallTo(n, "System", "authorize_upgrade") && "id" in n.chain)
    .map((n) => `${(n.chain as { id: ChainId }).id}:${hexArg(n, "code_hash")}`)
    .sort()
  const intended = runtimes.map((r) => `${r.chain}:${r.codeHash}`).sort()
  if (
    nodes.some((n) => n.undecoded) ||
    leaves.length !== intended.length ||
    authorized.join() !== intended.join()
  )
    throw new Error(
      "The generated proposal does not decode to the intended upgrades on the live runtimes. " +
        "The opengov library is probably out of date with a runtime.",
    )

  // Check 2: the Fellowship referendum whitelists this proposal on the network's Asset Hub.
  await checkFellowshipCalls(calls, proposal.hash, network)

  const submissionDeposit = await assetHubApi(network).constants.Referenda.SubmissionDeposit()
  return { network, tag: release.tag, runtimes, proposal, tree, calls, submissionDeposit }
}

/**
 * The transaction that opens the Fellowship referendum, on Collectives. It notes the preimage in
 * the same batch when the proposal is too long to be carried inline.
 */
export async function fellowshipSubmitTx(built: Pick<BuiltUpgrade, "calls">) {
  const api = collectivesApi()
  const submit = await api.txFromCallData(fromHex(built.calls.fellowship_referendum!.encoded))
  if (!built.calls.fellowship_preimage) return submit
  const preimage = await api.txFromCallData(fromHex(built.calls.fellowship_preimage.encoded))
  return api.tx.Utility.batch_all({ calls: [preimage.decodedCall, submit.decodedCall] })
}

/**
 * The transaction that opens the public referendum, on the network's Asset Hub. It notes the
 * preimage in the same batch, unless the preimage is already on chain.
 */
export async function publicSubmitTx(built: BuiltUpgrade) {
  const api = assetHubApi(built.network)
  const submit = await api.txFromCallData(fromHex(built.calls.public_referendum.encoded))
  const noted = await api.query.Preimage.RequestStatusFor.getValue(built.calls.public_preimage_hash)
  if (noted) return submit
  const preimage = await api.txFromCallData(fromHex(built.calls.public_preimage.encoded))
  return api.tx.Utility.batch_all({ calls: [preimage.decodedCall, submit.decodedCall] })
}
