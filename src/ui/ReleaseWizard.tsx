import init, * as lib from "opengov"
import wasmUrl from "opengov/opengov_bg.wasm?url"
import { useState } from "react"
import { CHAINS, type ChainId } from "../chains"
import type { Proposal } from "../gov/load"
import {
  type BuiltUpgrade,
  buildUpgrade,
  type ChainPlan,
  FELLOWSHIP_SUBMIT_RANK,
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
import { formatList, shortHex } from "./format"
import { choice, type Submittable, TxStatus, useSubmit } from "./tx"

// The library's WebAssembly is fetched the first time a release is loaded.
let libReady: Promise<typeof lib> | undefined
const loadLib = () => (libReady ??= init({ module_or_path: wasmUrl }).then(() => lib))

const field =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

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

/** One of the two transactions, with its submit button and what stands in the way of it. */
function SubmitStep(props: {
  title: string
  detail: string
  /** Why it should not be submitted, if anything. */
  blocked: string | null
  makeTx: () => Promise<Submittable>
  onSubmitted: () => void
}) {
  const wallet = useWallet()
  const { state, busy, submit } = useSubmit(props.onSubmitted)
  const [error, setError] = useState<string | null>(null)
  const account = wallet.selected
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h4 className="font-medium">{props.title}</h4>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{props.detail}</p>
      {props.blocked ? (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">{props.blocked}</p>
      ) : !account ? (
        <p className="mt-3 text-sm text-zinc-500">Connect a wallet to submit.</p>
      ) : (
        <button
          type="button"
          disabled={busy}
          className={`mt-3 ${choice(true)}`}
          onClick={() => {
            setError(null)
            props
              .makeTx()
              .then((tx) => submit(tx, account))
              .catch((e) => setError(message(e)))
          }}
        >
          Submit
        </button>
      )}
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
      <TxStatus state={state} />
    </section>
  )
}

function Result(props: {
  built: BuiltUpgrade
  proposals: Proposal[]
  statuses: AccountStatus[]
  onSubmitted: () => void
}) {
  const { built } = props
  const wallet = useWallet()
  const status = props.statuses.find((s) => s.address === wallet.selected?.address)
  // The same upgrade may already be on its way: referenda are matched by the whitelisted hash.
  const existing = props.proposals.find((p) => p.whitelist?.hash === built.proposal.hash)
  const names = built.runtimes.map((r) => CHAINS[r.chain].name)

  const fellowshipBlocked = existing?.fellowship
    ? `Already open as Fellowship referendum #${existing.fellowship.index}.`
    : existing?.whitelist?.whitelisted
      ? "The Fellowship has already whitelisted this call."
      : status && (status.rank ?? -1) < FELLOWSHIP_SUBMIT_RANK
        ? `Needs a Fellowship member of rank ${FELLOWSHIP_SUBMIT_RANK} or higher. The selected account ${
            status.rank === null ? "is not a member" : `has rank ${status.rank}`
          }.`
        : null
  const publicBlocked = existing?.open ? `Already open as public referendum #${existing.open.index}.` : null

  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <h3 className="font-semibold">
        Runtime upgrade of {names.length === 1 ? names[0] : `${names.length} chains`} to {built.tag}
      </h3>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Authorizes {names.length === 1 ? "a new runtime" : "new runtimes"} on {formatList(names)}.
        The {names.length === 1 ? "runtime was" : "runtimes were"} downloaded and hashed in this
        browser, and the calls below were checked against the live chains.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <SubmitStep
          title="1. Fellowship referendum"
          detail="On Collectives, for the Fellowship to whitelist the upgrade."
          blocked={fellowshipBlocked}
          makeTx={() => fellowshipSubmitTx(built)}
          onSubmitted={props.onSubmitted}
        />
        <SubmitStep
          title="2. Public referendum"
          detail="On Asset Hub, on the Whitelisted Caller track. Notes the preimage if it is not on chain yet."
          blocked={publicBlocked}
          makeTx={() => publicSubmitTx(built)}
          onSubmitted={props.onSubmitted}
        />
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Once submitted, each referendum appears in the list below, where its decision deposit can be
        placed. The upgrade enacts 10 blocks after the public referendum is approved.
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
          What it does
        </summary>
        <div className="mt-2 overflow-x-auto">
          <CallTree call={built.tree} />
        </div>
        <dl className="mt-2 space-y-0.5 text-xs text-zinc-500">
          {built.runtimes.map((r) => (
            <div key={r.chain}>
              <dt className="inline">{CHAINS[r.chain].name} code hash </dt>
              <dd className="inline font-mono" title={r.codeHash}>
                {shortHex(r.codeHash)}
              </dd>
            </div>
          ))}
          <div>
            <dt className="inline">Whitelisted call hash </dt>
            <dd className="inline font-mono" title={built.proposal.hash}>
              {shortHex(built.proposal.hash)}
            </dd>
          </div>
        </dl>
      </details>
    </div>
  )
}

