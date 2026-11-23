import type { ReactNode } from "react"
import type { Outcome, Stage } from "../gov/load"
import { duration, formatBalance, percent } from "./format"
import { AccountName } from "./AccountName"

const OUTCOME_LABELS: Record<Outcome, string> = {
  approved: "Passed",
  rejected: "Rejected",
  canceled: "Canceled",
  timedOut: "Timed out",
  killed: "Killed",
}

function statusLine(stage: Stage): { label: string; detail: string } {
  const { status, now, blockMs } = stage
  const until = (block: number) => duration(block - now, blockMs)
  switch (status.phase) {
    case "ended":
      return {
        label: OUTCOME_LABELS[status.outcome],
        detail: `${duration(now - status.at, blockMs)} ago`,
      }
    case "awaitingDeposit":
      return {
        label: "Waiting for decision deposit",
        detail: "Voting is open, but it cannot be decided yet",
      }
    case "preparing":
      return { label: "Preparing", detail: `Decision can start in ${until(status.endsAt)}` }
    case "queued":
      return { label: "Queued", detail: "Waiting for a free slot on its track" }
    case "confirming":
      return {
        label: "Confirming",
        detail: `Passes in ${until(status.endsAt)} if it stays above both thresholds`,
      }
    case "deciding": {
      const left = `${until(status.endsAt)} left to decide`
      if (stage.passing) return { label: "Deciding", detail: `Passing · ${left}` }
      if (status.passesAt === null)
        return { label: "Deciding", detail: `Will not pass with the current votes · ${left}` }
      return {
        label: "Deciding",
        detail: `Thresholds fall to the current votes in ${until(status.passesAt)} · ${left}`,
      }
    }
  }
}

/**
 * `past` is set for a referendum that has ended, whose threshold is then no longer in force. The
 * bar is green only when the threshold is met, so a rejected referendum does not look passed.
 */
function Meter(props: { label: string; current: number | null; required: number; past?: boolean }) {
  const { label, current, required } = props
  const needs = props.past ? "needed" : "needs"
  const met = current !== null && current >= required
  const shown = current === null ? "no votes" : percent(current)
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
        <span className="tabular-nums">
          <span
            className={met ? "font-medium text-emerald-700 dark:text-emerald-400" : "font-medium"}
          >
            {shown}
          </span>
          <span className="text-zinc-500 dark:text-zinc-400">
            {" "}
            · {needs} {percent(required)}
          </span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(1, current ?? 0) * 100)}
        aria-valuetext={`${shown}, ${needs} ${percent(required)}`}
        className="relative mt-1 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <div
          className={`h-2 rounded-full ${met ? "bg-emerald-500" : "bg-amber-500"}`}
          style={{ width: `${Math.min(100, (current ?? 0) * 100)}%` }}
        />
        <div
          className="absolute -top-1 h-4 w-0.5 bg-zinc-900 dark:bg-zinc-100"
          style={{ left: `${Math.min(100, required * 100)}%` }}
          title={`Required: ${percent(required)}`}
        />
      </div>
    </div>
  )
}

function TimeBar({ stage }: { stage: Stage }) {
  const { status, now } = stage
  if (status.phase !== "deciding" && status.phase !== "confirming") return null
  const elapsed = Math.min(1, Math.max(0, (now - status.since) / (status.endsAt - status.since)))
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">
          {status.phase === "confirming" ? "Confirmation period" : "Decision period"}
        </span>
        <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
          {percent(elapsed)} elapsed
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={status.phase === "confirming" ? "Confirmation period" : "Decision period"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(elapsed * 100)}
        aria-valuetext={`${percent(elapsed)} elapsed`}
        className="mt-1 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <div className="h-2 rounded-full bg-zinc-500" style={{ width: `${elapsed * 100}%` }} />
      </div>
    </div>
  )
}

/** Whether the decision deposit is placed. `action` is the control to place it, when missing. */
function DepositRow({ stage, action }: { stage: Stage; action?: ReactNode }) {
  const { required, placed } = stage.deposit
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-zinc-600 dark:text-zinc-400">Decision deposit</span>
      {placed ? (
        <span>
          {formatBalance(placed.amount, stage.network)} placed by{" "}
          <AccountName address={placed.who} network={stage.network} />
        </span>
      ) : (
        <span className="flex flex-wrap items-center justify-end gap-2">
          <span className="font-medium text-amber-700 dark:text-amber-400">
            {formatBalance(required, stage.network)} not placed
          </span>
          {action}
        </span>
      )}
    </div>
  )
}

/** The label of a status. Green marks one that is passing or has passed. */
function Badge(props: { green: boolean; children: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        props.green
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      }`}
    >
      {props.children}
    </span>
  )
}

/**
 * One referendum: status, approval and support against their thresholds, time elapsed, and decision
 * deposit. `children` go below, which is where the vote controls are placed. A referendum that has
 * ended shows its final tally, and no deposit. `statusNote` is added to the status line.
 */
export function StagePanel(props: {
  stage: Stage
  statusNote?: string
  depositAction?: ReactNode
  children?: ReactNode
}) {
  const { stage, children } = props
  const status = statusLine(stage)
  const label = status.label
  const detail = props.statusNote ? `${status.detail} · ${props.statusNote}` : status.detail
  const ended = stage.status.phase === "ended"
  const passed = stage.status.phase === "ended" && stage.status.outcome === "approved"
  const heading = stage.body === "fellowship" ? "Fellowship referendum" : "Public referendum"
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="font-medium">
          {heading} <span className="text-zinc-500 dark:text-zinc-400">#{stage.index}</span>
        </h3>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{stage.track} track</span>
      </header>
      <p className="mt-2 text-sm">
        <span className="mr-2">
          <Badge green={ended ? passed : stage.passing || stage.status.phase === "confirming"}>
            {label}
          </Badge>
        </span>
        {detail}
      </p>
      <div className="mt-4 space-y-3">
        <Meter label="Approval" {...stage.approval} past={ended} />
        <Meter label="Support" {...stage.support} past={ended} />
        <TimeBar stage={stage} />
      </div>
      {!ended && <DepositRow stage={stage} action={props.depositAction} />}
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        {ended && "Final tally: "}Aye {stage.ayes} · Nay {stage.nays} · submitted by{" "}
        <AccountName address={stage.submitter} network={stage.network} />
      </p>
      {children}
    </section>
  )
}

/**
 * Shown in place of a stage that has no active referendum. `badge` is a green label beside the
 * title, and `action` goes below the text.
 */
export function StageNote(props: {
  title: string
  badge?: string
  children: string
  action?: ReactNode
}) {
  return (
    <section className="rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <header className="flex flex-wrap items-center justify-between gap-x-3">
        <h3 className="font-medium">{props.title}</h3>
        {props.badge && <Badge green>{props.badge}</Badge>}
      </header>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{props.children}</p>
      {props.action}
    </section>
  )
}
