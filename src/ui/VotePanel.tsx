import { useEffect, useState } from "react"
import type { Stage } from "../gov/load"
import {
  type AccountStatus,
  CONVICTIONS,
  type Direction,
  fellowshipVoteTx,
  loadLockDays,
  openVoteTx,
  stageKey,
} from "../gov/votes"
import { type Account, useWallet } from "../wallet"
import { formatDot, parseDot, shortAddress } from "./format"
import { choice, TxStatus, useSubmit } from "./tx"

const field =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"

function FellowshipVote(props: {
  stage: Stage
  account: Account
  status: AccountStatus
  onVoted: () => void
}) {
  const { stage, account, status } = props
  const { state, busy, submit } = useSubmit(props.onVoted)
  const minRank = stage.minRank ?? 0
  const mine = status.votes[stageKey(stage)]
  const current = mine?.type === "voted" ? mine.direction : null

  if (status.rank === null) return null
  if (status.rank < minRank)
    return (
      <p className="text-xs text-zinc-500">
        This track needs rank {minRank}. The selected account has rank {status.rank}.
      </p>
    )
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          Vote as rank {status.rank}:
        </span>
        <button
          type="button"
          disabled={busy}
          className={choice(current === "aye")}
          onClick={() => submit(fellowshipVoteTx(stage, true), account)}
        >
          Aye
        </button>
        <button
          type="button"
          disabled={busy}
          className={choice(current === "nay")}
          onClick={() => submit(fellowshipVoteTx(stage, false), account)}
        >
          Nay
        </button>
      </div>
      <TxStatus state={state} />
    </div>
  )
}

let lockDaysCache: Promise<number[]> | undefined

function OpenVote(props: {
  stage: Stage
  account: Account
  status: AccountStatus
  onVoted: () => void
}) {
  const { stage, account, status } = props
  const { state, busy, submit } = useSubmit(props.onVoted)
  // Nothing is selected until the user picks a direction, unless the account has already voted,
  // in which case its vote on chain is shown as the selection.
  const [chosen, setChosen] = useState<Direction | null>(null)
  const [amount, setAmount] = useState("")
  const [conviction, setConviction] = useState(1)
  const [lockDays, setLockDays] = useState<number[] | null>(null)

  useEffect(() => {
    lockDaysCache ??= loadLockDays()
    lockDaysCache.then(setLockDays).catch(() => (lockDaysCache = undefined))
  }, [])

  const mine = status.votes[stageKey(stage)]
  if (mine?.type === "delegating") return null
  const direction: Direction | null =
    chosen ?? (mine?.type === "voted" && mine.direction !== "split" ? mine.direction : null)

  const parsed = parseDot(amount)
  const problem =
    amount === ""
      ? null
      : parsed === null || parsed === 0n
        ? "Enter an amount in DOT."
        : parsed > status.balance
          ? `This account holds ${formatDot(status.balance)}.`
          : null
  const ready = direction !== null && parsed !== null && parsed > 0n && problem === null && !busy

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && direction)
          submit(openVoteTx(stage, { direction, amount: parsed, conviction }), account)
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {(["aye", "nay", "abstain"] as const).map((d) => (
          <button
            key={d}
            type="button"
            className={choice(direction === d)}
            onClick={() => setChosen(d)}
          >
            {d[0].toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-sm">
          <span className="sr-only">Amount in DOT</span>
          <input
            className={`${field} w-32`}
            inputMode="decimal"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />{" "}
          DOT
        </label>
        {direction !== "abstain" && (
          <label className="text-sm">
            <span className="sr-only">Conviction</span>
            <select
              className={field}
              value={conviction}
              onChange={(e) => setConviction(Number(e.target.value))}
            >
              {CONVICTIONS.map((label, i) => (
                <option key={label} value={i}>
                  {label}
                  {lockDays && (i === 0 ? ", no lock" : `, locked ${lockDays[i]} days`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" disabled={!ready} className={`${choice(true)} disabled:opacity-40`}>
          {mine?.type === "voted" ? "Change vote" : "Vote"}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {problem ?? `Balance ${formatDot(status.balance)}. A new vote replaces an earlier one.`}
      </p>
      <TxStatus state={state} />
    </form>
  )
}

/** How the wallet's accounts have voted on a stage, and the controls to vote. */
export function VotePanel(props: { stage: Stage; statuses: AccountStatus[]; onVoted: () => void }) {
  const { stage, statuses } = props
  const wallet = useWallet()
  if (!wallet.connected || statuses.length === 0) return null

  const nameOf = (address: string) =>
    wallet.accounts.find((a) => a.address === address)?.name ?? shortAddress(address)
  const cast = statuses
    .map((status) => ({ status, vote: status.votes[stageKey(stage)] }))
    .filter(({ vote }) => vote && vote.type !== "none")
  const selected = statuses.find((s) => s.address === wallet.selected?.address)

  return (
    <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      {cast.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {statuses.length === 1
            ? "Your account has not voted."
            : "None of your accounts have voted."}
        </p>
      ) : (
        <ul className="space-y-0.5 text-sm">
          {cast.map(({ status, vote }) => (
            <li key={status.address}>
              <span className="font-medium">{nameOf(status.address)}:</span>{" "}
              {vote.type === "voted" && vote.detail}
              {vote.type === "delegating" &&
                `Delegated to ${shortAddress(vote.target)} on this track`}
            </li>
          ))}
        </ul>
      )}
      {wallet.selected && selected && (
        <div className="mt-3">
          {stage.body === "fellowship" ? (
            <FellowshipVote
              stage={stage}
              account={wallet.selected}
              status={selected}
              onVoted={props.onVoted}
            />
          ) : (
            <OpenVote
              stage={stage}
              account={wallet.selected}
              status={selected}
              onVoted={props.onVoted}
            />
          )}
        </div>
      )}
    </div>
  )
}
