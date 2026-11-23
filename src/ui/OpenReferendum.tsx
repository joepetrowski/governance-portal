import { useEffect, useState } from "react"
import { CHAINS, type Network, NETWORKS } from "../chains"
import {
  decisionDeposits,
  followUp,
  type FollowUpChoice,
  followUpTx,
  openedBy,
} from "../gov/followup"
import type { Stage } from "../gov/load"
import type { AccountStatus } from "../gov/votes"
import { errorMessage } from "../util"
import { type Account } from "../wallet"
import { formatBalance, formatExact, parseBalance } from "./format"
import { choice, type Submittable, useSubmit } from "./tx"
import { TxStatus } from "./TxStatus"
import { ConvictionOptions } from "./VotePanel"
import { useLockDays } from "../useLockDays"

const field =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"

/** The track that the referenda opened from this page are submitted on, by body. */
const EXPECTED_TRACK = { fellowship: "fellows", open: "whitelisted caller" }

/**
 * The button that opens one or more referenda, with the choice to place the decision deposit and
 * to vote aye afterwards. Both are chosen by default.
 *
 * They take a second signature. The deposit and the vote name the referendum by its index, which
 * is known only when the submission is finalized. The page then reads the index from the events of
 * the submission, says what the second transaction does, and asks the wallet to sign it.
 *
 * `onDone` runs when no more is to come: after the second transaction is finalized or fails, or
 * after the submission if nothing was chosen. `onIncluded` runs when the submission is in a block.
 */
