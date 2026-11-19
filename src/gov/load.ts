// Reads active governance from chain state and presents it as one list of proposals. A proposal
// that needs both the Fellowship (to whitelist) and a public referendum (to dispatch) is a single
// item with two stages, joined by the hash of the whitelisted call.

import { toHex } from "polkadot-api/utils"
import {
  assetHubApi,
  COLLECTIVES_BLOCK_MS,
  collectivesApi,
  getClient,
  RELAY_BLOCK_MS,
} from "../chains"
import { formatList } from "../ui/format"
import { type Curve, delay, threshold } from "./curves"
import { blake2Hex, type CallNode, chainLabel, decodeCall, isCallTo, walk } from "./decode"

/** Public tracks shown for now: root, whitelisted_caller, staking_admin. */
const OPEN_TRACKS = new Set([0, 1, 10])

export type StageStatus =
  | { phase: "awaitingDeposit" }
  | { phase: "preparing"; endsAt: number }
  | { phase: "queued" }
  | { phase: "deciding"; since: number; endsAt: number; passesAt: number | null }
  | { phase: "confirming"; since: number; endsAt: number }

export interface Stage {
  body: "fellowship" | "open"
  index: number
  track: string
  submitter: string
  submitted: number
  status: StageStatus
  /** Fractions in [0, 1]. `current` is null when nobody has voted. */
  approval: { current: number | null; required: number }
  support: { current: number; required: number }
  passing: boolean
  /** Human-readable vote totals. */
  ayes: string
  nays: string
  /** The clock this stage counts in. */
  now: number
  blockMs: number
  call: CallNode | null
}

export interface Upgrade {
  chain: string
  codeHash: string
}

export interface Proposal {
  id: string
  title: string
  kind: "upgrade" | "whitelist" | "other"
  fellowship?: Stage
  open?: Stage
  /** Present when the proposal dispatches (or whitelists) a call through the whitelist. */
  whitelist?: { hash: string; whitelisted: boolean }
  upgrades: Upgrade[]
  /** Chains with a call that could not be decoded, so its contents are unknown. */
  undecoded: string[]
  /** The call that will actually execute, for display. */
  call: CallNode | null
}

export interface Snapshot {
  proposals: Proposal[]
  loadedAt: number
}

type Bounded =
  | { type: "Legacy"; value: unknown }
  | { type: "Inline"; value: Uint8Array }
  | { type: "Lookup"; value: { hash: string; len: number } }

interface TrackInfo {
  name: string
  prepare_period: number
  decision_period: number
  confirm_period: number
  min_approval: Curve
  min_support: Curve
}

interface Ongoing {
  track: number
  proposal: Bounded
  submitted: number
  submission_deposit: { who: string }
  decision_deposit?: unknown
  deciding?: { since: number; confirming?: number }
  in_queue: boolean
}

const trackName = (raw: string) => raw.replace(/\0+$/, "").replaceAll("_", " ")

// Minimum rank that can vote on a Fellowship track, as `MinRankOfClass` in the Collectives runtime
// (fellowship/tracks.rs). Tracks 1-9 are the voice of that rank and above. Retention (11-16),
// promotion (21-26), and fast promotion (31-33) tracks end in the rank being decided, and voters
// must be two ranks above it: retain at or promote to III Dan needs rank 5.
function fellowshipMinRank(track: number): number {
  return track <= 9 ? track : (track % 10) + 2
}

const DOT = 10_000_000_000n
const formatDot = (planck: bigint) =>
  `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(planck / DOT))} DOT`

function stageStatus(info: Ongoing, track: TrackInfo, now: number, a: number | null, s: number) {
  if (info.deciding) {
    const { since, confirming } = info.deciding
    if (confirming !== undefined)
      return { phase: "confirming", since: confirming - track.confirm_period, endsAt: confirming } as const
    const xa = a === null ? null : delay(track.min_approval, a)
    const xs = delay(track.min_support, s)
    const passesAt =
      xa === null || xs === null
        ? null
        : Math.max(now, Math.ceil(since + Math.max(xa, xs) * track.decision_period))
    return { phase: "deciding", since, endsAt: since + track.decision_period, passesAt } as const
  }
  if (!info.decision_deposit) return { phase: "awaitingDeposit" } as const
  if (info.in_queue) return { phase: "queued" } as const
  return { phase: "preparing", endsAt: info.submitted + track.prepare_period } as const
}

function buildStage(
  body: Stage["body"],
  index: number,
  info: Ongoing,
  track: TrackInfo,
  clock: { now: number; blockMs: number },
  tally: { approval: number | null; support: number; ayes: string; nays: string },
  call: CallNode | null,
): Stage {
  const x = info.deciding
    ? Math.min(1, Math.max(0, (clock.now - info.deciding.since) / track.decision_period))
    : 0
  const approval = { current: tally.approval, required: threshold(track.min_approval, x) }
  const support = { current: tally.support, required: threshold(track.min_support, x) }
  return {
    body,
    index,
    track: trackName(track.name),
    submitter: info.submission_deposit.who,
    submitted: info.submitted,
    status: stageStatus(info, track, clock.now, tally.approval, tally.support),
    approval,
    support,
    passing:
      approval.current !== null &&
      approval.current >= approval.required &&
      support.current >= support.required,
    ayes: tally.ayes,
    nays: tally.nays,
    now: clock.now,
    blockMs: clock.blockMs,
    call,
  }
}