/** From a Fellowship runtimes release to the referenda that enact it. */
export function ReleaseWizard(props: { proposals: Proposal[]; statuses: AccountStatus[]; onSubmitted: () => void }) {
  const [input, setInput] = useState("")
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [selected, setSelected] = useState<Set<ChainId>>(new Set())
  const [built, setBuilt] = useState<BuiltUpgrade | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(message(e))
    }
    setBusy(null)
  }

  const load = (tag: string) =>
    run("Reading the release and the live runtime versions…", async () => {
      setLoaded(null)
      setBuilt(null)
      const [opengov, release] = await Promise.all([loadLib(), fetchRelease(tag)])
      const plans = await planRelease(opengov, release)
      setLoaded({ release, plans })
      setSelected(new Set(plans.filter(upgradable).map((p) => p.chain)))
      setInput(release.tag)
    })

  const build = (current: Loaded) =>
    run("Downloading runtimes…", async () => {
      setBuilt(null)
      const plans = current.plans.filter((p) => selected.has(p.chain))
      const result = await buildUpgrade(await loadLib(), current.release, plans, fetchAssetViaProxy, (done, total) =>
        setBusy(`Downloading and hashing runtimes: ${done} of ${total}…`),
      )
      setBuilt(result)
    })

  const tag = parseTag(input)
  const toggle = (chain: ChainId) => {
    const next = new Set(selected)
    if (!next.delete(chain)) next.add(chain)
    setSelected(next)
    setBuilt(null)
  }

  return (
    <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold">Propose a runtime upgrade</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Give a release of the Fellowship runtimes, and the referenda to enact it are built for you.
      </p>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (tag && !busy) void load(tag)
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
        <button type="submit" disabled={!tag || busy !== null} className={choice(true)}>
          Load release
        </button>
        <button type="button" disabled={busy !== null} className={choice(false)} onClick={() => void load("latest")}>
          Use latest
        </button>
      </form>
      {input !== "" && !tag && (
        <p className="mt-1 text-xs text-zinc-500">Enter a tag such as v2.6.0, or the URL of the release.</p>
      )}

      {loaded && (
        <div className="mt-4">
          <p className="text-sm">
            <a className="font-medium underline" href={loaded.release.url} target="_blank" rel="noreferrer">
              Release {loaded.release.tag}
            </a>
            <span className="text-zinc-500"> · choose the chains to upgrade</span>
          </p>
          <ul className="mt-2 space-y-1">
            {loaded.plans.map((plan) => (
              <li key={plan.chain}>
                <label className="flex items-baseline gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(plan.chain)}
                    disabled={!plan.asset || busy !== null}
                    onChange={() => toggle(plan.chain)}
                  />
                  <span className="w-28 font-medium">{CHAINS[plan.chain].name}</span>
                  <span className="tabular-nums text-zinc-500">{planNote(plan)}</span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={selected.size === 0 || busy !== null}
            className={`mt-3 ${choice(true)}`}
            onClick={() => void build(loaded)}
          >
            Build referenda for {selected.size === 1 ? "1 chain" : `${selected.size} chains`}
          </button>
        </div>
      )}

      {busy && <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{busy}</p>}
      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
      {built && (
        <Result built={built} proposals={props.proposals} statuses={props.statuses} onSubmitted={props.onSubmitted} />
      )}
    </section>
  )
}
