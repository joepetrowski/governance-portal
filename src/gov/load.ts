// Reads active governance from chain state and presents it as one list of proposals. A proposal
// that needs both the Fellowship (to whitelist) and a public referendum (to dispatch) is a single
// item with two stages, joined by the hash of the whitelisted call.

import { orNothing, orReject } from "../util"
import {
  assetHubApi,
  COLLECTIVES_BLOCK_MS,
  collectivesApi,
  CHAINS,
  getClient,
  type Network,
  NETWORK_IDS,
  NETWORKS,
  RELAY_BLOCK_MS,
} from "../chains"
import { formatBalance, formatList } from "../ui/format"
import { type Curve, delay, threshold } from "./curves"
import {
  blake2Hex,
  hexOf,
  type CallNode,
  chainLabel,
  decodeCall,
  effects,
  isCallTo,
  NOT_LOADED,
  walk,
} from "./decode"

/** Public tracks shown for now: root, whitelisted_caller, staking_admin. */
const OPEN_TRACKS = new Set([0, 1, 10])

/** Where a referendum is in its life cycle. Blocks are on the clock of its stage. */
export type StageStatus =
  | { phase: "awaitingDeposit" }
  | { phase: "preparing"; endsAt: number }
  | { phase: "queued" }
  | { phase: "deciding"; since: number; endsAt: number; passesAt: number | null }
  | { phase: "confirming"; since: number; endsAt: number }

/** One referendum, of the Fellowship or the public, as a step in a proposal's path to enactment. */
export interface Stage {
  /**
   * The network whose chain hosts the referendum. Fellowship referenda are on Polkadot, also when
   * they whitelist a call for Kusama.
   */
  network: Network
  /** Who votes: the Fellowship on Collectives, or token holders on the network's Asset Hub. */
  body: "fellowship" | "open"
  /** Referendum index within its body and network. */
  index: number
  /** Name of the track. */
  track: string
  /** ID of the track. */
  trackId: number
  /** Fellowship only: the lowest rank that may vote. */
  minRank?: number
  /** Account that submitted the referendum. */
  submitter: string
  /** Block at which the referendum was submitted. */
  submitted: number
  /** Current phase and its deadlines. */
  status: StageStatus
  /** Share of ayes among ayes and nays, as fractions in [0, 1]. Null when nobody has voted. */
  approval: { current: number | null; required: number }
  /**
   * Share of the electorate that voted aye, as fractions in [0, 1]. In public referenda, votes to
   * abstain count as well.
   */
  support: { current: number; required: number }
  /** Whether approval and support both meet their thresholds now. */
  passing: boolean
  /** Human-readable total of aye votes. */
  ayes: string
  /** Human-readable total of nay votes. */
  nays: string
  /** Current block on the clock this stage counts in. */
  now: number
  /** Block time of that clock, in milliseconds. */
  blockMs: number
  /** The decision deposit the track requires, and who has placed it, if anyone. */
  deposit: { required: bigint; placed: { who: string; amount: bigint } | null }
  /** The call the referendum would dispatch, or null if its preimage is not available. */
  call: CallNode | null
}

/** A runtime upgrade that a proposal authorizes on one chain. */
export interface Upgrade {
  /** Display name of the chain. */
  chain: string
  /** Hash of the new runtime code, as hex. */
  codeHash: string
  /**
   * Whether the chain will apply the code without checking that it is a newer version of the same
   * runtime (`authorize_upgrade_without_checks`).
   */
  unchecked: boolean
}

/**
 * One thing being decided, shown as one card. A whitelisted proposal joins the Fellowship
 * referendum that whitelists a call with the public referendum that dispatches it.
 */
export interface Proposal {
  /** Stable key built from the referendum indexes, such as "polkadot-open-1973+fellowship-681". */
  id: string
  /** The network the proposal acts on, which a Fellowship referendum reaches over the bridge. */
  network: Network
  /** What the proposal does, in a line. Backticks mark code. */
  title: string
  /** An upgrade, another whitelisted call, or anything else. */
  kind: "upgrade" | "whitelist" | "other"
  /** The Fellowship referendum, if one is open. */
  fellowship?: Stage
  /**
   * When `call` is that of the public referendum, how many things the Fellowship referendum does
   * besides whitelisting it. The card must show the Fellowship referendum's own call if this is
   * not zero, since `call` does not cover it.
   */
  fellowshipExtra: number
  /** The public referendum, if one is open. */
  open?: Stage
  /** Present when the proposal dispatches (or whitelists) a call through the whitelist. */
  whitelist?: {
    /** Hash of the whitelisted call. */
    hash: string
    /** Whether the Fellowship has whitelisted it. Null if that could not be read. */
    whitelisted: boolean | null
    /**
     * The encoded call, when the public referendum carries it, or names it by a hash whose
     * preimage is on chain.
     */
    call?: Uint8Array
  }
  /** Runtime upgrades the proposal authorizes. Empty if it is not an upgrade. */
  upgrades: Upgrade[]
  /**
   * In an upgrade, how many other things the proposal does besides authorizing runtimes. An
   * upgrade is only a plain one when this is zero.
   */
  otherEffects: number
  /** Chains with a call that could not be decoded, so its contents are unknown. */
  undecoded: string[]
  /** The call that will actually execute, for display. */
  call: CallNode | null
}