const ratio = (num: bigint, den: bigint) => (den === 0n ? 0 : Number((num * 1_000_000_000n) / den) / 1e9)

async function loadOpenStages(): Promise<Stage[]> {
  const api = assetHubApi()
  const [entries, tracks, now, issuance, inactive] = await Promise.all([
    api.query.Referenda.ReferendumInfoFor.getEntries(),
    api.constants.Referenda.Tracks(),
    // Public referenda count Relay Chain blocks.
    api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
    api.query.Balances.TotalIssuance.getValue(),
    api.query.Balances.InactiveIssuance.getValue(),
  ])
  const trackInfo = new Map(tracks.map(([id, info]) => [id, info as TrackInfo]))
  const electorate = issuance - inactive

  const stages: Stage[] = []
  for (const { keyArgs, value } of entries) {
    if (value.type !== "Ongoing" || !OPEN_TRACKS.has(value.value.track)) continue
    const info = value.value as unknown as Ongoing & {
      tally: { ayes: bigint; nays: bigint; support: bigint }
    }
    const track = trackInfo.get(info.track)
    if (!track) continue
    const bytes = await proposalBytes(info.proposal, (key) =>
      api.query.Preimage.PreimageFor.getValue(key),
    )
    const { ayes, nays, support } = info.tally
    stages.push(
      buildStage(
        "open",
        keyArgs[0],
        info,
        track,
        { now, blockMs: RELAY_BLOCK_MS },
        {
          approval: ayes + nays === 0n ? null : ratio(ayes, ayes + nays),
          support: ratio(support, electorate),
          ayes: formatDot(ayes),
          nays: formatDot(nays),
        },
        bytes ? await decodeCall({ id: "assetHub" }, bytes) : null,
      ),
    )
  }
  return stages
}

async function loadFellowshipStages(): Promise<Stage[]> {
  const api = collectivesApi()
  const [entries, tracks, block, memberCounts] = await Promise.all([
    api.query.FellowshipReferenda.ReferendumInfoFor.getEntries(),
    api.constants.FellowshipReferenda.Tracks(),
    // Fellowship referenda count Collectives blocks.
    getClient("collectives")
      .getFinalizedBlock()
      .then((b) => b.number),
    api.query.FellowshipCollective.MemberCount.getEntries(),
  ])
  const trackInfo = new Map(tracks.map(([id, info]) => [id, info as TrackInfo]))
  const membersAtRank = new Map(memberCounts.map(({ keyArgs, value }) => [keyArgs[0], value]))

  const stages: Stage[] = []
  for (const { keyArgs, value } of entries) {
    if (value.type !== "Ongoing") continue
    const info = value.value as unknown as Ongoing & {
      tally: { bare_ayes: number; ayes: number; nays: number }
    }
    const track = trackInfo.get(info.track)
    if (!track) continue
    const bytes = await proposalBytes(info.proposal, (key) =>
      api.query.Preimage.PreimageFor.getValue(key),
    )
    const { bare_ayes, ayes, nays } = info.tally
    const eligible = membersAtRank.get(fellowshipMinRank(info.track)) ?? 0
    stages.push(
      buildStage(
        "fellowship",
        keyArgs[0],
        info,
        track,
        { now: block, blockMs: COLLECTIVES_BLOCK_MS },
        {
          approval: ayes + nays === 0 ? null : ayes / (ayes + nays),
          support: eligible === 0 ? 0 : bare_ayes / eligible,
          ayes: `${ayes} (${bare_ayes} of ${eligible} members)`,
          nays: String(nays),
        },
        bytes ? await decodeCall({ id: "collectives" }, bytes) : null,
      ),
    )
  }
  return stages
}

async function proposalBytes(
  proposal: Bounded,
  preimageFor: (key: [string, number]) => Promise<Uint8Array | undefined>,
): Promise<Uint8Array | null> {
  if (proposal.type === "Inline") return proposal.value
  if (proposal.type === "Lookup")
    return (await preimageFor([proposal.value.hash, proposal.value.len])) ?? null
  return null
}

const hex = (v: unknown) => (v instanceof Uint8Array ? toHex(v) : String(v))
const argOf = (node: CallNode, key: string) => (node.args as Record<string, unknown>)[key]

/** The hash an open referendum dispatches through the whitelist, with the call itself. */
function whitelistDispatch(stage: Stage): { hash: string; inner: CallNode | null } | null {
  const root = stage.call
  if (!root) return null
  if (isCallTo(root, "Whitelist", "dispatch_whitelisted_call_with_preimage") && root.bytes)
    // The call is the only argument, so its encoding is everything after the two index bytes.
    return { hash: blake2Hex(root.bytes.subarray(2)), inner: root.children[0] ?? null }
  if (isCallTo(root, "Whitelist", "dispatch_whitelisted_call"))
    return { hash: hex(argOf(root, "call_hash")), inner: null }
  return null
}

