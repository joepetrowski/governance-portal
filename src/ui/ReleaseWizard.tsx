import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { type FellowshipActor, useFellowship } from "../actor"
import { CHAINS, type ChainId, chainsOf, type Network, NETWORK_IDS, NETWORKS } from "../chains"
import type { Proposal, Snapshot, Stage } from "../gov/load"
import {
  type BuiltUpgrade,
  buildUpgrade,
  ENACT_AFTER,
  type ChainPlan,
  FELLOWSHIP_SUBMIT_RANK,
  fellowshipSubmitAllTx,
  fellowshipSubmitTx,
  fetchAssetViaProxy,
  fetchRelease,
  parseTag,
  planRelease,
  publicSubmitTx,
  type Release,
} from "../gov/release"
import type { AccountStatus } from "../gov/votes"
import { useWallet } from "../wallet"
import { CallTree } from "./CallTree"
import { formatBalance, formatList } from "./format"
import { Short } from "./Short"
import { loadOpengov } from "./opengov"
import { flowActive, flowSubmitted, useFlow } from "./flows"
import { FlowStatus } from "./FlowStatus"
import { OpenReferendum } from "./OpenReferendum"
import { choice, type Submittable } from "./tx"
import { errorMessage } from "../util"

const field =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"

type Loaded = { release: Release; plans: ChainPlan[] }

/** A chain is offered for upgrade when the release has its runtime and it is not already there. */
const upgradable = (plan: ChainPlan) =>
  plan.asset !== null && (plan.currentVersion === null || plan.currentVersion < plan.newVersion)

function planNote(plan: ChainPlan): string {
  if (!plan.asset) return "not in this release"
  if (plan.currentVersion === null) return "current version unknown (chain not reached)"
  if (plan.currentVersion >= plan.newVersion) return `already at ${plan.currentVersion}`
  return `${plan.currentVersion} → ${plan.newVersion}`
}

/**
 * The hashes of the calls whose Fellowship referendum was submitted from this page, and the way to
 * add to them. Several steps can open the same referendum, and the list of proposals only shows it
 * after finality, so the steps tell each other.
 */
const SentContext = createContext<{
  sent: ReadonlySet<string>
  markSent: (hashes: string[]) => void
}>({ sent: new Set(), markSent: () => {} })

/** One of the two transactions, with its submit button and what stands in the way of it. */
function SubmitStep(props: {
  title: string
  detail: string
  /** Names what the step opens, the same in every control that can open it. See `Flow.key`. */
  flowKey: string
  /** What the step opens, in words, for when its progress is shown away from the step. */
  flowTitle: string
  /** Whose referenda it opens. */
  body: Stage["body"]
  /** The network whose chain hosts them. */
  network: Network
  /** How many referenda it opens. One if left out. */
  count?: number
  /** What the submission reserves from the account, besides fees. */
  reserves?: bigint
  /** Why it should not be submitted, if anything. */
  blocked: string | null
  /** For a Fellowship step, the hashes of the calls that its referenda whitelist. */
  whitelists?: string[]
  status: AccountStatus | undefined
  /** For a Fellowship step, the member that it is submitted for by proxy, if any. */
  proxy?: FellowshipActor["proxy"]
  makeTx: () => Promise<Submittable>
  onSubmitted: () => void
}) {
  const wallet = useWallet()
  const account = wallet.selected
  // A submission that is under way or went through is followed here, whatever else has changed:
  // It must not be offered again, and what it asks the wallet to sign must stay on the page.
  const flow = useFlow(props.flowKey)
  const active = flowActive(flow)
  const submitted = flowSubmitted(flow)
  const { markSent } = useContext(SentContext)
  const hashes = (props.whitelists ?? []).join(",")
  useEffect(() => {
    if (submitted && hashes !== "") markSent(hashes.split(","))
  }, [submitted, hashes, markSent])
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h4 className="font-medium">{props.title}</h4>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{props.detail}</p>
      {active && flow ? (
        <FlowStatus flow={flow} />
      ) : props.blocked ? (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">{props.blocked}</p>
      ) : !account ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Connect a wallet to submit.</p>
      ) : (
        <OpenReferendum
          flowKey={props.flowKey}
          title={props.flowTitle}
          body={props.body}
          network={props.network}
          count={props.count}
          reserves={props.reserves}
          label="Submit"
          account={account}
          status={props.status}
          proxy={props.proxy}
          makeTx={props.makeTx}
          onDone={props.onSubmitted}
        />
      )}
    </section>
  )
}

