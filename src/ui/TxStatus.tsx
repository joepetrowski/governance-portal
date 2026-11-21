import type { TxState } from "./tx"

const TX_LABEL: Record<Exclude<TxState["step"], "idle" | "failed">, string> = {
  signing: "Waiting for your wallet to sign…",
  broadcast: "Submitted. Waiting for a block…",
  included: "In a block. Waiting for finality…",
  finalized: "Finalized.",
}

/**
 * The progress or failure of a transaction, as a line of text. Empty before the first submission.
 */
export function TxStatus({ state }: { state: TxState }) {
  if (state.step === "idle") return null
  if (state.step === "failed")
    return (
      <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
        {state.reason}
      </p>
    )
  return (
    <p role="status" className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
      {TX_LABEL[state.step]}
    </p>
  )
}