/** The hash a Fellowship referendum whitelists, and where. */
function whitelistRequest(stage: Stage): { hash: string; on: CallNode["chain"] } | null {
  if (!stage.call) return null
  for (const node of walk(stage.call))
    if (isCallTo(node, "Whitelist", "whitelist_call"))
      return { hash: hex(argOf(node, "call_hash")), on: node.chain }
  return null
}

function upgradesIn(call: CallNode | null): Upgrade[] {
  if (!call) return []
  return [...walk(call)]
    .filter(
      (n) =>
        isCallTo(n, "System", "authorize_upgrade") ||
        isCallTo(n, "System", "authorize_upgrade_without_checks"),
    )
    .map((n) => ({ chain: chainLabel(n.chain), codeHash: hex(argOf(n, "code_hash")) }))
}

function describe(call: CallNode | null): string {
  if (!call) return "Proposal not available"
  if (call.undecoded) return "Undecoded call"
  const all = [...walk(call)]
  const leaves = all.filter((n) => n.children.length === 0 && !n.undecoded)
  if (leaves.length === 0) {
    const targets = [...new Set(all.filter((n) => n.undecoded).map((n) => chainLabel(n.chain)))]
    return `Call on ${formatList(targets)}`
  }
  const names = [...new Set(leaves.map((n) => `${n.pallet}.${n.name}`))]
  const where = [...new Set(leaves.map((n) => chainLabel(n.chain)))]
  const what = names.length > 2 ? [...names.slice(0, 2), `${names.length - 2} more`] : names
  return `${formatList(what)} on ${formatList(where)}`
}

function makeProposal(parts: {
  fellowship?: Stage
  open?: Stage
  whitelist?: Proposal["whitelist"]
  call: CallNode | null
  fallbackTitle?: string
}): Proposal {
  const upgrades = upgradesIn(parts.call)
  const undecoded = parts.call
    ? [...new Set([...walk(parts.call)].filter((n) => n.undecoded).map((n) => chainLabel(n.chain)))]
    : []
  // In an upgrade, a call that cannot be decoded is counted as a chain being upgraded, so that
  // the title does not understate the proposal. The card says which chains are unverified.
  const chains = [...new Set([...upgrades.map((u) => u.chain), ...undecoded])]
  const title =
    upgrades.length > 0
      ? `Runtime upgrade of ${chains.length === 1 ? chains[0] : `${chains.length} chains`}`
      : (parts.fallbackTitle ?? describe(parts.call))
  return {
    id: [
      parts.open && `open-${parts.open.index}`,
      parts.fellowship && `fellowship-${parts.fellowship.index}`,
    ]
      .filter(Boolean)
      .join("+"),
    title,
    kind: upgrades.length > 0 ? "upgrade" : parts.whitelist ? "whitelist" : "other",
    fellowship: parts.fellowship,
    open: parts.open,
    whitelist: parts.whitelist,
    upgrades,
    undecoded,
    call: parts.call,
  }
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [open, fellowship] = await Promise.all([loadOpenStages(), loadFellowshipStages()])
  const api = assetHubApi()

  const requests = new Map<string, Stage>()
  const unpaired = new Set(fellowship)
  for (const stage of fellowship) {
    const request = whitelistRequest(stage)
    if (request && "id" in request.on && request.on.id === "assetHub")
      requests.set(request.hash, stage)
  }

  const proposals: Proposal[] = []
  for (const stage of open) {
    const dispatch = whitelistDispatch(stage)
    if (!dispatch) {
      proposals.push(makeProposal({ open: stage, call: stage.call }))
      continue
    }
    const partner = requests.get(dispatch.hash)
    if (partner) unpaired.delete(partner)
    const whitelisted =
      (await api.query.Whitelist.WhitelistedCall.getValue(dispatch.hash)) !== undefined
    proposals.push(
      makeProposal({
        open: stage,
        fellowship: partner,
        whitelist: { hash: dispatch.hash, whitelisted },
        call: dispatch.inner ?? stage.call,
      }),
    )
  }

  for (const stage of unpaired) {
    const request = whitelistRequest(stage)
    proposals.push(
      makeProposal({
        fellowship: stage,
        whitelist: request ? { hash: request.hash, whitelisted: false } : undefined,
        call: stage.call,
        fallbackTitle: request ? `Whitelist a call on ${chainLabel(request.on)}` : undefined,
      }),
    )
  }

  const rank = { upgrade: 0, whitelist: 1, other: 2 }
  const newest = (p: Proposal) => p.open?.index ?? p.fellowship?.index ?? 0
  proposals.sort((a, b) => rank[a.kind] - rank[b.kind] || newest(b) - newest(a))
  return { proposals, loadedAt: Date.now() }
}
