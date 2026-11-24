import { useFellowship } from "../actor"
import { CHAINS, NETWORKS } from "../chains"
import type { Stage } from "../gov/load"
import { asMember } from "../gov/proxy"
import { type AccountStatus, decisionDepositTx } from "../gov/votes"
import { useWallet } from "../wallet"
import { formatBalance } from "./format"
import { useDepositPending } from "./flows"
import { choice, useSubmit } from "./tx"
import { TxStatus } from "./TxStatus"

/**
 * Places a missing decision deposit from the selected account. Any account may place it. On a
 * Fellowship referendum, an account that acts for a member by proxy places it for the member,
 * from the member's account, like everything else that it does there.
 */
export function DepositButton(props: {
  stage: Stage
  statuses: AccountStatus[]
  onPlaced: () => void
}) {
  const { stage } = props
  const wallet = useWallet()
  const { state, busy, submit } = useSubmit(props.onPlaced)
  const account = wallet.selected
  const { actor } = useFellowship()
  const proxy = stage.body === "fellowship" ? (actor?.proxy ?? null) : null
  const status = proxy ? actor?.status : props.statuses.find((s) => s.address === account?.address)
  const whose = proxy ? "The member's account" : "The selected account"
  // A second deposit would fail, and take the vote that is batched with the first down with it.
  const pending = useDepositPending(stage)
  if (pending)
    return (
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        Your second transaction is placing it.
      </span>
    )
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
        {whose} has {formatBalance(free, stage.network)} free on {CHAINS[chain].name}.
      </span>
    )
  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        disabled={busy}
        className={choice(false)}
        title={
          proxy
            ? "The deposit is taken from the member's account, by proxy, and returned to it " +
              "after the referendum ends."
            : "The deposit is returned after the referendum ends."
        }
        onClick={() => submit(asMember(decisionDepositTx(stage), proxy), account)}
      >
        {proxy ? "Place deposit by proxy" : "Place deposit"}
      </button>
      <TxStatus state={state} />
    </span>
  )
}
