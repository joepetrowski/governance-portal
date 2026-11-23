// Proposals that are over. The page follows active governance, but a referendum that someone was
// following should not vanish the moment it ends. So those that ended in the last day are still
// shown, as is the one that the address of the page links to, however long ago it ended.

import { assetHubApi, collectivesApi, getClient, type Network } from "../chains"
import { orNothing } from "../util"
import { chainLabel } from "./decode"
import {
  blockMsOf,
  type EndedRef,
  endedOutcome,
  findByAnchor,
  foreignNetwork,
  loadEndedStage,
  makeProposal,
  parseAnchor,
  passedWhitelisters,
  type Proposal,
  type Snapshot,
  type Stage,
  stageAnchor,
  whitelistDispatch,
  whitelistRequests,
} from "./load"

/** How long a finished proposal stays on the page, in milliseconds. */
export const FINISHED_MS = 86_400_000
/** How long the read of one ended referendum may take before it is left out. */
const DEADLINE_MS = 30_000

/** How long ago a referendum ended, in milliseconds. */
export const endedAgo = (ref: Pick<EndedRef, "body" | "at" | "now">) =>
  (ref.now - ref.at) * blockMsOf(ref.body)

/**
 * The referendum that an anchor names, if current state records that it has ended. Null if it is
 * ongoing or does not exist.
 *
 * Storage reads: No runtime API or view function gives a referendum or the Relay Chain block.
 */
async function linkedRef(where: Network | "fellowship", index: number): Promise<EndedRef | null> {
  if (where === "fellowship") {
    const [info, block] = await Promise.all([
      collectivesApi().query.FellowshipReferenda.ReferendumInfoFor.getValue(index),
      getClient("collectives").getFinalizedBlock(),
    ])
    const end = endedOutcome(info)
    return end && { network: "polkadot", body: "fellowship", index, now: block.number, ...end }
  }
  const api = assetHubApi(where)
  const [info, now] = await Promise.all([
    api.query.Referenda.ReferendumInfoFor.getValue(index),
    api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
  ])
  const end = endedOutcome(info)
  return end && { network: where, body: "open", index, now, ...end }
}

/**
 * Join ended referenda into finished proposals, newest first. A public referendum that dispatched
 * a call through the whitelist takes the Fellowship referendum that whitelisted it from
 * `whitelisters`, which is keyed by network and hash. A Fellowship referendum that is shown with a
 * public one, here or among the indexes in `shownElsewhere`, gets no card of its own.
 */
export function finishedProposals(
  stages: Stage[],
  whitelisters: Map<string, Stage>,
  shownElsewhere: Set<number>,
): Proposal[] {
  const paired = new Set(shownElsewhere)
  const proposals: Proposal[] = []
  for (const stage of stages.filter((s) => s.body === "open")) {
    const dispatch = whitelistDispatch(stage)
    const partner = dispatch ? whitelisters.get(`${stage.network}:${dispatch.hash}`) : undefined
    if (partner) paired.add(partner.index)
    proposals.push(
      makeProposal({
        network: stage.network,
        open: stage,
        endedFellowship: partner,
        call: dispatch?.inner ?? stage.call,
      }),
    )
  }
  for (const stage of stages.filter((s) => s.body === "fellowship" && !paired.has(s.index))) {
    const request = whitelistRequests(stage).at(0)
    proposals.push(
      makeProposal({
        network: request?.network ?? foreignNetwork(stage.call) ?? "polkadot",
        endedFellowship: stage,
        call: stage.call,
        fallbackTitle: request ? `Whitelist a call on ${chainLabel(request.on)}` : undefined,
      }),
    )
  }
  const ago = (p: Proposal) => {
    const stage = p.open ?? p.endedFellowship
    return stage?.status.phase === "ended" ? endedAgo({ ...stage, at: stage.status.at }) : 0
  }
  return proposals.sort((a, b) => ago(a) - ago(b))
}

/**
 * The proposals that finished in the last day, with the one that `linked` names if it has ended,
 * whenever that was. `linked` is an anchor from the address of the page. A referendum that cannot
 * be read as it was before it ended is left out, as is a public one on a track that the portal
 * does not show.
 */
export async function loadFinished(snapshot: Snapshot, linked: string | null): Promise<Proposal[]> {
  const refs = snapshot.ended.filter((ref) => endedAgo(ref) <= FINISHED_MS)
  const named = linked ? parseAnchor(linked) : null
  const known = (anchor: string) => refs.some((ref) => stageAnchor(ref) === anchor)
  if (
    linked &&
    named &&
    !findByAnchor(snapshot.proposals, linked) &&
    !known(linked) &&
    !(named.where !== "fellowship" && snapshot.pending.includes(named.where))
  ) {
    const ref = await orNothing(linkedRef(named.where, named.index), DEADLINE_MS)
    if (ref) refs.push(ref)
  }

  const read = await Promise.all(
    refs.map((ref) => orNothing(loadEndedStage(ref, snapshot.pending), DEADLINE_MS)),
  )
  const stages = read.filter((stage) => !!stage)
  // The Fellowship referenda that whitelisted what the public ones dispatched.
  const wanted = new Set(
    stages.flatMap((stage) => {
      const dispatch = stage.body === "open" ? whitelistDispatch(stage) : null
      return dispatch ? [`${stage.network}:${dispatch.hash}`] : []
    }),
  )
  const whitelisters =
    wanted.size > 0
      ? await passedWhitelisters(snapshot.ended, wanted, snapshot.pending).catch(
          () => new Map<string, Stage>(),
        )
      : new Map<string, Stage>()
  const shownElsewhere = new Set(
    snapshot.proposals.flatMap((p) => (p.endedFellowship ? [p.endedFellowship.index] : [])),
  )
  return finishedProposals(stages, whitelisters, shownElsewhere)
}
