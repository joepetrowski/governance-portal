// What an account has voted, read from chain state, and the transactions to vote.

import { ConvictionVotingVoteAccountVote } from "@polkadot-api/descriptors"
import { assetHubApi, collectivesApi, type Network, RELAY_BLOCK_MS } from "../chains"
import { formatBalance } from "../ui/format"
import type { Stage } from "./load"

/** The direction of a vote. The Fellowship cannot abstain. */
export type Direction = "aye" | "nay" | "abstain"

/** What an account has done on one referendum: nothing, voted, or delegated the track. */
export type VoteStatus =
  | { type: "none" }
  | { type: "voted"; direction: Direction | "split"; detail: string }
  | { type: "delegating"; target: string }

/** What governance needs to know about one wallet account. */
export interface AccountStatus {
  /** The account. */
  address: string
  /** Fellowship rank, or null if not a member. */
  rank: number | null
  /** Total balance on each network's Asset Hub, all of which can back a vote there. */
  balance: Record<Network, bigint>
  /** Free balance on each chain, which is what can pay a deposit there. */
  free: { assetHub: bigint; collectives: bigint; kusamaAssetHub: bigint }
  /** Keyed by `stageKey`. */
  votes: Record<string, VoteStatus>
}

/** Key of a referendum that is unique across bodies and networks, such as "polkadot-open-1973". */
export const stageKey = (stage: Pick<Stage, "network" | "body" | "index">) =>
  `${stage.network}-${stage.body}-${stage.index}`

/** Conviction multipliers by index. Index 0 is 0.1x with no lock. */
export const CONVICTIONS = ["0.1x", "1x", "2x", "3x", "4x", "5x", "6x"]
const AYE_BIT = 0x80

/** Summarize a conviction vote on a network as a direction and a line of text. */
export function describeOpenVote(
  vote: ConvictionVotingVoteAccountVote,
  network: Network,
): VoteStatus {
  const formatDot = (planck: bigint) => formatBalance(planck, network)
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
        detail:
          `Split: ${formatDot(aye)} aye, ${formatDot(nay)} nay, ` + `${formatDot(abstain)} abstain`,
      }
    }
  }
}

/**
 * Read an account's Fellowship rank, balances, and votes on the given referenda. A network that
 * is in `skip`, or that cannot be read, counts as a zero balance and no votes.
 */
export async function loadAccountStatus(
  address: string,
  stages: Stage[],
  skip: Network[] = [],
): Promise<AccountStatus> {
  const collectives = collectivesApi()
  const fellowship = stages.filter((s) => s.body === "fellowship")
  const votes: Record<string, VoteStatus> = {}

  const perNetwork = async (network: Network) => {
    if (skip.includes(network)) return { free: 0n, reserved: 0n }
    const api = assetHubApi(network)
    const open = stages.filter((s) => s.body === "open" && s.network === network)
    const tracks = [...new Set(open.map((s) => s.trackId))]
    const read = Promise.all([
      api.query.System.Account.getValue(address),
      Promise.all(tracks.map((t) => api.query.ConvictionVoting.VotingFor.getValue(address, t))),
    ]).then(([account, votingByTrack]) => {
      for (const stage of open) {
        const voting = votingByTrack[tracks.indexOf(stage.trackId)]
        if (voting.type === "Delegating") {
          votes[stageKey(stage)] = { type: "delegating", target: voting.value.target }
          continue
        }
        const cast = voting.value.votes.find(([index]) => index === stage.index)
        votes[stageKey(stage)] = cast ? describeOpenVote(cast[1], network) : { type: "none" }
      }
      return account.data
    })
    return network === "polkadot" ? read : read.catch(() => ({ free: 0n, reserved: 0n }))
  }

  const [polkadot, kusama, collectivesAccount, member, fellowshipVotes] = await Promise.all([
    perNetwork("polkadot"),
    perNetwork("kusama"),
    collectives.query.System.Account.getValue(address),
    collectives.query.FellowshipCollective.Members.getValue(address),
    Promise.all(
      fellowship.map((s) =>
        collectives.query.FellowshipCollective.Voting.getValue(s.index, address),
      ),
    ),
  ])

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
    balance: {
      polkadot: polkadot.free + polkadot.reserved,
      kusama: kusama.free + kusama.reserved,
    },
    free: {
      assetHub: polkadot.free,
      collectives: collectivesAccount.data.free,
      kusamaAssetHub: kusama.free,
    },
    votes,
  }
}

/** Lock duration in days for each conviction index, from the network's base locking period. */
export async function loadLockDays(network: Network): Promise<number[]> {
  const period = await assetHubApi(network).constants.ConvictionVoting.VoteLockingPeriod()
  const baseDays = (period * RELAY_BLOCK_MS) / 86_400_000
  return CONVICTIONS.map((_, i) => (i === 0 ? 0 : baseDays * 2 ** (i - 1)))
}

/** A vote to cast on a public referendum. */
export interface OpenVote {
  /** Aye, nay, or abstain. */
  direction: Direction
  /** Balance to vote with, in planck. */
  amount: bigint
  /** Index into `CONVICTIONS`. Ignored when abstaining, which carries no conviction. */
  conviction: number
}

/** The transaction that casts or replaces a vote on a public referendum, on its Asset Hub. */
export function openVoteTx(stage: Stage, vote: OpenVote) {
  const accountVote =
    vote.direction === "abstain"
      ? ConvictionVotingVoteAccountVote.SplitAbstain({ aye: 0n, nay: 0n, abstain: vote.amount })
      : ConvictionVotingVoteAccountVote.Standard({
          vote: (vote.direction === "aye" ? AYE_BIT : 0) | vote.conviction,
          balance: vote.amount,
        })
  return assetHubApi(stage.network).tx.ConvictionVoting.vote({
    poll_index: stage.index,
    vote: accountVote,
  })
}

/** The transaction that casts or replaces a Fellowship vote, on Collectives. */
export function fellowshipVoteTx(stage: Stage, aye: boolean) {
  return collectivesApi().tx.FellowshipCollective.vote({ poll: stage.index, aye })
}

/** Anyone may place the decision deposit; it is returned after the referendum ends. */
export function decisionDepositTx(stage: Stage) {
  return stage.body === "fellowship"
    ? collectivesApi().tx.FellowshipReferenda.place_decision_deposit({ index: stage.index })
    : assetHubApi(stage.network).tx.Referenda.place_decision_deposit({ index: stage.index })
}