/** All open proposals as of one read of chain state. */
export interface Snapshot {
  /** Proposals, with upgrades and other whitelisted calls first. */
  proposals: Proposal[]
  /**
   * Whether some open Fellowship referendum could not be read in full (its call is missing, or
   * part of it was not decoded). Such a referendum may whitelist a call without the page knowing,
   * so "no Fellowship referendum is open for this call" cannot be concluded while this is set.
   */
  fellowshipUncertain: boolean
  /** Networks whose public referenda could not be read, so their proposals are missing. */
  unreachable: Network[]
  /**
   * Networks left out of this read on purpose, to be added by a later one. Their public referenda
   * are missing, and calls on their chains are not decoded.
   */
  pending: Network[]
  /** Wall-clock time of the read, in milliseconds. */
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
  decision_deposit: bigint
  min_approval: Curve
  min_support: Curve
}

interface Ongoing {
  track: number
  proposal: Bounded
  submitted: number
  submission_deposit: { who: string }
  decision_deposit?: { who: string; amount: bigint }
  deciding?: { since: number; confirming?: number }
  in_queue: boolean
}

/** A track name as stored on chain, such as "whitelisted_caller", in readable form. */
export const trackName = (raw: string) => raw.replace(/\0+$/, "").replaceAll("_", " ")

/**
 * Minimum rank that can vote on a Fellowship track, as `MinRankOfClass` in the Collectives runtime
 * (fellowship/tracks.rs). Tracks 1-9 are the voice of that rank and above. Retention (11-16),
 * promotion (21-26), and fast promotion (31-33) tracks end in the rank being decided, and voters
 * must be two ranks above it: Retain at or promote to III Dan needs rank 5.
 */
export function fellowshipMinRank(track: number): number {
  return track <= 9 ? track : (track % 10) + 2
}

function stageStatus(info: Ongoing, track: TrackInfo, now: number, a: number | null, s: number) {
  if (info.deciding) {
    const { since, confirming } = info.deciding
    if (confirming !== undefined)
      return {
        phase: "confirming",
        since: confirming - track.confirm_period,
        endsAt: confirming,
      } as const
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
  network: Network,
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
    network,
    body,
    index,
    track: trackName(track.name),
    trackId: info.track,
    minRank: body === "fellowship" ? fellowshipMinRank(info.track) : undefined,
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
    deposit: { required: track.decision_deposit, placed: info.decision_deposit ?? null },
    call,
  }
}

const ratio = (num: bigint, den: bigint) =>
  den === 0n ? 0 : Number((num * 1_000_000_000n) / den) / 1e9

/** Referenda read per request when scanning for the open ones. */
const SCAN_CHUNK = 64
/** Slack added to the longest possible life of a referendum: a day of Relay Chain blocks. */
const SCAN_MARGIN = 14_400

/** A referendum as the scan reads it from `ReferendumInfoFor`: its state, and what that holds. */
export type ScannedInfo = { type: string; value: unknown } | undefined

/**
 * The ongoing referenda among indexes `0` to `count - 1`, without reading every referendum ever
 * submitted. Indexes are scanned from the newest down, and `read` returns the referenda at the
 * indexes it is given.
 *
 * A referendum that is neither queued nor deciding cannot stay open longer than the undeciding
 * timeout, and indexes follow the order of submission. So the scan may stop at the first
 * referendum that ended before `horizon`, the current block less that timeout and the longest
 * decision and confirmation periods: Everything below it was submitted earlier still.
 *
 * Two kinds of referendum can be older than that, and are found in other ways. One that waits in
 * the queue of a full track is exempt from the timeout, so the indexes in `queued` are read
 * directly. One that waited in a queue and is now deciding is counted by its track, so the scan
 * also goes on until it has found as many deciding referenda on every track as `deciding` says
 * there are.
 */