/** Address of this page that reopens the wizard on the same release, network, and chains. */
function shareLink(built: BuiltUpgrade): string {
  const url = new URL(window.location.href)
  url.search = new URLSearchParams({
    release: built.tag,
    network: built.network,
    chains: built.runtimes.map((r) => r.chain).join(","),
  }).toString()
  return url.toString()
}

/** The release, network, and chains named in this page's address, if it is a shared link. */
function sharedSelection(): { tag: string; network: Network; chains: ChainId[] } | null {
  const params = new URLSearchParams(window.location.search)
  const tag = parseTag(params.get("release") ?? "")
  const network = NETWORK_IDS.find((n) => n === params.get("network"))
  if (!tag || !network) return null
  const named = (params.get("chains") ?? "").split(",")
  return { tag, network, chains: chainsOf(network).filter((c) => named.includes(c)) }
}

/** The proposal that already carries a built upgrade's call, matched by the whitelisted hash. */
const existingFor = (built: BuiltUpgrade, proposals: Proposal[]) =>
  proposals.find((p) => p.network === built.network && p.whitelist?.hash === built.proposal.hash)

/**
 * Why whoever acts in the Fellowship for the selected account should not open the Fellowship
 * referendum, if anything.
 */
function fellowshipBlock(
  existing: Proposal | undefined,
  actor: FellowshipActor | null,
  snapshot: Snapshot,
  /** Whether it was submitted from this page already, by this step or another. */
  sent: boolean,
): string | null {
  if (existing?.fellowship)
    return `Already open as Fellowship referendum #${existing.fellowship.index}.`
  if (sent) return "Submitted from this page. It appears in the list below once it is finalized."
  if (existing?.whitelist?.whitelisted) return "The Fellowship has already whitelisted this call."
  if (existing?.whitelist?.whitelisted === null)
    return "Whether the Fellowship has whitelisted this call could not be read. Try again shortly."
  if (snapshot.fellowshipUncertain)
    return (
      "Cannot tell whether a Fellowship referendum for this call is already open, because an " +
      "open Fellowship referendum could not be read in full. Try again shortly."
    )
  const status = actor?.status
  if (status && (status.rank ?? -1) < FELLOWSHIP_SUBMIT_RANK)
    return (
      `Needs a Fellowship member of rank ${FELLOWSHIP_SUBMIT_RANK} or higher. ` +
      (status.rank === null
        ? "The selected account is not a member."
        : actor.proxy
          ? `The member that the selected account acts for has rank ${status.rank}.`
          : `The selected account has rank ${status.rank}.`)
    )
  return null
}

/**
 * Offered when upgrades for more than one network are built and none of their Fellowship
 * referenda is open yet: One signature opens them all.
 */
function AllFellowship(props: {
  builts: BuiltUpgrade[]
  snapshot: Snapshot
  statuses: AccountStatus[]
  onSubmitted: () => void
}) {
  const { actor } = useFellowship()
  const proxy = actor?.proxy ?? null
  const { sent } = useContext(SentContext)
  const flowKey = `fellowship:${props.builts.map((b) => b.proposal.hash).join("+")}`
  const active = flowActive(useFlow(flowKey))
  const blocks = props.builts.map((b) =>
    fellowshipBlock(
      existingFor(b, props.snapshot.proposals),
      actor,
      props.snapshot,
      sent.has(b.proposal.hash),
    ),
  )
  // If any of them is open already, the remaining one is submitted from its own section. A
  // submission from this step that is under way stays in view, though its referenda are open.
  if (
    props.builts.length < 2 ||
    (!active &&
      props.builts.some((b) => {
        const existing = existingFor(b, props.snapshot.proposals)
        return existing?.fellowship || existing?.whitelist?.whitelisted
      }))
  )
    return null
  const names = props.builts.map((b) => NETWORKS[b.network].name)
  const versions = props.builts.map((b) => `${NETWORKS[b.network].name} to ${b.tag}`)
  return (
    <SubmitStep
      title={`Fellowship referenda for ${formatList(names)}`}
      detail={
        `On Collectives, in one transaction, for the upgrades of ${formatList(versions)}. It ` +
        "does the same as the Fellowship step of each network above, so use one or the other."
      }
      flowKey={flowKey}
      flowTitle={`Fellowship referenda for the upgrades of ${formatList(versions)}`}
      body="fellowship"
      network="polkadot"
      count={props.builts.length}
      status={actor?.status}
      proxy={proxy}
      blocked={blocks.find((b) => b !== null) ?? null}
      whitelists={props.builts.map((b) => b.proposal.hash)}
      makeTx={() => fellowshipSubmitAllTx(props.builts, proxy)}
      onSubmitted={props.onSubmitted}
    />
  )
}

