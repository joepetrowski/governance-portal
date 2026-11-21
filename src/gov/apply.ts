// The last step of an upgrade. An approved referendum only authorizes a runtime by its hash, on
// each chain. The runtime itself then has to be handed to the chain with
// `System.apply_authorized_upgrade`, which anyone may do: The chain accepts the call without a
// signature and without a fee, as long as the code matches the authorized hash.

import {
  type ChainId,
  CHAINS,
  chainsOf,
  getClient,
  type Network,
  relayApi,
  relayOf,
  systemApi,
} from "../chains"
import { orNothing } from "../util"
import { blake2Hex } from "./decode"
import { type FetchAsset, fetchAssetViaProxy } from "./release"
import type { ReleaseHashes } from "./versions"

const READ_TIMEOUT_MS = 15_000

/** Where an approved upgrade of one chain stands. */
export interface ChainUpgrade {
  /** The chain being upgraded. */
  chain: ChainId
  /** Hash of the new runtime. */
  codeHash: string
  /**
   * "authorized": the chain is waiting to be given the runtime. "scheduled": a parachain has been
   * given it, and the Relay Chain will enact it.
   */
  state: "authorized" | "scheduled"
  /** For a scheduled upgrade, the Relay Chain block at which it is expected to enact. */
  enactsAt: number | null
  /** Relay Chain block at which this was read. */
  now: number
}

const timeout = <T>(promise: Promise<T>) => orNothing(promise, READ_TIMEOUT_MS)

/**
 * The upgrades of a network that are approved but not yet in effect. A chain that cannot be read
 * is left out.
 */
export async function loadChainUpgrades(network: Network): Promise<ChainUpgrade[]> {
  const paras = relayApi(network).query.Paras
  const now = (await timeout(getClient(relayOf(network)).getFinalizedBlock()))?.number
  if (now === undefined) return []

  const perChain = chainsOf(network).map(async (chain): Promise<ChainUpgrade[]> => {
    const { paraId } = CHAINS[chain]
    const [authorized, futureHash, futureAt] = await Promise.all([
      timeout(systemApi(chain).query.System.AuthorizedUpgrade.getValue()),
      paraId === null ? undefined : timeout(paras.FutureCodeHash.getValue(paraId)),
      paraId === null ? undefined : timeout(paras.FutureCodeUpgrades.getValue(paraId)),
    ])
    const found: ChainUpgrade[] = []
    const authorizedHash = authorized?.code_hash
    if (authorizedHash)
      found.push({ chain, codeHash: authorizedHash, state: "authorized", enactsAt: null, now })
    const scheduledHash = futureHash
    if (scheduledHash)
      found.push({
        chain,
        codeHash: scheduledHash,
        state: "scheduled",
        enactsAt: futureAt ?? null,
        now,
      })
    return found
  })
  return (await Promise.all(perChain)).flat()
}

/** File name of a chain's runtime in the release with the given tag, such as "v2.6.0". */
export function runtimeFileName(chain: ChainId, tag: string): string {
  const [major, minor, patch] = tag.slice(1).split(".").map(Number)
  const version = major * 1_000_000 + minor * 1_000 + patch
  return `${CHAINS[chain].runtime}_runtime-v${version}.compact.compressed.wasm`
}

/**
 * Download the runtime that a chain has authorized and hand it to the chain, in a transaction
 * without a signature. The runtime is looked up by its hash in the release notes, and is only
 * submitted if the downloaded bytes hash to what the chain authorized. Returns the events of the
 * transaction.
 */
export async function applyUpgrade(
  upgrade: ChainUpgrade,
  hashes: ReleaseHashes,
  fetchAsset: FetchAsset = fetchAssetViaProxy,
) {
  const tag = hashes[upgrade.codeHash]
  if (!tag) throw new Error("The authorized runtime is not in any recent release.")
  const code = await fetchAsset(tag, runtimeFileName(upgrade.chain, tag))
  if (blake2Hex(code) !== upgrade.codeHash)
    throw new Error("The downloaded runtime does not have the authorized hash.")
  const tx = systemApi(upgrade.chain).tx.System.apply_authorized_upgrade({ code })
  return getClient(upgrade.chain).submitAndWatch(await tx.getBareTx())
}
