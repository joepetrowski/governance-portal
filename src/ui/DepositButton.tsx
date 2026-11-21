import { CHAINS, NETWORKS } from "../chains"
import type { Stage } from "../gov/load"
import { type AccountStatus, decisionDepositTx } from "../gov/votes"
import { useWallet } from "../wallet"
import { formatBalance } from "./format"
import { choice, useSubmit } from "./tx"
import { TxStatus } from "./TxStatus"

/** Places a missing decision deposit from the selected account. Any account may place it. */
export function DepositButton(props: {
  stage: Stage
  statuses: AccountStatus[]
  onPlaced: () => void
}) {
  const { stage } = props
  const wallet = useWallet()
  const { state, busy, submit } = useSubmit(props.onPlaced)
  const account = wallet.selected
  const status = props.statuses.find((s) => s.address === account?.address)
  if (!account || !status) return null

  // The deposit is taken on the chain that hosts the referendum.
  const chain = stage.body === "fellowship" ? "collectives" : NETWORKS[stage.network].assetHub
  if (stage.body === "open" && status.unread.includes(stage.network))
    return (
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        Unable to read the balance of the selected account on {CHAINS[chain].name}.
      </span>
    )
  const free = status.free[chain]
  if (free < stage.deposit.required)
    return (
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        The selected account has {formatBalance(free, stage.network)} free on {CHAINS[chain].name}.
      </span>
    )
  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        disabled={busy}
        className={choice(false)}
        title="The deposit is returned after the referendum ends."
        onClick={() => submit(decisionDepositTx(stage), account)}
      >
        Place deposit
      </button>
      <TxStatus state={state} />
    </span>
  )
}
