import { CleanupPanel } from "./ui/CleanupPanel"
import { formatTime } from "./ui/format"
import { ProposalCard } from "./ui/ProposalCard"
import { WalletButton } from "./ui/WalletButton"
import { useAccountStatuses } from "./useAccountStatuses"
import { useSnapshot } from "./useSnapshot"
import { useWallet } from "./wallet"

export default function App() {
  const { snapshot, error, refresh } = useSnapshot()
  const wallet = useWallet()
  const statuses = useAccountStatuses(
    wallet.accounts.map((a) => a.address),
    snapshot,
  )

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold">Polkadot Governance</h1>
          <WalletButton />
        </div>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Active Fellowship referenda and public referenda on the Root, Whitelisted Caller, and
          Staking Admin tracks.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Could not read chain state: {error}. {snapshot ? "Showing the last result." : "Retrying."}
        </p>
      )}

      {!snapshot && !error && <p className="text-sm text-zinc-500">Reading chain state…</p>}

      {snapshot && snapshot.proposals.length === 0 && (
        <p className="text-sm text-zinc-500">No active referenda.</p>
      )}

      <div className="space-y-4">
        {snapshot?.proposals.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} statuses={statuses} onVoted={refresh} />
        ))}
      </div>

      {snapshot && <CleanupPanel snapshot={snapshot} onCleaned={refresh} />}

      {snapshot && (
        <footer className="mt-6 text-xs text-zinc-500">
          Read from chain state at {formatTime(snapshot.loadedAt)}.
        </footer>
      )}
    </div>
  )
}
