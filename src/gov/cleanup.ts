// Votes left behind on finished public referenda, and the balance they keep locked. Everything is
// read from chain state: `ConvictionVoting.VotingFor` is keyed by account first, so one prefix
// query lists every vote an account still has on record.
//
// Fellowship votes are not covered. They lock nothing, and their storage is keyed by referendum.

import { ConvictionVotingVoteAccountVote, MultiAddress } from "@polkadot-api/descriptors"
import { assetHubApi } from "../chains"
import { describeOpenVote } from "./votes"

/** Vote removals per transaction, which keeps the batch well inside a block. */
export const MAX_REMOVALS = 25

/** Locking periods by conviction index, as `Conviction::lock_periods`. */
const LOCK_PERIODS = [0, 1, 2, 4, 8, 16, 32]
const AYE_BIT = 0x80

export interface StaleVote {
  index: number
  trackId: number
  track: string
  /** For example, "Aye with 10 DOT at 2x". */
  detail: string
  outcome: "Approved" | "Rejected" | "Canceled" | "Timed out" | "Killed" | "Unknown"
  /** Relay Chain block until which the vote's balance stays locked, or null if it is free now. */
  lockedUntil: number | null
}

export interface Cleanup {
  address: string
  stale: StaleVote[]
  /** Tracks whose lock can be lowered now, including those with stale votes. */
  tracks: number[]
  lockedNow: bigint
  /** The lock that remains once the votes are removed and the tracks unlocked. */
  lockedAfter: bigint
  /** When the next part of the remaining lock expires, as a Relay Chain block. */
  nextUnlock: number | null
  /** Relay Chain block and wall-clock time at which this was read. */
  now: number
  loadedAt: number
}

const voteBalance = (vote: ConvictionVotingVoteAccountVote): bigint => {
  switch (vote.type) {
    case "Standard":
      return vote.value.balance
    case "Split":
      return vote.value.aye + vote.value.nay
    case "SplitAbstain":
      return vote.value.aye + vote.value.nay + vote.value.abstain
  }
}

const max = (values: bigint[]) => values.reduce((a, b) => (b > a ? b : a), 0n)

export async function loadCleanup(address: string): Promise<Cleanup> {
  const api = assetHubApi()
  const [entries, classLocks, now, period, trackList] = await Promise.all([
    api.query.ConvictionVoting.VotingFor.getEntries(address),
    api.query.ConvictionVoting.ClassLocksFor.getValue(address),
    api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
    api.constants.ConvictionVoting.VoteLockingPeriod(),
    api.constants.Referenda.Tracks(),
  ])
  const trackName = new Map(
    trackList.map(([id, info]) => [id, info.name.replace(/\0+$/, "").replaceAll("_", " ")]),
  )

  const indices = [
    ...new Set(
      entries.flatMap(({ value }) => (value.type === "Casting" ? value.value.votes.map(([i]) => i) : [])),
    ),
  ]
  const infos = await api.query.Referenda.ReferendumInfoFor.getValues(indices.map((i) => [i] as [number]))
  const infoOf = new Map(indices.map((index, i) => [index, infos[i]]))

  const currentLock = new Map(classLocks)
  const stale: StaleVote[] = []
  const needed = new Map<number, bigint>()
  const expiries: number[] = []

  for (const { keyArgs, value } of entries) {
    const trackId = keyArgs[1]
    // The prior lock is what earlier removals left behind: an amount and the block it expires at.
    let [priorUntil, priorAmount] = value.value.prior
    const kept: bigint[] = []

    if (value.type === "Delegating") kept.push(value.value.balance)
    else
      for (const [index, vote] of value.value.votes) {
        const info = infoOf.get(index)
        if (info?.type === "Ongoing") {
          kept.push(voteBalance(vote))
          continue
        }
        // Only a vote with conviction on the winning side of a decided referendum stays locked,
        // from the end of the referendum (`try_remove_vote` in pallet-conviction-voting).
        let lockedUntil: number | null = null
        if ((info?.type === "Approved" || info?.type === "Rejected") && vote.type === "Standard") {
          const aye = (vote.value.vote & AYE_BIT) !== 0
          const periods = LOCK_PERIODS[vote.value.vote & ~AYE_BIT] ?? 0
          const until = info.value[0] + period * periods
          if (aye === (info.type === "Approved") && periods > 0 && now < until) {
            lockedUntil = until
            priorUntil = Math.max(priorUntil, until)
            priorAmount = priorAmount > vote.value.balance ? priorAmount : vote.value.balance
          }
        }
        const described = describeOpenVote(vote)
        stale.push({
          index,
          trackId,
          track: trackName.get(trackId) ?? `track ${trackId}`,
          detail: described.type === "voted" ? described.detail : "",
          outcome:
            info?.type === "Approved" || info?.type === "Rejected" || info?.type === "Killed"
              ? info.type
              : info?.type === "Cancelled"
                ? "Canceled"
                : info?.type === "TimedOut"
                  ? "Timed out"
                  : "Unknown",
          lockedUntil,
        })
      }

    if (now < priorUntil) {
      kept.push(priorAmount)
      expiries.push(priorUntil)
    }
    needed.set(trackId, max(kept))
  }

  const staleTracks = new Set(stale.map((v) => v.trackId))
  const tracks = [...new Set([...needed.keys(), ...currentLock.keys()])].filter(
    (t) => staleTracks.has(t) || (needed.get(t) ?? 0n) < (currentLock.get(t) ?? 0n),
  )
  stale.sort((a, b) => b.index - a.index)

  return {
    address,
    stale,
    tracks,
    lockedNow: max([...currentLock.values()]),
    lockedAfter: max([...needed.values()]),
    nextUnlock: expiries.length > 0 ? Math.min(...expiries) : null,
    now,
    loadedAt: Date.now(),
  }
}

/**
 * One batch that removes up to `MAX_REMOVALS` stale votes and then unlocks every affected track.
 * Removing a vote that is still locked loses nothing: the lock stays until it expires.
 */
export function cleanupTx(cleanup: Cleanup) {
  const api = assetHubApi()
  const removals = cleanup.stale.slice(0, MAX_REMOVALS)
  // Tracks with removals in this batch, and tracks whose lock is already too high.
  const tracks = new Set([
    ...removals.map((v) => v.trackId),
    ...cleanup.tracks.filter((t) => !cleanup.stale.some((v) => v.trackId === t)),
  ])
  return api.tx.Utility.batch_all({
    calls: [
      ...removals.map((v) => api.tx.ConvictionVoting.remove_vote({ class: v.trackId, index: v.index }).decodedCall),
      ...[...tracks].map(
        (t) => api.tx.ConvictionVoting.unlock({ class: t, target: MultiAddress.Id(cleanup.address) }).decodedCall,
      ),
    ],
  })
}
