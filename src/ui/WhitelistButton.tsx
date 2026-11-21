import { useState } from "react"
import type { Proposal } from "../gov/load"
import { FELLOWSHIP_SUBMIT_RANK, fellowshipCallsFor, fellowshipSubmitTx } from "../gov/release"
import type { AccountStatus } from "../gov/votes"
import { useWallet } from "../wallet"
import { loadOpengov } from "./opengov"
import { choice, useSubmit } from "./tx"
import { TxStatus } from "./TxStatus"
import { errorMessage } from "../util"

/**
 * Opens the Fellowship referendum that whitelists the call of a public referendum which has none.
 * Shown to everyone, and enabled for a selected account of sufficient rank. Renders nothing when
 * the call is not known: The public referendum names it by hash alone, and its preimage is not on
 * chain.
 */
export function WhitelistButton(props: {
  proposal: Proposal
  statuses: AccountStatus[]
  onSubmitted: () => void
}) {
  const { proposal } = props
  const wallet = useWallet()
  const { state, busy, submit } = useSubmit(props.onSubmitted)
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const call = proposal.whitelist?.call
  if (!call) return null

  const account = wallet.selected
  const rank = props.statuses.find((s) => s.address === account?.address)?.rank ?? null
  if (!account || rank === null || rank < FELLOWSHIP_SUBMIT_RANK)
    return (
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        A Fellowship member of rank {FELLOWSHIP_SUBMIT_RANK} or higher can open one here.
      </p>
    )

  const open = async () => {
    setBuilding(true)
    setError(null)
    try {
      const built = await fellowshipCallsFor(await loadOpengov(), proposal.network, call)
      submit(await fellowshipSubmitTx(built), account)
    } catch (e) {
      setError(errorMessage(e))
    }
    setBuilding(false)
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={busy || building}
        className={choice(true)}
        onClick={() => void open()}
      >
        Open Fellowship referendum
      </button>
      {building && (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Building the referendum…</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <TxStatus state={state} />
    </div>
  )
}
