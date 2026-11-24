// Opening a referendum, and the deposit and vote that follow it, as one flow that outlives the
// control it was started from. The page replaces that control while the flow runs: The list of
// proposals is read again every minute, and a card changes once its referendum is open. A flow
// kept in the control would then ask for the second signature with nothing on the page to say
// what is being signed. So the flows are kept here, and shown wherever there is room for them.

import { useEffect, useSyncExternalStore } from "react"
import type { Network } from "../chains"
import {
  decisionDeposits,
  followUp,
  type FollowUpChoice,
  followUpTx,
  type Opened,
  openedBy,
} from "../gov/followup"
import type { Stage } from "../gov/load"
import type { MemberProxy } from "../gov/proxy"
import { errorMessage } from "../util"
import type { Account } from "../wallet"
import { type Submittable, type TxState, watchTx } from "./tx"

/** One submission of referenda and what follows it. */
export interface Flow {
  /** What is being opened, the same for every control that can open it. */
  key: string
  /** What is being opened, in words, for when the control that started it is gone. */
  title: string
  /** Whether the submission is being built. */
  building: boolean
  /** The submission. */
  first: TxState
  /** The transaction that places the deposit and votes. Idle if there is none. */
  second: TxState
  /** What the second transaction does, once that is known. */
  next: string | null
  /** What went wrong outside of the two transactions, if anything. */
  error: string | null
  /** The referenda that the submission opened, once it is finalized. */
  opened: Opened[]
  /** Whether the second transaction places the decision deposit. */
  deposit: boolean
  /** Whether nothing more is to come. */
  over: boolean
  /** Which attempt at this key the flow is, so that an earlier one cannot write over it. */
  attempt: number
}

let flows: Flow[] = []
// How many controls on the page show the flow of each key.
const shown = new Map<string, number>()
let dismissed: string[] = []
let attempts = 0
let version = 0
const listeners = new Set<() => void>()
const changed = () => {
  version += 1
  listeners.forEach((listener) => listener())
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const WAITING = new Set<TxState["step"]>(["signing", "broadcast", "included"])

/**
 * Whether a flow is under way or has gone through, so that what it opens must not be offered
 * again. False for one whose submission failed, which may be tried again.
 */
export const flowActive = (flow: Flow | undefined): boolean =>
  !!flow && (flow.building || (flow.first.step !== "idle" && flow.first.step !== "failed"))

/** Whether the submission of a flow is in a block, so that its referenda exist. */
export const flowSubmitted = (flow: Flow | undefined): boolean =>
  flow?.first.step === "included" || flow?.first.step === "finalized"

/**
 * Open referenda and then do what was chosen on them. Does nothing if a flow of the same key is
 * under way or has gone through.
 *
 * The submission is built, signed, and followed to finality. The referenda that it opened are then
 * read from its own events, and the deposit and the vote are made on those, in a second
 * transaction that the account is asked to sign. `onDone` runs when no more is to come.
 *
 * `makeTx` builds the submission, by proxy if it is to be. `proxy` says for whom the second
 * transaction is made.
 */
export function startFlow(opts: {
  key: string
  title: string
  /** Whose referenda the submission opens, and on which network's chain. */
  body: Stage["body"]
  network: Network
  account: Account
  /** The member that the deposit and the vote are made for, if not for the account itself. */
  proxy?: MemberProxy | null
  makeTx: () => Promise<Submittable>
  choice: FollowUpChoice
  onDone: () => void
}): void {
  const { key, body, network, account, choice } = opts
  const proxy = opts.proxy ?? null
  if (flowActive(flows.find((flow) => flow.key === key))) return
  const fresh: Flow = {
    key,
    title: opts.title,
    building: true,
    first: { step: "idle" },
    second: { step: "idle" },
    next: null,
    error: null,
    opened: [],
    deposit: false,
    over: false,
    attempt: ++attempts,
  }
  // A transaction of an attempt that failed can still report, and must not touch this one.
  const update = (change: Partial<Flow>) => {
    flows = flows.map((flow) =>
      flow.key === key && flow.attempt === fresh.attempt ? { ...flow, ...change } : flow,
    )
    changed()
  }
  flows = [...flows.filter((flow) => flow.key !== key), fresh]
  dismissed = dismissed.filter((k) => k !== key)
  changed()

  let finished = false
  const finish = (error?: string) => {
    if (finished) return
    finished = true
    update(error === undefined ? { over: true } : { over: true, error })
    opts.onDone()
  }

  const afterFirst = async (events: unknown[]) => {
    const opened = openedBy(events, body, network)
    update({ opened })
    if (!choice.deposit && !choice.aye) return finish()
    if (opened.length === 0)
      return finish(
        "The submission is finalized, but its events name no referendum, so the deposit and " +
          "the vote were not made. They can be made from the referendum's card in the list.",
      )
    const tracks = await decisionDeposits(body, network)
    const plan = followUp(opened, choice, new Map(tracks.map((t) => [t.id, t.deposit])), proxy)
    if (!plan) return finish()
    // What the transaction does is on the page before the wallet is asked to sign it.
    update({ next: plan.description, deposit: choice.deposit, second: { step: "signing" } })
    watchTx(
      followUpTx(plan.calls, proxy).createSubmitAndWatch(account.txCreator),
      (second) => {
        update({ second })
        if (second.step === "failed") finish()
      },
      () => finish(),
    )
  }

  opts.makeTx().then(
    (tx) => {
      update({ building: false, first: { step: "signing" } })
      watchTx(
        tx.createSubmitAndWatch(account.txCreator),
        (first) => update({ first }),
        (events) => void afterFirst(events).catch((e) => finish(errorMessage(e))),
      )
    },
    (e) => update({ building: false, error: errorMessage(e), over: true }),
  )
}

/** Take a flow that is over off the page. */
export function dismissFlow(key: string): void {
  dismissed = [...dismissed, key]
  changed()
}

/** The flow of a key as it is now, for use outside of a component. */
export const getFlow = (key: string): Flow | undefined => flows.find((flow) => flow.key === key)

const useVersion = () => useSyncExternalStore(subscribe, () => version)

/**
 * The flow of a key, if one was started. The control that calls this shows the flow, so the flow
 * is not listed with those that have lost their control. An empty key names no flow.
 */
export function useFlow(key: string): Flow | undefined {
  useVersion()
  useEffect(() => {
    if (key === "") return
    shown.set(key, (shown.get(key) ?? 0) + 1)
    changed()
    return () => {
      shown.set(key, (shown.get(key) ?? 1) - 1)
      changed()
    }
  }, [key])
  return flows.find((flow) => flow.key === key)
}

/** The flows that no control on the page shows, and that were not dismissed. */
export function useOrphanFlows(): Flow[] {
  useVersion()
  return flows.filter((flow) => !(shown.get(flow.key) ?? 0) && !dismissed.includes(flow.key))
}

/**
 * Whether a flow is placing the decision deposit of a referendum right now, so that the deposit
 * should not be offered beside it.
 */
export function useDepositPending(stage: Pick<Stage, "body" | "network" | "index">): boolean {
  useVersion()
  return flows.some(
    (flow) =>
      flow.deposit &&
      WAITING.has(flow.second.step) &&
      flow.opened.some(
        (o) => o.body === stage.body && o.network === stage.network && o.index === stage.index,
      ),
  )
}
