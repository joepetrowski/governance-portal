// What an account has voted, read from chain state, and the transactions to vote.

import { ConvictionVotingVoteAccountVote } from "@polkadot-api/descriptors"
import { assetHubApi, collectivesApi, RELAY_BLOCK_MS } from "../chains"
import { formatDot } from "../ui/format"
import type { Stage } from "./load"

export type Direction = "aye" | "nay" | "abstain"

export type VoteStatus =
  | { type: "none" }
  | { type: "voted"; direction: Direction | "split"; detail: string }
  | { type: "delegating"; target: string }

export interface AccountStatus {
  address: string
  /** Fellowship rank, or null if not a member. */
  rank: number | null
  /** Total balance on Asset Hub, all of which can back a vote. */
  balance: bigint
  /** Free balance on each chain, which is what can pay a decision deposit there. */
  free: { assetHub: bigint; collectives: bigint }
  /** Keyed by `stageKey`. */
  votes: Record<string, VoteStatus>
}

export const stageKey = (stage: Pick<Stage, "body" | "index">) => `${stage.body}-${stage.index}`

/** Conviction multipliers by index. Index 0 is 0.1x with no lock. */
export const CONVICTIONS = ["0.1x", "1x", "2x", "3x", "4x", "5x", "6x"]
const AYE_BIT = 0x80

export function describeOpenVote(vote: ConvictionVotingVoteAccountVote): VoteStatus {
  switch (vote.type) {
    case "Standard": {
      const aye = (vote.value.vote & AYE_BIT) !== 0
      const conviction = CONVICTIONS[vote.value.vote & ~AYE_BIT] ?? "?"
      return {
        type: "voted",
        direction: aye ? "aye" : "nay",
        detail: `${aye ? "Aye" : "Nay"} with ${formatDot(vote.value.balance)} at ${conviction}`,
      }
    }
    case "Split":
      return {
        type: "voted",
        direction: "split",
        detail: `Split: ${formatDot(vote.value.aye)} aye, ${formatDot(vote.value.nay)} nay`,
      }
    case "SplitAbstain": {
      const { aye, nay, abstain } = vote.value
      if (aye === 0n && nay === 0n)
        return { type: "voted", direction: "abstain", detail: `Abstain with ${formatDot(abstain)}` }
      return {
        type: "voted",
        direction: "split",
        detail: `Split: ${formatDot(aye)} aye, ${formatDot(nay)} nay, ${formatDot(abstain)} abstain`,
      }
    }
  }
}

export async function loadAccountStatus(address: string, stages: Stage[]): Promise<AccountStatus> {
  const assetHub = assetHubApi()
  const collectives = collectivesApi()
  const open = stages.filter((s) => s.body === "open")
  const fellowship = stages.filter((s) => s.body === "fellowship")
  const tracks = [...new Set(open.map((s) => s.trackId))]

  const [account, collectivesAccount, member, votingByTrack, fellowshipVotes] = await Promise.all([
    assetHub.query.System.Account.getValue(address),
    collectives.query.System.Account.getValue(address),
    collectives.query.FellowshipCollective.Members.getValue(address),
    Promise.all(tracks.map((t) => assetHub.query.ConvictionVoting.VotingFor.getValue(address, t))),
    Promise.all(
      fellowship.map((s) => collectives.query.FellowshipCollective.Voting.getValue(s.index, address)),
    ),
  ])

  const votes: Record<string, VoteStatus> = {}
  for (const stage of open) {
    const voting = votingByTrack[tracks.indexOf(stage.trackId)]
    if (voting.type === "Delegating") {
      votes[stageKey(stage)] = { type: "delegating", target: voting.value.target }
      continue
    }
    const cast = voting.value.votes.find(([index]) => index === stage.index)
    votes[stageKey(stage)] = cast ? describeOpenVote(cast[1]) : { type: "none" }
  }
  fellowship.forEach((stage, i) => {
    const record = fellowshipVotes[i]
    votes[stageKey(stage)] = record
      ? {
          type: "voted",
          direction: record.type === "Aye" ? "aye" : "nay",
          detail: `${record.type} with weight ${record.value}`,
        }
      : { type: "none" }
  })

  return {
    address,
    rank: member ?? null,
    balance: account.data.free + account.data.reserved,
    free: { assetHub: account.data.free, collectives: collectivesAccount.data.free },
    votes,
  }
}

/** Lock duration in days for each conviction index, from the chain's base locking period. */
export async function loadLockDays(): Promise<number[]> {
  const period = await assetHubApi().constants.ConvictionVoting.VoteLockingPeriod()
  const baseDays = (period * RELAY_BLOCK_MS) / 86_400_000
  return CONVICTIONS.map((_, i) => (i === 0 ? 0 : baseDays * 2 ** (i - 1)))
}

export interface OpenVote {
  direction: Direction
  amount: bigint
  /** Index into `CONVICTIONS`. Ignored when abstaining, which carries no conviction. */
  conviction: number
}

export function openVoteTx(stage: Stage, vote: OpenVote) {
  const accountVote =
    vote.direction === "abstain"
      ? ConvictionVotingVoteAccountVote.SplitAbstain({ aye: 0n, nay: 0n, abstain: vote.amount })
      : ConvictionVotingVoteAccountVote.Standard({
          vote: (vote.direction === "aye" ? AYE_BIT : 0) | vote.conviction,
          balance: vote.amount,
        })
  return assetHubApi().tx.ConvictionVoting.vote({ poll_index: stage.index, vote: accountVote })
}

export function fellowshipVoteTx(stage: Stage, aye: boolean) {
  return collectivesApi().tx.FellowshipCollective.vote({ poll: stage.index, aye })
}

/** Anyone may place the decision deposit; it is returned after the referendum ends. */
export function decisionDepositTx(stage: Stage) {
  return stage.body === "fellowship"
    ? collectivesApi().tx.FellowshipReferenda.place_decision_deposit({ index: stage.index })
    : assetHubApi().tx.Referenda.place_decision_deposit({ index: stage.index })
}
