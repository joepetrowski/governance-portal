// Votes left behind on finished public referenda of a network, and the balance they keep locked.
// Everything is read from chain state: `ConvictionVoting.VotingFor` is keyed by account first, so
// one prefix query lists every vote an account still has on record.
//
// Fellowship votes are not covered. They lock nothing, and their storage is keyed by referendum.

import { ConvictionVotingVoteAccountVote, MultiAddress } from "@polkadot-api/descriptors"
import { assetHubApi, type Network } from "../chains"
import { trackName } from "./load"
import { AYE_BIT, describeOpenVote } from "./votes"

/** Vote removals per transaction, which keeps the batch well inside a block. */
export const MAX_REMOVALS = 25

/** Locking periods by conviction index, as `Conviction::lock_periods`. */
const LOCK_PERIODS = [0, 1, 2, 4, 8, 16, 32]

/** A vote that an account still has on record for a public referendum that has ended. */
export interface StaleVote {
  /** Referendum index. */
  index: number
  /** ID of the track the referendum ran on, which is also the class of the lock. */
  trackId: number
  /** Name of the track. */
  track: string
  /** For example, "Aye with 10 DOT at 2x". */
  detail: string
  /** How the referendum ended. "Unknown" when its record is no longer in state. */
  outcome: "Approved" | "Rejected" | "Canceled" | "Timed out" | "Killed" | "Unknown"
  /** Relay Chain block until which the vote's balance stays locked, or null if it is free now. */
  lockedUntil: number | null
}

/**
 * Everything one account can clear now: its stale votes and the voting locks that can be lowered.
 */
export interface Cleanup {
  /** The network whose Asset Hub holds the votes and locks. */
  network: Network
  /** The account. */
  address: string
  /** Votes on finished referenda, newest first. */
  stale: StaleVote[]
  /** Tracks whose lock can be lowered now, including those with stale votes. */
  tracks: number[]
  /** Balance locked by voting at present, which is the largest lock over all tracks. */
  lockedNow: bigint
  /** The lock that remains once the votes are removed and the tracks unlocked. */
  lockedAfter: bigint
  /** When the next part of the remaining lock expires, as a Relay Chain block. */
  nextUnlock: number | null
  /** Relay Chain block at which this was read. */
  now: number
  /** Wall-clock time at which this was read, in milliseconds. */
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

/** Whether the account has stale votes to remove or a voting lock that can be lowered. */
export const needsCleanup = (cleanup: Cleanup) => cleanup.stale.length + cleanup.tracks.length > 0

/**
 * Read an account's stale votes and voting locks from Asset Hub, and work out what clearing them
 * would unlock.
 */
export async function loadCleanup(address: string, network: Network): Promise<Cleanup> {
  const api = assetHubApi(network)
  const [entries, classLocks, now, period, trackList] = await Promise.all([
    api.query.ConvictionVoting.VotingFor.getEntries(address),
    api.query.ConvictionVoting.ClassLocksFor.getValue(address),
    api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
    api.constants.ConvictionVoting.VoteLockingPeriod(),
    api.constants.Referenda.Tracks(),
  ])
  const trackNames = new Map(trackList.map(([id, info]) => [id, trackName(info.name)]))

  const indices = [
    ...new Set(
      entries.flatMap(({ value }) =>
        value.type === "Casting" ? value.value.votes.map(([i]) => i) : [],
      ),
    ),
  ]
  const infos = await api.query.Referenda.ReferendumInfoFor.getValues(
    indices.map((i) => [i] as [number]),
  )
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
        const described = describeOpenVote(vote, network)
        stale.push({
          index,
          trackId,
          track: trackNames.get(trackId) ?? `track ${trackId}`,
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
    network,
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
 * Removing a vote that is still locked loses nothing: The lock stays until it expires.
 */
export function cleanupTx(cleanup: Cleanup) {
  const api = assetHubApi(cleanup.network)
  const removals = cleanup.stale.slice(0, MAX_REMOVALS)
  // Tracks with removals in this batch, and tracks whose lock is already too high.
  const tracks = new Set([
    ...removals.map((v) => v.trackId),
    ...cleanup.tracks.filter((t) => !cleanup.stale.some((v) => v.trackId === t)),
  ])
  return api.tx.Utility.batch_all({
    calls: [
      ...removals.map(
        (v) =>
          api.tx.ConvictionVoting.remove_vote({ class: v.trackId, index: v.index }).decodedCall,
      ),
      ...[...tracks].map(
        (t) =>
          api.tx.ConvictionVoting.unlock({ class: t, target: MultiAddress.Id(cleanup.address) })
            .decodedCall,
      ),
    ],
  })
}
