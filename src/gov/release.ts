// Turn a Fellowship runtimes release into the referenda that enact it. A release holds the runtimes
// of both networks, and each network is upgraded by its own pair of referenda: a public one on its
// Asset Hub, and one of the Polkadot Fellowship, which whitelists Kusama's call over the bridge.
//
// The calls are built by the `opengov` library (the same code as the `opengov` command line tool,
// compiled to WebAssembly). That library encodes against metadata compiled into it, so every call
// it returns (the proposal, the Fellowship referendum, and the public referendum with its preimage)
// is decoded here against the live runtimes and checked before anything is offered for signing.

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
import { loadReleaseHashes } from "./versions"
import { blake2Hex, type CallNode, decodeCall, effects, isCallTo, walk } from "./decode"

/**
 * The `opengov` WebAssembly module, once initialized. Passed in so that the browser and Node can
 * each load it their own way.
 */
export type OpengovLib = typeof Opengov

const REPO = "polkadot-fellows/runtimes"
/** Blocks after approval at which the upgrade enacts, as the command line tool defaults to. */
export const ENACT_AFTER = 10
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
  if (response.status === 403 || response.status === 429)
    throw new Error("GitHub is limiting requests from this address. Try again in a few minutes.")
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the release.`)
  const body = await response.json()
  if (parseTag(String(body.tag_name)) !== body.tag_name)
    throw new Error(`The release is tagged ${body.tag_name}, which is not a runtime version.`)
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

const hexOf = (value: unknown) => (value instanceof Uint8Array ? toHex(value) : String(value))
const hexArg = (node: CallNode, key: string) => hexOf((node.args as Record<string, unknown>)[key])

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
  // It must do exactly one thing: whitelist this hash on the network's Asset Hub.
  const done = voted === null ? [] : effects(await decodeCall({ id: "collectives" }, voted))
  const [only] = done
  const whitelists =
    done.length === 1 &&
    isCallTo(only, "Whitelist", "whitelist_call") &&
    "id" in only.chain &&
    only.chain.id === NETWORKS[network].assetHub &&
    hexArg(only, "call_hash") === hash
  // A proposal given by hash must be the preimage that is noted with it.
  const lookup = bounded?.type === "Lookup" ? (bounded.value as { hash?: unknown }).hash : null
  const hashMatches = lookup === null || (voted !== null && hexOf(lookup) === blake2Hex(voted))
  // And it must be submitted on the track that may whitelist.
  const origin = (submit.args as { proposal_origin?: { type?: string; value?: { type?: string } } })
    .proposal_origin
  const fellows = origin?.type === "FellowshipOrigins" && origin.value?.type === "Fellows"
  if (!isCallTo(submit, "FellowshipReferenda", "submit") || !whitelists || !hashMatches || !fellows)
    throw new Error(
      "The generated Fellowship referendum does not decode as expected on Collectives.",
    )
}

/**
 * Throws unless the public referendum in `calls`, decoded on the network's live Asset Hub,
 * submits on the Whitelisted Caller track a preimage that dispatches exactly `proposal` through
 * the whitelist, and the preimage to be noted is that same preimage.
 */
async function checkPublicCalls(
  calls: Opengov.ReferendumCalls,
  proposal: Opengov.NetworkCall,
  network: Network,
): Promise<void> {
  const chain = { id: NETWORKS[network].assetHub }
  const wrong = new Error(
    "The generated public referendum does not decode as expected on Asset Hub. " +
      "The opengov library is probably out of date with the runtime.",
  )
  if (blake2Hex(fromHex(proposal.encoded)) !== proposal.hash) throw wrong

  // The preimage: `Whitelist.dispatch_whitelisted_call_with_preimage(proposal)`.
  const preimage = fromHex(calls.public_preimage_bytes)
  const dispatch = await decodeCall(chain, preimage)
  if (
    !isCallTo(dispatch, "Whitelist", "dispatch_whitelisted_call_with_preimage") ||
    // The call is the only argument, so its encoding is everything after the two index bytes.
    toHex(preimage.subarray(2)) !== proposal.encoded ||
    blake2Hex(preimage) !== calls.public_preimage_hash ||
    preimage.length !== calls.public_preimage_len
  )
    throw wrong

  // The call that notes it.
  const note = await decodeCall(chain, fromHex(calls.public_preimage.encoded))
  const noted = (note.args as { bytes?: unknown } | undefined)?.bytes
  if (
    !isCallTo(note, "Preimage", "note_preimage") ||
    !(noted instanceof Uint8Array) ||
    toHex(noted) !== calls.public_preimage_bytes
  )
    throw wrong

  // The submission: that preimage, on the Whitelisted Caller track, enacting after the delay.
  const submit = await decodeCall(chain, fromHex(calls.public_referendum.encoded))
  const args = submit.args as
    | {
        proposal_origin?: { type?: string; value?: { type?: string } }
        proposal?: { type?: string; value?: { hash?: unknown; len?: unknown } }
        enactment_moment?: { type?: string; value?: unknown }
      }
    | undefined
  if (
    !isCallTo(submit, "Referenda", "submit") ||
    args?.proposal_origin?.type !== "Origins" ||
    args.proposal_origin.value?.type !== "WhitelistedCaller" ||
    args.proposal?.type !== "Lookup" ||
    hexOf(args.proposal.value?.hash) !== calls.public_preimage_hash ||
    args.proposal.value?.len !== calls.public_preimage_len ||
    args.enactment_moment?.type !== "After" ||
    args.enactment_moment.value !== ENACT_AFTER
  )
    throw wrong
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
      // The proxy is not trusted: The bytes must match what GitHub says the asset is.
      if (bytes.length !== asset.size)
        throw new Error(`${file} is ${bytes.length} bytes, but the release lists ${asset.size}.`)
      const codeHash = lib.check_and_hash_runtime(bytes, false)
      if (asset.digest?.startsWith("sha256:")) {
        if ((await sha256Hex(bytes)) !== asset.digest.slice(7))
          throw new Error(`${file} does not match the SHA-256 digest of the release asset.`)
      } else if ((await loadReleaseHashes())[codeHash] !== release.tag) {
        // Without a digest from GitHub, the hash listed in the release notes must vouch for it.
        throw new Error(`${file} could not be verified against the release.`)
      }
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
  const leaves = effects(tree)
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

  // Check 3: the public referendum dispatches this proposal, on the Whitelisted Caller track.
  await checkPublicCalls(calls, proposal, network)

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
 * One transaction that opens the Fellowship referenda of several upgrades, on Collectives. It
 * either opens all of them or none.
 */
export async function fellowshipSubmitAllTx(builts: Pick<BuiltUpgrade, "calls">[]) {
  const api = collectivesApi()
  const encoded = builts.flatMap(({ calls }) =>
    [calls.fellowship_preimage, calls.fellowship_referendum].filter((c) => c != null),
  )
  const txs = await Promise.all(encoded.map((c) => api.txFromCallData(fromHex(c.encoded))))
  return api.tx.Utility.batch_all({ calls: txs.map((tx) => tx.decodedCall) })
}

/**
 * The transaction that opens the public referendum, on the network's Asset Hub. It notes the
 * preimage in the same batch, unless the preimage is already on chain.
 */
export async function publicSubmitTx(built: BuiltUpgrade) {
  const api = assetHubApi(built.network)
  const submit = await api.txFromCallData(fromHex(built.calls.public_referendum.encoded))
  // The preimage is on chain only if its bytes are; a request for it alone is not enough.
  const { public_preimage_hash: hash, public_preimage_len: len } = built.calls
  const noted = await api.query.Preimage.PreimageFor.getValue([hash, len])
  if (noted !== undefined) return submit
  const preimage = await api.txFromCallData(fromHex(built.calls.public_preimage.encoded))
  return api.tx.Utility.batch_all({ calls: [preimage.decodedCall, submit.decodedCall] })
}