export function OpenReferendum(props: {
  /** Whose referenda the transaction opens. */
  body: Stage["body"]
  /** The network whose chain hosts them. Fellowship referenda are on Polkadot. */
  network: Network
  /** The text of the button. */
  label: string
  /** How many referenda the transaction opens. One if left out. */
  count?: number
  /** What the submission itself reserves from the account, besides fees. */
  reserves?: bigint
  account: Account
  status: AccountStatus | undefined
  makeTx: () => Promise<Submittable>
  onIncluded?: () => void
  onDone: () => void
}) {
  const { body, network, account, status } = props
  const count = props.count ?? 1
  const { token } = NETWORKS[network]
  const chain = body === "fellowship" ? "collectives" : NETWORKS[network].assetHub
  const referenda = count === 1 ? "referendum" : "referenda"

  const [wantDeposit, setWantDeposit] = useState(true)
  const [wantAye, setWantAye] = useState(true)
  const [amount, setAmount] = useState("")
  const [conviction, setConviction] = useState(1)
  const lockDays = useLockDays(network)
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What the second transaction does, as soon as that is known.
  const [next, setNext] = useState<string | null>(null)

  // The decision deposit of the track that these referenda are expected on. It only decides
  // whether the deposit is offered. What is placed is the deposit of the track that the chain
  // reports.
  const [expected, setExpected] = useState<bigint | null>(null)
  useEffect(() => {
    let canceled = false
    decisionDeposits(body, network).then(
      (tracks) => {
        const track = tracks.find((t) => t.name === EXPECTED_TRACK[body])
        if (!canceled) setExpected(track?.deposit ?? null)
      },
      () => {},
    )
    return () => {
      canceled = true
    }
  }, [body, network])

  const second = useSubmit(props.onDone)
  const first = useSubmit((events) => {
    // These are the choices as they were when the submission was signed.
    after(events).catch((e) => {
      setError(errorMessage(e))
      props.onDone()
    })
  })
  const submitted = first.state.step === "included" || first.state.step === "finalized"
  const { onIncluded } = props
  useEffect(() => {
    if (submitted) onIncluded?.()
  }, [submitted, onIncluded])

  const unread = body === "open" && (status?.unread.includes(network) ?? true)
  const free = status && !unread ? status.free[chain] : null
  const needed = expected === null ? null : expected * BigInt(count) + (props.reserves ?? 0n)
  const canDeposit = free === null || needed === null || free >= needed
  const deposit = wantDeposit && canDeposit

  const parsed = parseBalance(amount, network)
  const balance = status?.balance[network] ?? 0n
  const stakeProblem =
    body !== "open" || !wantAye
      ? null
      : amount === ""
        ? "Enter the amount to vote with, or clear the box."
        : parsed === null || parsed === 0n
          ? `Enter an amount in ${token}, with a period for decimals and no commas.`
          : parsed > balance
            ? `This account holds ${formatExact(balance, network)}.`
            : null
  const picked: FollowUpChoice = {
    deposit,
    aye: wantAye,
    stake: body === "open" && parsed ? { amount: parsed, conviction } : undefined,
  }

  async function after(events: unknown[]) {
    const opened = openedBy(events, body, network)
    const tracks = await decisionDeposits(body, network)
    const plan = followUp(opened, picked, new Map(tracks.map((t) => [t.id, t.deposit])))
    if (!plan) return props.onDone()
    setNext(plan.description)
    second.submit(followUpTx(plan.calls), account)
  }

  // The referenda are open whether or not the second transaction went through, so the page is
  // told to read them when it fails as well.
  const secondFailed = second.state.step === "failed"
  const { onDone } = props
  useEffect(() => {
    if (secondFailed) onDone()
  }, [secondFailed, onDone])

  const busy = first.busy || second.busy || making
  return (
    <div className="mt-3">
      {!submitted && (
        <fieldset disabled={busy} className="space-y-1 text-sm">
          <legend className="sr-only">
            After the {referenda} {count === 1 ? "is" : "are"} open
          </legend>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={deposit}
              disabled={!canDeposit}
              onChange={(e) => setWantDeposit(e.target.checked)}
            />
            <span>
              Place the decision deposit
              {expected !== null &&
                ` of ${formatBalance(expected * BigInt(count), network)}` +
                  (count > 1 ? ` (${formatBalance(expected, network)} each)` : "")}
              {!canDeposit && free !== null && (
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  The selected account has {formatBalance(free, network)} free on{" "}
                  {CHAINS[chain].name}, which is not enough.
                </span>
              )}
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={wantAye}
              onChange={(e) => setWantAye(e.target.checked)}
            />
            <span>Vote aye</span>
          </label>
          {body === "open" && wantAye && (
            <div className="ml-6 flex flex-wrap items-center gap-2">
              <label>
                <span className="sr-only">Amount in {token}</span>
                <input
                  className={`${field} w-28`}
                  inputMode="decimal"
                  placeholder="Amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />{" "}
                {token}
              </label>
              <label>
                <span className="sr-only">Conviction</span>
                <select
                  className={field}
                  value={conviction}
                  onChange={(e) => setConviction(Number(e.target.value))}
                >
                  <ConvictionOptions lockDays={lockDays} />
                </select>
              </label>
            </div>
          )}
          {(deposit || wantAye) && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {stakeProblem ??
                `Your wallet asks for a second signature once the ${referenda} ${
                  count === 1 ? "is" : "are"
                } finalized, since ${count === 1 ? "its number is" : "their numbers are"} not known before.`}
            </p>
          )}
        </fieldset>
      )}
      {!submitted && (
        <button
          type="button"
          disabled={busy || stakeProblem !== null}
          className={`mt-3 ${choice(true)}`}
          onClick={() => {
            setError(null)
            setMaking(true)
            props
              .makeTx()
              .then((tx) => first.submit(tx, account))
              .catch((e) => setError(errorMessage(e)))
              .finally(() => setMaking(false))
          }}
        >
          {props.label}
        </button>
      )}
      {making && (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Building the transaction…</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <TxStatus state={first.state} />
      {next && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">Second transaction: {next}</p>
      )}
      <TxStatus state={second.state} />
      {secondFailed && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          The {referenda} {count === 1 ? "is" : "are"} open. The deposit and the vote can also be
          made from {count === 1 ? "its card" : "their cards"} in the list.
        </p>
      )}
    </div>
  )
}
