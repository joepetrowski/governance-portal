import { useEffect, useState } from "react"
import { CHAINS, type Network, NETWORKS } from "../chains"
import { decisionDeposits, type FollowUpChoice } from "../gov/followup"
import type { Stage } from "../gov/load"
import type { MemberProxy } from "../gov/proxy"
import type { AccountStatus } from "../gov/votes"
import { type Account } from "../wallet"
import { AccountName } from "./AccountName"
import { formatBalance, formatExact, parseBalance } from "./format"
import { flowActive, startFlow, useFlow } from "./flows"
import { FlowStatus } from "./FlowStatus"
import { choice, type Submittable } from "./tx"
import { ConvictionOptions } from "./VotePanel"
import { useLockDays } from "../useLockDays"

const field =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"

/** The track that the referenda opened from this page are submitted on, by body. */
const EXPECTED_TRACK = { fellowship: "fellows", open: "whitelisted caller" }

/**
 * The form that opens one or more referenda, with the choice to place the decision deposit and to
 * vote aye afterwards. Both are chosen by default.
 *
 * They take a second signature. The deposit and the vote name the referendum by its index, which
 * is known only when the submission is finalized. The page then reads the index from the events of
 * the submission, says what the second transaction does, and asks the wallet to sign it. That is
 * done by a flow, which goes on if this form leaves the page. See `startFlow`.
 *
 * While the flow is under way, the form gives way to its progress.
 */
export function OpenReferendum(props: {
  /** Names what is opened, the same in every control that can open it. See `Flow.key`. */
  flowKey: string
  /** What is opened, in words, for when the progress is shown away from this form. */
  title: string
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
  /** The account that signs both transactions. */
  account: Account
  /**
   * What is known of the account that pays the deposits, from which the form tells what it can
   * afford: the signing account, or the member that it acts for.
   */
  status: AccountStatus | undefined
  /**
   * The Fellowship member that the referenda are opened for by proxy, if not for the account
   * itself. `makeTx` must then build a submission by the same proxy.
   */
  proxy?: MemberProxy | null
  /** Builds the transaction that opens the referenda. */
  makeTx: () => Promise<Submittable>
  /** Runs when no more is to come: after the last transaction of the flow ends, well or not. */
  onDone: () => void
}) {
  const { body, network, account, status } = props
  const proxy = props.proxy ?? null
  const count = props.count ?? 1
  const { token } = NETWORKS[network]
  const chain = body === "fellowship" ? "collectives" : NETWORKS[network].assetHub
  const referenda = count === 1 ? "referendum" : "referenda"

  const [wantDeposit, setWantDeposit] = useState(true)
  const [wantAye, setWantAye] = useState(true)
  const [amount, setAmount] = useState("")
  const [conviction, setConviction] = useState(1)
  const lockDays = useLockDays(network)
  const flow = useFlow(props.flowKey)

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

  const unread = body === "open" && (status?.unread.includes(network) ?? true)
  const free = status && !unread ? status.free[chain] : null
  const needed = expected === null ? null : expected * BigInt(count) + (props.reserves ?? 0n)
  const canDeposit = free === null || needed === null || free >= needed
  const deposit = wantDeposit && canDeposit

  const parsed = parseBalance(amount, network)
  // Without a status the balance is not known, which is not the same as having none.
  const balance = status && !unread ? status.balance[network] : null
  const stakeProblem =
    body !== "open" || !wantAye
      ? null
      : amount === ""
        ? "Enter the amount to vote with, or clear the box."
        : parsed === null || parsed === 0n
          ? `Enter an amount in ${token}, with a period for decimals and no commas.`
          : balance === null
            ? "The balance of this account could not be read. Clear the box, or try again shortly."
            : parsed > balance
              ? `This account holds ${formatExact(balance, network)}.`
              : null
  const choices: FollowUpChoice = {
    deposit,
    aye: wantAye,
    stake: body === "open" && parsed ? { amount: parsed, conviction } : undefined,
  }

  if (flowActive(flow) && flow) return <FlowStatus flow={flow} />
  return (
    <div className="mt-3">
      <fieldset className="space-y-1 text-sm">
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
                {proxy ? "The member's account" : "The selected account"} has{" "}
                {formatBalance(free, network)} free on {CHAINS[chain].name}, which is not enough.
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
      {proxy && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Opened for <AccountName address={proxy.real} network="polkadot" />, by proxy. That account
          pays the deposits and casts the vote. The selected account signs and pays the fees.
          {!proxy.notesPreimage &&
            " This kind of proxy may not note a preimage. If the proposal needs one, the " +
              "selected account notes it and pays its deposit."}
        </p>
      )}
      <button
        type="button"
        disabled={stakeProblem !== null}
        className={`mt-3 ${choice(true)}`}
        onClick={() =>
          // The flow takes the choices as they are now, and does nothing if one is under way.
          startFlow({
            key: props.flowKey,
            title: props.title,
            body,
            network,
            account,
            proxy,
            makeTx: props.makeTx,
            choice: choices,
            onDone: props.onDone,
          })
        }
      >
        {props.label}
      </button>
      {/* An attempt that failed, above which the form is offered again. */}
      {flow && <FlowStatus flow={flow} />}
    </div>
  )
}
