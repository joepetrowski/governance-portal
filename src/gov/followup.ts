// What the account that opens a referendum usually does next: place the decision deposit and vote
// aye. Both name the referendum by its index, which the chain assigns only when the submission
// lands. So they cannot ride along with the submission, where a guessed index could turn out to be
// someone else's referendum. They go in a second transaction, built from the index that the
// finalized submission reported.

import { assetHubApi, collectivesApi, type Network } from "../chains"
import { formatExact, formatList } from "../ui/format"
import { type Stage, trackName } from "./load"
import {
  CONVICTIONS,
  decisionDepositTx,
  fellowshipVoteTx,
  type OpenVote,
  openVoteTx,
} from "./votes"

/** A referendum that a transaction opened, as its `Submitted` event reports it. */
export interface Opened {
  /** Whose referendum it is. */
  body: Stage["body"]
  /** The network of the chain that hosts it. Fellowship referenda are on Polkadot. */
  network: Network
  /** The index that the chain gave it. */
  index: number
  /** ID of its track. */
  track: number
}

/**
 * The referenda that a transaction opened, from the events that it emitted. `events` are those of
 * the one transaction, so every referendum found is one that it opened itself.
 */
export function openedBy(events: unknown[], body: Stage["body"], network: Network): Opened[] {
  const pallet = body === "fellowship" ? "FellowshipReferenda" : "Referenda"
  return events.flatMap((event) => {
    if (typeof event !== "object" || event === null) return []
    const { type, value } = event as { type?: unknown; value?: { type?: unknown; value?: unknown } }
    if (type !== pallet || value?.type !== "Submitted") return []
    const { index, track } = (value.value ?? {}) as { index?: unknown; track?: unknown }
    return typeof index === "number" && typeof track === "number"
      ? [{ body, network, index, track }]
      : []
  })
}

/** What to do on a referendum once it is open. */
export interface FollowUpChoice {
  /** Whether to place the decision deposit. */
  deposit: boolean
  /** Whether to vote aye. */
  aye: boolean
  /** On a public referendum, what to vote aye with. A Fellowship vote carries no balance. */
  stake?: Pick<OpenVote, "amount" | "conviction">
}

/** One call of the second transaction. */
export type FollowUpCall =
  | { kind: "deposit"; referendum: Opened }
  | { kind: "fellowshipAye"; referendum: Opened }
  | { kind: "openAye"; referendum: Opened; stake: Pick<OpenVote, "amount" | "conviction"> }

/**
 * The calls that carry out a choice on the referenda that were opened, and a sentence that says
 * exactly what they do, with every amount in full. `deposits` gives the decision deposit of each track, for the sentence.
 * Null if nothing was chosen or nothing was opened. A public aye without a stake is left out.
 */
export function followUp(
  opened: Opened[],
  choice: FollowUpChoice,
  deposits: Map<number, bigint>,
): { calls: FollowUpCall[]; description: string } | null {
  const calls: FollowUpCall[] = []
  const sentences: string[] = []
  for (const referendum of opened) {
    const parts: string[] = []
    if (choice.deposit) {
      calls.push({ kind: "deposit", referendum })
      const amount = deposits.get(referendum.track)
      parts.push(
        amount === undefined
          ? "place the decision deposit"
          : `place the decision deposit of ${formatExact(amount, referendum.network)}`,
      )
    }
    if (choice.aye && referendum.body === "fellowship") {
      calls.push({ kind: "fellowshipAye", referendum })
      parts.push("vote aye")
    }
    if (choice.aye && referendum.body === "open" && choice.stake) {
      calls.push({ kind: "openAye", referendum, stake: choice.stake })
      const { amount, conviction } = choice.stake
      parts.push(
        `vote aye with ${formatExact(amount, referendum.network)} at ${CONVICTIONS[conviction]}`,
      )
    }
    if (parts.length === 0) continue
    const what = formatList(parts)
    const where = referendum.body === "fellowship" ? "Fellowship" : "public"
    sentences.push(
      `${what[0].toUpperCase()}${what.slice(1)} on ${where} referendum #${referendum.index}.`,
    )
  }
  return calls.length > 0 ? { calls, description: sentences.join(" ") } : null
}

function callTx(call: FollowUpCall) {
  switch (call.kind) {
    case "deposit":
      return decisionDepositTx(call.referendum)
    case "fellowshipAye":
      return fellowshipVoteTx(call.referendum, true)
    case "openAye":
      return openVoteTx(call.referendum, { direction: "aye", ...call.stake })
  }
}

/**
 * The transaction that makes the given calls, on the chain of their referenda: the call itself if
 * there is one, and otherwise a batch that makes all of them or none. All calls must be on
 * referenda of one body and network.
 */
export function followUpTx(calls: FollowUpCall[]) {
  const [first] = calls
  const sameChain = calls.every(
    (c) =>
      c.referendum.body === first?.referendum.body &&
      c.referendum.network === first.referendum.network,
  )
  if (!first || !sameChain) throw new Error("The calls are not on referenda of one chain")
  const txs = calls.map(callTx)
  if (txs.length === 1) return txs[0]
  // The calls are of the chain that the batch is on, which the check above has made sure of.
  const decoded = txs.map((tx) => tx.decodedCall)
  return first.referendum.body === "fellowship"
    ? collectivesApi().tx.Utility.batch_all({ calls: decoded as never })
    : assetHubApi(first.referendum.network).tx.Utility.batch_all({ calls: decoded as never })
}

/** The decision deposit of each track of a body on a network, by track ID. */
export async function decisionDeposits(
  body: Stage["body"],
  network: Network,
): Promise<{ id: number; name: string; deposit: bigint }[]> {
  const tracks =
    body === "fellowship"
      ? await collectivesApi().constants.FellowshipReferenda.Tracks()
      : await assetHubApi(network).constants.Referenda.Tracks()
  return tracks.map(([id, info]) => ({
    id,
    name: trackName(info.name),
    deposit: info.decision_deposit,
  }))
}
