// Signing and following a transaction, shared by every action on the page.

import { useState } from "react"
import { holdClients } from "../chains"
import type { Account } from "../wallet"
import { errorMessage } from "../util"

/** Where a transaction is on its way to finality. */
export type TxState =
  | { step: "idle" }
  | { step: "signing" }
  | { step: "broadcast" }
  | { step: "included" }
  | { step: "finalized" }
  | { step: "failed"; reason: string }

/** Flatten a dispatch error such as Module(ConvictionVoting(InsufficientFunds)) to its names. */
function dispatchErrorName(error: unknown): string {
  const names: string[] = []
  let current = error
  while (typeof current === "object" && current !== null && "type" in current) {
    names.push(String((current as { type: unknown }).type))
    current = (current as { value?: unknown }).value
  }
  return names.filter((n) => n !== "Module").join(".") || "unknown error"
}

/** The events of a transaction on its way into a block, as `polkadot-api` reports them. */
export interface TxEvents {
  /** Listen to the events. An error means the transaction was not signed or not accepted. */
  subscribe: (observer: {
    next: (event: {
      type: string
      ok?: boolean
      dispatchError?: unknown
      events?: unknown[]
    }) => void
    error: (e: unknown) => void
  }) => unknown
}

/**
 * The part of a `polkadot-api` transaction that submitting needs, so that transactions of any chain
 * fit.
 */
export interface Submittable {
  /** Sign with the account's signer, submit, and report each step up to finality. */
  createSubmitAndWatch: (creator: Account["txCreator"]) => TxEvents
}

/**
 * State and triggers for one transaction. `submit` signs with the account and follows the
 * transaction to finality. `follow` does the same for one that is already submitted, such as an
 * unsigned one. `onFinalized` runs once it is finalized, which is when
 * chain state read by this page shows its effect. It is given the events that the transaction
 * emitted.
 */
export function useSubmit(onFinalized: (events: unknown[]) => void) {
  const [state, setState] = useState<TxState>({ step: "idle" })
  const busy = state.step === "signing" || state.step === "broadcast" || state.step === "included"

  const follow = (events: TxEvents) => {
    setState((current) => (current.step === "signing" ? current : { step: "broadcast" }))
    // The events end by themselves, at finality or with an error. Until then the connections
    // stay open, also in a tab that is in the background.
    const release = holdClients()
    events.subscribe({
      next: (event) => {
        if (event.type === "broadcasted") setState({ step: "broadcast" })
        if (event.type !== "inBestBlock" && event.type !== "finalized") return
        if (event.type === "finalized") release()
        if (event.ok === false) {
          setState({
            step: "failed",
            reason: `Rejected by the chain: ${dispatchErrorName(event.dispatchError)}`,
          })
          return
        }
        setState({ step: event.type === "finalized" ? "finalized" : "included" })
        if (event.type === "finalized") onFinalized(event.events ?? [])
      },
      error: (e) => {
        release()
        setState({ step: "failed", reason: errorMessage(e) })
      },
    })
  }
  const submit = (tx: Submittable, account: Account) => {
    setState({ step: "signing" })
    follow(tx.createSubmitAndWatch(account.txCreator))
  }
  return { state, busy, submit, follow }
}

/** Class names of a button that is one of a set of choices, filled when it is the active one. */
export const choice = (active: boolean) =>
  `rounded-md border px-3 py-1 text-sm font-medium disabled:opacity-50 ${
    active
      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
      : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
  }`