export async function scanOngoing(opts: {
  count: number
  horizon: number
  /** How many referenda are deciding on each track, by track ID. */
  deciding: Map<number, number>
  /** Indexes of the referenda in the queues of all tracks. */
  queued: number[]
  read: (indexes: number[]) => Promise<ScannedInfo[]>
}): Promise<{ index: number; info: unknown }[]> {
  const ongoing = new Map<number, unknown>()
  const found = new Map<number, number>()
  const allDecidingFound = () =>
    [...opts.deciding].every(([track, expected]) => (found.get(track) ?? 0) >= expected)

  let pastHorizon = false
  for (let top = opts.count; top > 0; top -= SCAN_CHUNK) {
    const indexes = Array.from({ length: Math.min(SCAN_CHUNK, top) }, (_, i) => top - 1 - i)
    const values = await opts.read(indexes)
    values.forEach((value, i) => {
      if (!value) return
      if (value.type === "Ongoing") {
        ongoing.set(indexes[i], value.value)
        const { track, deciding } = value.value as { track: number; deciding?: unknown }
        if (deciding !== undefined) found.set(track, (found.get(track) ?? 0) + 1)
        return
      }
      // Every other state records the block at which the referendum ended, alone or first.
      const ended = Array.isArray(value.value) ? value.value[0] : value.value
      if (typeof ended === "number" && ended < opts.horizon) pastHorizon = true
    })
    if (pastHorizon && allDecidingFound()) break
  }

  const missing = [...new Set(opts.queued)].filter((index) => !ongoing.has(index))
  if (missing.length > 0) {
    const values = await opts.read(missing)
    values.forEach((value, i) => {
      if (value?.type === "Ongoing") ongoing.set(missing[i], value.value)
    })
  }
  return [...ongoing].sort(([a], [b]) => b - a).map(([index, info]) => ({ index, info }))
}

/** The public referenda of a network that are still ongoing. See `scanOngoing`. */
async function ongoingReferenda(network: Network, tracks: TrackInfo[], now: number) {
  const api = assetHubApi(network)
  const [count, timeout, decidingCounts, queues] = await Promise.all([
    api.query.Referenda.ReferendumCount.getValue(),
    api.constants.Referenda.UndecidingTimeout(),
    api.query.Referenda.DecidingCount.getEntries(),
    api.query.Referenda.TrackQueue.getEntries(),
  ])
  const longest = Math.max(...tracks.map((t) => t.decision_period + t.confirm_period))
  return scanOngoing({
    count,
    horizon: now - (timeout + longest + SCAN_MARGIN),
    deciding: new Map(decidingCounts.map(({ keyArgs: [track], value }) => [track, value])),
    queued: queues.flatMap(({ value }) => value.map(([index]) => index)),
    read: (indexes) =>
      api.query.Referenda.ReferendumInfoFor.getValues(indexes.map((i) => [i] as [number])),
  })
}

async function loadOpenStages(network: Network): Promise<Stage[]> {
  const api = assetHubApi(network)
  const [tracks, now, issuance, inactive] = await Promise.all([
    api.constants.Referenda.Tracks(),
    // Public referenda count Relay Chain blocks.
    api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
    api.query.Balances.TotalIssuance.getValue(),
    api.query.Balances.InactiveIssuance.getValue(),
  ])
  const trackInfo = new Map(tracks.map(([id, info]) => [id, info as TrackInfo]))
  const electorate = issuance - inactive
  const entries = await ongoingReferenda(network, [...trackInfo.values()], now)

  const stages = entries.map(async ({ index, info: raw }): Promise<Stage | null> => {
    const info = raw as Ongoing & { tally: { ayes: bigint; nays: bigint; support: bigint } }
    const track = trackInfo.get(info.track)
    if (!OPEN_TRACKS.has(info.track) || !track) return null
    const bytes = await proposalBytes(info.proposal, (key) =>
      api.query.Preimage.PreimageFor.getValue(key),
    )
    const { ayes, nays, support } = info.tally
    return buildStage(
      network,
      "open",
      index,
      info,
      track,
      { now, blockMs: RELAY_BLOCK_MS },
      {
        approval: ayes + nays === 0n ? null : ratio(ayes, ayes + nays),
        support: ratio(support, electorate),
        ayes: formatBalance(ayes, network),
        nays: formatBalance(nays, network),
      },
      bytes ? await decodeCall({ id: NETWORKS[network].assetHub }, bytes) : null,
    )
  })
  // Oldest first, as a full read of the storage map would give them.
  return (await Promise.all(stages)).filter((s) => s !== null).reverse()
}

