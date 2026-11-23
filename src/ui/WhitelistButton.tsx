import type { Proposal } from "../gov/load"
import { FELLOWSHIP_SUBMIT_RANK, fellowshipCallsFor, fellowshipSubmitTx } from "../gov/release"
import type { AccountStatus } from "../gov/votes"
import { useWallet } from "../wallet"
import { OpenReferendum } from "./OpenReferendum"
import { loadOpengov } from "./opengov"

/**
 * Opens the Fellowship referendum that whitelists the call of a public referendum which has none,
 * with the choice to place its decision deposit and to vote aye. Shown to everyone, and enabled
 * for a selected account of sufficient rank. Renders nothing when the call is not known: The
 * public referendum names it by hash alone, and its preimage is not on chain.
 */
export function WhitelistButton(props: {
  proposal: Proposal
  statuses: AccountStatus[]
  onSubmitted: () => void
}) {
  const { proposal } = props
  const wallet = useWallet()
  const call = proposal.whitelist?.call
  if (!call) return null

  const account = wallet.selected
  const status = props.statuses.find((s) => s.address === account?.address)
  const rank = status?.rank ?? null
  if (!account || rank === null || rank < FELLOWSHIP_SUBMIT_RANK)
    return (
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        A Fellowship member of rank {FELLOWSHIP_SUBMIT_RANK} or higher can open one here.
      </p>
    )

  return (
    <OpenReferendum
      body="fellowship"
      network="polkadot"
      label="Open Fellowship referendum"
      account={account}
      status={status}
      makeTx={async () =>
        fellowshipSubmitTx(await fellowshipCallsFor(await loadOpengov(), proposal.network, call))
      }
      onDone={props.onSubmitted}
    />
  )
}
