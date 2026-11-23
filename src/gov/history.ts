// Reads referenda as they were in an earlier block. A referendum that has ended keeps only the
// block at which it ended and its deposits, so its track, call, and tally are read from the last
// block in which it was still ongoing. That needs a node which keeps old state.

import {
  assetHubApi,
  type ChainId,
  collectivesApi,
  getClient,
  type Network,
  NETWORKS,
} from "../chains"

/** A call as a referendum holds it. */
export type Bounded =
  | { type: "Legacy"; value: unknown }
  | { type: "Inline"; value: Uint8Array }
  | { type: "Lookup"; value: { hash: string; len: number } }

/** The encoded call of a referendum, read from the preimages if it is named by hash. */
export async function proposalBytes(
  proposal: Bounded,
  preimageFor: (key: [string, number]) => Promise<Uint8Array | undefined>,
): Promise<Uint8Array | null> {
  if (proposal.type === "Inline") return proposal.value
  if (proposal.type === "Lookup")
    return (await preimageFor([proposal.value.hash, proposal.value.len])) ?? null
  return null
}

/** A referendum as it was in the last block in which it was ongoing. */
export interface LastState {
  /** The ongoing referendum as `pallet-referenda` stored it, with its tally. */
  info: { track: number; proposal: Bounded }
  /** Its encoded call, or null if the preimage was not on chain then. */
  bytes: Uint8Array | null
  /**
   * How many could vote then. For a public referendum, the active issuance in planck. For a
   * Fellowship referendum, the number of members who could vote on its track.
   */
  voters: bigint
}

/**
 * The highest block from `lo` to `hi` at which `holds`, given that it holds at `lo` and that it
 * never holds again after a block at which it does not.
 */
export async function lastBlockWhere(
  lo: number,
  hi: number,
  holds: (block: number) => Promise<boolean>,
): Promise<number> {
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (await holds(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The hash of a finalized block, as the option that reads state at it. The typed API reads at a
 * block hash, and gives no way to find the hash of an old block.
 */
async function at(chain: ChainId, height: number): Promise<{ at: string }> {
  const hashes = await getClient(chain)._request<string[]>("archive_v1_hashByHeight", [height])
  if (hashes.length !== 1) throw new Error(`No single block at height ${height}`)
  return { at: hashes[0] }
}

// What an ended referendum was does not change, so each is read once. A failed read is forgotten,
// to be tried again.
const cache = new Map<string, Promise<LastState | null>>()
function once(key: string, read: () => Promise<LastState | null>) {
  let result = cache.get(key)
  if (!result) {
    result = read()
    cache.set(key, result)
    result.catch(() => cache.delete(key))
  }
  return result
}

/** How many times to look further back for a block in which a public referendum was ongoing. */
const BRACKET_TRIES = 6

/**
 * A public referendum that ended at Relay Chain block `endedAt`, as it was in the last Asset Hub
 * block in which it was ongoing. Null if no such block is found. Fails if the node does not keep
 * state that old.
 *
 * Public referenda count Relay Chain blocks, while their state is in Asset Hub blocks, of which
 * there are several to a Relay Chain block. So the block is searched for: first one far enough
 * back that the referendum was ongoing, then the last such block by bisection.
 *
 * Storage reads: No runtime API or view function gives a referendum, its preimage, or the
 * issuance.
 */
export const lastOngoingPublic = (
  network: Network,
  index: number,
  endedAt: number,
  relayNow: number,
): Promise<LastState | null> =>
  once(`${network}-${index}`, async () => {
    const chain = NETWORKS[network].assetHub
    const api = assetHubApi(network)
    const head = (await getClient(chain).getFinalizedBlock()).number
    const seen = new Map<
      number,
      Promise<{ block: { at: string }; info: LastState["info"] | null }>
    >()
    const read = (height: number) => {
      let found = seen.get(height)
      if (!found) {
        found = at(chain, height).then(async (block) => {
          const value = await api.query.Referenda.ReferendumInfoFor.getValue(index, block)
          const info = value?.type === "Ongoing" ? (value.value as LastState["info"]) : null
          return { block, info }
        })
        seen.set(height, found)
      }
      return found
    }
    const ongoing = async (height: number) => (await read(height)).info !== null

    // A block further back than the chain is long cannot be read. That is so for a referendum
    // that ended before referenda moved to Asset Hub, which is then given up at once.
    let back = Math.max(0, relayNow - endedAt) * 4 + 64
    for (let tries = 1; ; tries++) {
      if (back >= head) return null
      if (await ongoing(head - back)) break
      if (tries === BRACKET_TRIES) return null
      back *= 2
    }
    const lo = head - back
    const { block, info } = await read(await lastBlockWhere(lo, head, ongoing))
    if (!info) return null
    const [bytes, issuance, inactive] = await Promise.all([
      proposalBytes(info.proposal, (key) => api.query.Preimage.PreimageFor.getValue(key, block)),
      api.query.Balances.TotalIssuance.getValue(block),
      api.query.Balances.InactiveIssuance.getValue(block),
    ])
    return { info, bytes, voters: issuance - inactive }
  })

/**
 * A Fellowship referendum that ended at Collectives block `endedAt`, as it was in the block
 * before. Fellowship referenda count Collectives blocks, and a referendum ends before anything else
 * happens in a block, so that is the last block in which it was ongoing. `minRank` gives the lowest
 * rank that may vote on a track. Null if the referendum was not ongoing then. Fails if the node
 * does not keep state that old.
 *
 * Storage reads: No runtime API or view function gives a referendum, its preimage, or the member
 * count.
 */
export const lastOngoingFellowship = (
  index: number,
  endedAt: number,
  minRank: (track: number) => number,
): Promise<LastState | null> =>
  once(`fellowship-${index}`, async () => {
    const api = collectivesApi()
    const block = await at("collectives", endedAt - 1)
    const value = await api.query.FellowshipReferenda.ReferendumInfoFor.getValue(index, block)
    if (value?.type !== "Ongoing") return null
    const info = value.value as unknown as LastState["info"]
    const [bytes, members] = await Promise.all([
      proposalBytes(info.proposal, (key) => api.query.Preimage.PreimageFor.getValue(key, block)),
      api.query.FellowshipCollective.MemberCount.getValue(minRank(info.track), block),
    ])
    return { info, bytes, voters: BigInt(members) }
  })