function Result(props: {
  built: BuiltUpgrade
  snapshot: Snapshot
  statuses: AccountStatus[]
  onSubmitted: () => void
}) {
  const { built } = props
  const { network } = built
  const { assetHub } = NETWORKS[network]
  const hub = `${network === "kusama" ? "Kusama " : ""}Asset Hub`
  const wallet = useWallet()
  const [copied, setCopied] = useState(false)
  const status = props.statuses.find((s) => s.address === wallet.selected?.address)
  // The same upgrade may already be on its way: Referenda are matched by the whitelisted hash.
  const existing = existingFor(built, props.snapshot.proposals)
  const names = built.runtimes.map((r) => CHAINS[r.chain].name)

  const { sent } = useContext(SentContext)
  const { actor } = useFellowship()
  const proxy = actor?.proxy ?? null
  const fellowshipBlocked = fellowshipBlock(
    existing,
    actor,
    props.snapshot,
    sent.has(built.proposal.hash),
  )
  const unread =
    props.snapshot.pending.includes(network) || props.snapshot.unreachable.includes(network)
  const publicBlocked = existing?.open
    ? `Already open as public referendum #${existing.open.index}.`
    : unread
      ? `Cannot tell whether this referendum is already open, because the referenda of ${
          NETWORKS[network].name
        } are not read yet. Try again shortly.`
      : status?.unread.includes(network)
        ? `Unable to read the balance of the selected account on ${hub}. Try again shortly.`
        : status && status.free[assetHub] < built.submissionDeposit
          ? `Needs ${formatBalance(built.submissionDeposit, network)} free on ${hub} for the ` +
            "submission deposit, and a little more for the preimage. The selected account has " +
            `${formatBalance(status.free[assetHub], network)}.`
          : null

  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <h4 className="font-semibold">
        Runtime upgrade of {names.length === 1 ? names[0] : `${names.length} chains`} to {built.tag}
      </h4>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Authorizes {names.length === 1 ? "a new runtime" : "new runtimes"} on {formatList(names)}.
        The {names.length === 1 ? "runtime was" : "runtimes were"} downloaded and hashed in this
        browser, and the calls below were checked against the live chains.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <SubmitStep
          title="Fellowship referendum"
          detail={
            network === "kusama"
              ? "On Collectives, for the Polkadot Fellowship to whitelist the upgrade on Kusama " +
                "over the bridge."
              : "On Collectives, for the Fellowship to whitelist the upgrade."
          }
          flowKey={`fellowship:${built.proposal.hash}`}
          flowTitle={`Fellowship referendum for the upgrade of ${NETWORKS[network].name} to ${built.tag}`}
          body="fellowship"
          network="polkadot"
          status={actor?.status}
          proxy={proxy}
          blocked={fellowshipBlocked}
          whitelists={[built.proposal.hash]}
          makeTx={() => fellowshipSubmitTx(built, proxy)}
          onSubmitted={props.onSubmitted}
        />
        <SubmitStep
          title="Public referendum"
          detail={
            `On ${hub}, on the Whitelisted Caller track. ` +
            "Notes the preimage if it is not on chain yet."
          }
          flowKey={`open:${network}:${built.proposal.hash}`}
          flowTitle={`Public referendum for the upgrade of ${NETWORKS[network].name} to ${built.tag}`}
          body="open"
          network={network}
          reserves={built.submissionDeposit}
          status={status}
          blocked={publicBlocked}
          makeTx={() => publicSubmitTx(built)}
          onSubmitted={props.onSubmitted}
        />
      </div>
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        The two referenda are independent: Different accounts can submit them, in either order.
        Whoever builds the same release and chains gets the same call, so you can submit one and
        send this link to someone who can submit the other.{" "}
        <button
          type="button"
          className="font-medium underline"
          onClick={() =>
            navigator.clipboard
              .writeText(shareLink(built))
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          Copy link
        </button>
        <span role="status">{copied && " Link copied."}</span>
      </p>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Once submitted, each referendum appears in the list below, where its decision deposit can be
        placed. The call is dispatched {ENACT_AFTER} blocks after the public referendum is approved,
        and each chain's upgrade then waits to be applied.
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
          What it does
        </summary>
        <div className="mt-2 overflow-x-auto">
          <CallTree call={built.tree} />
        </div>
        <dl className="mt-2 space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {built.runtimes.map((r) => (
            <div key={r.chain}>
              <dt className="inline">{CHAINS[r.chain].name} code hash </dt>
              <dd className="inline">
                <Short value={r.codeHash} />
              </dd>
            </div>
          ))}
          <div>
            <dt className="inline">Whitelisted call hash </dt>
            <dd className="inline">
              <Short value={built.proposal.hash} />
            </dd>
          </div>
        </dl>
      </details>
    </div>
  )
}