async function loadFellowshipStages(skip: Network[]): Promise<Stage[]> {
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

  const stages = entries.map(async ({ keyArgs, value }): Promise<Stage | null> => {
    if (value.type !== "Ongoing") return null
    const info = value.value as unknown as Ongoing & {
      tally: { bare_ayes: number; ayes: number; nays: number }
    }
    const track = trackInfo.get(info.track)
    if (!track) return null
    const bytes = await proposalBytes(info.proposal, (key) =>
      api.query.Preimage.PreimageFor.getValue(key),
    )
    const { bare_ayes, ayes, nays } = info.tally
    const eligible = membersAtRank.get(fellowshipMinRank(info.track)) ?? 0
    return buildStage(
      "polkadot",
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
      bytes ? await decodeCall({ id: "collectives" }, bytes, skip) : null,
    )
  })
  return (await Promise.all(stages)).filter((s) => s !== null)
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

const argOf = (node: CallNode, key: string) => (node.args as Record<string, unknown>)[key]

/**
 * The hash an open referendum dispatches through the whitelist, with the call itself. A referendum
 * that names the call by hash alone gives `len`, with which the call can be looked up.
 */
function whitelistDispatch(
  stage: Stage,
): { hash: string; inner: CallNode | null; bytes?: Uint8Array; len?: number } | null {
  const root = stage.call
  if (!root) return null
  if (isCallTo(root, "Whitelist", "dispatch_whitelisted_call_with_preimage") && root.bytes) {
    // The call is the only argument, so its encoding is everything after the two index bytes.
    const bytes = root.bytes.subarray(2)
    return { hash: blake2Hex(bytes), inner: root.children[0] ?? null, bytes }
  }
  if (isCallTo(root, "Whitelist", "dispatch_whitelisted_call"))
    return {
      hash: hexOf(argOf(root, "call_hash")),
      inner: null,
      len: Number(argOf(root, "call_encoded_len")),
    }
  return null
}

/**
 * The call behind a hash that a referendum dispatches through the whitelist, read from the
 * preimages on the network's Asset Hub. Null if the preimage is not there, cannot be read in time,
 * or does not have the hash.
 */
async function whitelistedPreimage(
  network: Network,
  hash: string,
  len: number,
): Promise<{ bytes: Uint8Array; call: CallNode } | null> {
  const bytes = await orNothing(
    assetHubApi(network).query.Preimage.PreimageFor.getValue([hash, len]),
    NETWORK_DEADLINE_MS,
  )
  if (!bytes || blake2Hex(bytes) !== hash) return null
  return { bytes, call: await decodeCall({ id: NETWORKS[network].assetHub }, bytes) }
}

/** A hash that a Fellowship referendum whitelists, and where. */
interface WhitelistRequest {
  /** The hash of the call. */
  hash: string
  /** The chain that the whitelist is on. */
  on: CallNode["chain"]
  /** The network whose Asset Hub that is, where it can pair with a public referendum. */
  network: Network | null
}

/** Every hash a Fellowship referendum whitelists, in the order of its call tree. */
function whitelistRequests(stage: Stage): WhitelistRequest[] {
  if (!stage.call) return []
  return [...walk(stage.call)]
    .filter((node) => isCallTo(node, "Whitelist", "whitelist_call"))
    .map((node) => {
      const on = node.chain
      const network = NETWORK_IDS.find((n) => "id" in on && on.id === NETWORKS[n].assetHub)
      return { hash: hexOf(argOf(node, "call_hash")), on, network: network ?? null }
    })
}

/**
 * How many things a Fellowship referendum does besides whitelisting the given hash on the
 * network's Asset Hub. A call that could not be decoded counts, since what it does is unknown.
 * Zero for a referendum that only whitelists the call, which is all that a card for the call shows
 * of it otherwise.
 */
export function effectsBesidesWhitelist(call: CallNode | null, network: Network, hash: string) {
  if (!call) return 0
  const isTheWhitelist = (n: CallNode) =>
    isCallTo(n, "Whitelist", "whitelist_call") &&
    "id" in n.chain &&
    n.chain.id === NETWORKS[network].assetHub &&
    hexOf(argOf(n, "call_hash")) === hash
  return effects(call).filter((n) => !isTheWhitelist(n)).length
}

const isUpgrade = (n: CallNode) =>
  isCallTo(n, "System", "authorize_upgrade") ||
  isCallTo(n, "System", "authorize_upgrade_without_checks")

function upgradesIn(call: CallNode | null): Upgrade[] {
  if (!call) return []
  return [...walk(call)].filter(isUpgrade).map((n) => ({
    chain: chainLabel(n.chain),
    codeHash: hexOf(argOf(n, "code_hash")),
    unchecked: n.name === "authorize_upgrade_without_checks",
  }))
}

/** How a node is named in a title. Backticks mark code, which the interface shows preformatted. */
const nameOf = (n: CallNode) => (n.xcm ? `XCM \`${n.name}\`` : `\`${n.pallet}.${n.name}\``)

function describe(call: CallNode | null): string {
  if (!call) return "Proposal not available"
  if (call.undecoded) return "Undecoded call"
  const leaves = effects(call).filter((n) => !n.undecoded)
  if (leaves.length === 0) {
    const undecoded = [...walk(call)].filter((n) => n.undecoded)
    const targets = [...new Set(undecoded.map((n) => chainLabel(n.chain)))]
    return `Call on ${formatList(targets)}`
  }
  const names = [...new Set(leaves.map(nameOf))]
  const where = [...new Set(leaves.map((n) => chainLabel(n.chain)))]
  const what = names.length > 2 ? [...names.slice(0, 2), `${names.length - 2} more`] : names
  return `${formatList(what)} on ${formatList(where)}`
}

/**
 * Build the proposal that a card shows from its referenda and the call they lead to: its title,
 * the upgrades it authorizes, what else it does, and what could not be decoded.
 */
export function makeProposal(parts: {
  network: Network
  fellowship?: Stage
  open?: Stage
  whitelist?: Proposal["whitelist"]
  /** See `Proposal.fellowshipExtra`. Zero if left out. */
  fellowshipExtra?: number
  call: CallNode | null
  fallbackTitle?: string
}): Proposal {
  const upgrades = upgradesIn(parts.call)
  const undecoded = parts.call
    ? [
        ...new Set(
          [...walk(parts.call)]
            // A call on a network that is still being read is not a failure to decode.
            .filter((n) => n.undecoded && n.undecoded !== NOT_LOADED)
            .map((n) => chainLabel(n.chain)),
        ),
      ]
    : []
  // In an upgrade, a call that cannot be decoded is counted as a chain being upgraded, so that
  // the title does not understate the proposal. The card says which chains are unverified.
  const chains = [...new Set([...upgrades.map((u) => u.chain), ...undecoded])]
  // Whatever else the proposal does is counted and named in the title, so that an upgrade with
  // something added to it does not pass for a plain one. Undecoded calls are counted as chains.
  const otherEffects =
    upgrades.length > 0 && parts.call
      ? effects(parts.call).filter((n) => !isUpgrade(n) && !n.undecoded).length
      : 0
  const others = otherEffects === 1 ? "1 other call" : `${otherEffects} other calls`
  const title =
    upgrades.length > 0
      ? `Runtime upgrade of ${chains.length === 1 ? chains[0] : `${chains.length} chains`}` +
        (otherEffects > 0 ? ` and ${others}` : "")
      : (parts.fallbackTitle ?? describe(parts.call))
  return {
    id: [
      parts.open && `${parts.network}-open-${parts.open.index}`,
      parts.fellowship && `fellowship-${parts.fellowship.index}`,
    ]
      .filter(Boolean)
      .join("+"),
    network: parts.network,
    title,
    kind: upgrades.length > 0 ? "upgrade" : parts.whitelist ? "whitelist" : "other",
    fellowship: parts.fellowship,
    fellowshipExtra: parts.fellowshipExtra ?? 0,
    open: parts.open,
    whitelist: parts.whitelist,
    upgrades,
    otherEffects,
    undecoded,
    call: parts.call,
  }
}

/** How long a network other than Polkadot may take to answer before it counts as unreachable. */
const NETWORK_DEADLINE_MS = 30_000

/** The network of the first chain outside Polkadot that the call reaches, if any. */
function foreignNetwork(call: CallNode | null): Network | null {
  if (!call) return null
  for (const node of walk(call))
    if ("id" in node.chain && CHAINS[node.chain.id].network !== "polkadot")
      return CHAINS[node.chain.id].network
  return null
}

/**
 * Whether a call hash is on the whitelist of a network's Asset Hub. Null if a network other than
 * Polkadot does not answer, so that a failed read is not taken for "not whitelisted". Fails if
 * Polkadot cannot be read.
 */
async function isWhitelisted(network: Network, hash: string): Promise<boolean | null> {
  const read = orReject(
    assetHubApi(network).query.Whitelist.WhitelistedCall.getValue(hash),
    NETWORK_DEADLINE_MS,
    "Timed out",
    // The entry holds no data: It reads as `null` when present and as `undefined` when absent.
  ).then((entry) => entry !== undefined)
  return network === "polkadot" ? read : read.catch(() => null)
}

/**
 * Read every open Fellowship referendum and the public referenda on the shown tracks, decode
 * their calls, and join them into proposals. Fails if the Fellowship or Polkadot cannot be read;
 * a failure to read Kusama is reported in `unreachable`.
 *
 * Polkadot is always read. `networks` says which others to read with it: Leaving Kusama out gives
 * a faster first result, with Kusama listed in `pending`.
 */
export async function loadSnapshot(networks: Network[] = NETWORK_IDS): Promise<Snapshot> {
  const pending = NETWORK_IDS.filter((n) => n !== "polkadot" && !networks.includes(n))
  const included = NETWORK_IDS.filter((n) => !pending.includes(n))
  const unreachable: Network[] = []
  const [fellowship, ...openByNetwork] = await Promise.all([
    loadFellowshipStages(pending),
    ...included.map((network) =>
      // A network other than Polkadot that does not answer in time is reported as unreachable,
      // so that it cannot hold up the rest.
      (network === "polkadot"
        ? loadOpenStages(network)
        : orReject(loadOpenStages(network), NETWORK_DEADLINE_MS, "Timed out")
      ).catch((e) => {
        if (network === "polkadot") throw e
        unreachable.push(network)
        return [] as Stage[]
      }),
    ),
  ])

  const fellowshipUncertain = fellowship.some(
    (stage) => !stage.call || [...walk(stage.call)].some((n) => n.undecoded),
  )

  // Fellowship referenda that whitelist a call, by network and hash.
  const requests = new Map<string, Stage>()
  const unpaired = new Set(fellowship)
  for (const stage of fellowship)
    for (const request of whitelistRequests(stage))
      if (request.network) requests.set(`${request.network}:${request.hash}`, stage)

  const proposals: Proposal[] = []
  for (const stage of openByNetwork.flat()) {
    const { network } = stage
    const dispatch = whitelistDispatch(stage)
    if (!dispatch) {
      proposals.push(makeProposal({ network, open: stage, call: stage.call }))
      continue
    }
    const partner = requests.get(`${network}:${dispatch.hash}`)
    if (partner) unpaired.delete(partner)
    const whitelisted = await isWhitelisted(network, dispatch.hash)
    // A referendum that names the call by hash alone shows the call if its preimage is on chain.
    const found =
      dispatch.inner === null && dispatch.len !== undefined
        ? await whitelistedPreimage(network, dispatch.hash, dispatch.len)
        : null
    proposals.push(
      makeProposal({
        network,
        open: stage,
        fellowship: partner,
        fellowshipExtra: partner
          ? effectsBesidesWhitelist(partner.call, network, dispatch.hash)
          : undefined,
        whitelist: { hash: dispatch.hash, whitelisted, call: dispatch.bytes ?? found?.bytes },
        call: dispatch.inner ?? found?.call ?? stage.call,
      }),
    )
  }

  for (const stage of unpaired) {
    // The card shows the whole call of the referendum, so naming its first whitelist is enough.
    const request = whitelistRequests(stage).at(0)
    // The call may be whitelisted already while this referendum is still open, if an earlier one
    // whitelisted the same hash.
    const whitelisted =
      request?.network && !unreachable.includes(request.network)
        ? await isWhitelisted(request.network, request.hash).catch(() => null)
        : null
    proposals.push(
      makeProposal({
        network: request?.network ?? foreignNetwork(stage.call) ?? "polkadot",
        fellowship: stage,
        whitelist: request ? { hash: request.hash, whitelisted } : undefined,
        call: stage.call,
        fallbackTitle: request ? `Whitelist a call on ${chainLabel(request.on)}` : undefined,
      }),
    )
  }

  const rank = { upgrade: 0, whitelist: 1, other: 2 }
  const newest = (p: Proposal) => p.open?.index ?? p.fellowship?.index ?? 0
  proposals.sort((a, b) => rank[a.kind] - rank[b.kind] || newest(b) - newest(a))
  return { proposals, fellowshipUncertain, unreachable, pending, loadedAt: Date.now() }
}
