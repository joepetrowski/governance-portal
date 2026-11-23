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

/** How many times to look further back for a block from before a public referendum ended. */
const BRACKET_TRIES = 6
/** How far around the estimated block of the end the search first looks, in blocks. */
const NEAR = 256

/**
 * The last block of a chain in which a referendum was ongoing, when the referendum counts the
 * blocks of another chain: A public referendum ended at Relay Chain block `endedAt`, and its state
 * is in Asset Hub blocks. Null if no such block is found.
 *
 * `relayAt` gives the Relay Chain block that a block of the chain had seen, which never goes down
 * from one block to the next. So the block at which it first reached `endedAt` is found by
 * bisection, wherever the referendum began. The referendum ended in that block or just after it,
 * and `ongoingAt` then finds the last block before that. `head` is the newest block that can be
 * read, and `relayNow` the Relay Chain block that it has seen.
 *
 * Searching for a block in which the referendum was ongoing would not do: Before it was submitted
 * it was not ongoing either, so a search that started there would look ever further back.
 */
export async function lastOngoingBlock(opts: {
  head: number
  relayNow: number
  endedAt: number
  relayAt: (block: number) => Promise<number>
  ongoingAt: (block: number) => Promise<boolean>
}): Promise<number | null> {
  const { head, endedAt, relayAt, ongoingAt } = opts
  const before = async (block: number) => (await relayAt(block)) < endedAt
  if (await before(head)) return null

  // A block from before the end. There are about three Asset Hub blocks to a Relay Chain block.
  let back = Math.max(0, opts.relayNow - endedAt) * 4 + 64
  let lo = Math.max(1, head - back)
  for (let tries = 1; !(await before(lo)); tries++) {
    if (lo === 1 || tries === BRACKET_TRIES) return null
    back *= 2
    lo = Math.max(1, head - back)
  }
  // The blocks of the two chains keep a steady pace, so the end is near where it would be if the
  // pace were even. Looking there first saves most of the bisection.
  let hi = head
  const [first, last] = await Promise.all([relayAt(lo), relayAt(hi)])
  const even = lo + Math.round(((endedAt - first) / Math.max(1, last - first)) * (hi - lo))
  const near = [Math.max(lo, even - NEAR), Math.min(hi, even + NEAR)]
  if (await before(near[0])) lo = near[0]
  if (!(await before(near[1]))) hi = near[1]
  const edge = await lastBlockWhere(lo, hi, before)

  // The referendum ended when the chain had seen `endedAt`, which is in the block after `edge` or
  // the one after that. A few blocks to either side allow for how the chain counts.
  const from = Math.max(1, edge - 2)
  const to = Math.min(head, edge + 8)
  if (!(await ongoingAt(from)) || (await ongoingAt(to))) return null
  return lastBlockWhere(from, to, ongoingAt)
}

/**
 * A public referendum that ended at Relay Chain block `endedAt`, as it was in the last Asset Hub
 * block in which it was ongoing. Null if no such block is found. Fails if the node does not keep
 * state that old. See `lastOngoingBlock` for how the block is found.
 *
 * Storage reads: No runtime API or view function gives a referendum, its preimage, the issuance,
 * or the Relay Chain block that a block has seen.
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
    // Each block is looked up once, however often the search asks for it.
    const memo = <T>(read: (height: number) => Promise<T>) => {
      const seen = new Map<number, Promise<T>>()
      return (height: number) => {
        let found = seen.get(height)
        if (!found) seen.set(height, (found = read(height)))
        return found
      }
    }
    const blockAt = memo((height) => at(chain, height))
    const relayAt = memo(async (height) =>
      api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(await blockAt(height)),
    )
    const infoAt = memo(async (height) => {
      const value = await api.query.Referenda.ReferendumInfoFor.getValue(
        index,
        await blockAt(height),
      )
      return value?.type === "Ongoing" ? (value.value as LastState["info"]) : null
    })

    const found = await lastOngoingBlock({
      head,
      relayNow,
      endedAt,
      relayAt,
      ongoingAt: async (height) => (await infoAt(height)) !== null,
    })
    const info = found === null ? null : await infoAt(found)
    if (found === null || !info) return null
    const block = await blockAt(found)
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