/** The chains of one network in a release: which to upgrade, and the referenda once built. */
function NetworkUpgrade(props: {
  network: Network
  loaded: Loaded
  /** Chains to select at first, from a shared link. The default is every chain that is behind. */
  preselect: ChainId[] | null
  /** Told whenever the built upgrade changes, with null when it is discarded. */
  onBuilt: (built: BuiltUpgrade | null) => void
  snapshot: Snapshot
  statuses: AccountStatus[]
  onSubmitted: () => void
}) {
  const { network, loaded } = props
  const plans = loaded.plans.filter((p) => CHAINS[p.chain].network === network)
  const [selected, setSelected] = useState<Set<ChainId>>(
    () =>
      new Set(
        plans
          .filter((p) => (props.preselect ? props.preselect.includes(p.chain) : upgradable(p)))
          .filter((p) => p.asset !== null)
          .map((p) => p.chain),
      ),
  )
  const [built, setBuiltHere] = useState<BuiltUpgrade | null>(null)
  const { onBuilt } = props
  const setBuilt = (next: BuiltUpgrade | null) => {
    setBuiltHere(next)
    onBuilt(next)
  }
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A build that finishes after the release was changed belongs to a section that is gone, and
  // must not be reported as built.
  // The flag is set again on every mount: In development, React mounts a component twice.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const build = async () => {
    setBuilt(null)
    setError(null)
    setBusy("Downloading runtimes…")
    try {
      const result = await buildUpgrade(
        await loadOpengov(),
        loaded.release,
        network,
        plans.filter((p) => selected.has(p.chain)),
        fetchAssetViaProxy,
        (done, total) => setBusy(`Downloading and hashing runtimes: ${done} of ${total}…`),
      )
      if (!mounted.current) return
      setBuilt(result)
    } catch (e) {
      setError(errorMessage(e))
    }
    setBusy(null)
  }

  const toggle = (chain: ChainId) => {
    const next = new Set(selected)
    if (!next.delete(chain)) next.add(chain)
    setSelected(next)
    setBuilt(null)
  }

  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="font-semibold">{NETWORKS[network].name}</h3>
      <ul className="mt-2 space-y-1">
        {plans.map((plan) => (
          <li key={plan.chain}>
            <label className="flex items-baseline gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(plan.chain)}
                disabled={!plan.asset || busy !== null}
                onChange={() => toggle(plan.chain)}
              />
              <span className="w-28 font-medium">{CHAINS[plan.chain].name}</span>
              <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
                {planNote(plan)}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={selected.size === 0 || busy !== null}
        className={`mt-3 ${choice(true)}`}
        onClick={() => void build()}
      >
        Build referenda for {selected.size === 1 ? "1 chain" : `${selected.size} chains`}
      </button>
      {busy && (
        <p role="status" className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {busy}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {built && (
        <Result
          built={built}
          snapshot={props.snapshot}
          statuses={props.statuses}
          onSubmitted={props.onSubmitted}
        />
      )}
    </section>
  )
}

async function readRelease(tag: string): Promise<Loaded> {
  const [opengov, release] = await Promise.all([loadOpengov(), fetchRelease(tag)])
  return { release, plans: await planRelease(opengov, release) }
}

/**
 * From a Fellowship runtimes release to the referenda that enact it, for each network. A link made
 * by the wizard reopens it on the same release, network, and chains.
 */
export function ReleaseWizard(props: {
  snapshot: Snapshot
  statuses: AccountStatus[]
  onSubmitted: () => void
}) {
  const [shared] = useState(sharedSelection)
  const [input, setInput] = useState(shared?.tag ?? "")
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [builts, setBuilts] = useState<Partial<Record<Network, BuiltUpgrade>>>({})
  // A shared link loads its release right away.
  const [busy, setBusy] = useState(shared !== null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set())
  // Adding hashes that are all there already changes nothing, so that telling twice is harmless.
  const markSent = useCallback(
    (hashes: string[]) =>
      setSent((all) => (hashes.every((h) => all.has(h)) ? all : new Set([...all, ...hashes]))),
    [],
  )

  const show = (reading: Promise<Loaded>) =>
    reading
      .then((next) => {
        setLoaded(next)
        setInput(next.release.tag)
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false))

  const load = (tag: string) => {
    setBusy(true)
    setError(null)
    setLoaded(null)
    setBuilts({})
    void show(readRelease(tag))
  }

  useEffect(() => {
    if (shared) void show(readRelease(shared.tag))
  }, [shared])

  const tag = parseTag(input)

  return (
    <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold">Propose a runtime upgrade</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Give a release of the Fellowship runtimes, and the referenda to enact it on Polkadot and on
        Kusama are built for you.
      </p>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (tag && !busy) load(tag)
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Release URL or tag</span>
          <input
            className={`${field} w-full`}
            placeholder="Release URL or tag, e.g., v2.6.0"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <button type="submit" disabled={!tag || busy} className={choice(true)}>
          Load release
        </button>
        <button
          type="button"
          disabled={busy}
          className={choice(false)}
          onClick={() => load("latest")}
        >
          Use latest
        </button>
      </form>
      {input !== "" && !tag && (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Enter a tag such as v2.6.0, or the URL of the release.
        </p>
      )}
      {busy && (
        <p role="status" className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          Reading the release and the live runtime versions…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      {loaded && (
        <SentContext.Provider value={{ sent, markSent }}>
          <div className="mt-4">
            <p className="text-sm">
              <a
                className="font-medium underline"
                href={loaded.release.url}
                target="_blank"
                rel="noreferrer"
              >
                Release {loaded.release.tag}
              </a>
              <span className="text-zinc-500 dark:text-zinc-400">
                {" "}
                · each network is upgraded by its own referenda; choose the chains
              </span>
            </p>
            <div className="mt-3 space-y-3">
              {NETWORK_IDS.map((network) => (
                <NetworkUpgrade
                  key={`${loaded.release.tag}-${network}`}
                  network={network}
                  loaded={loaded}
                  preselect={
                    shared?.tag === loaded.release.tag
                      ? shared.network === network
                        ? shared.chains
                        : []
                      : null
                  }
                  onBuilt={(built) =>
                    setBuilts((all) => ({ ...all, [network]: built ?? undefined }))
                  }
                  snapshot={props.snapshot}
                  statuses={props.statuses}
                  onSubmitted={props.onSubmitted}
                />
              ))}
              <AllFellowship
                builts={NETWORK_IDS.flatMap((n) => builts[n] ?? [])}
                snapshot={props.snapshot}
                statuses={props.statuses}
                onSubmitted={props.onSubmitted}
              />
            </div>
          </div>
        </SentContext.Provider>
      )}
    </section>
  )
}
