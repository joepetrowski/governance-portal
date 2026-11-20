import { useState } from "react"
import { CHAINS, type Network, NETWORK_IDS, NETWORKS } from "./chains"
import type { Proposal } from "./gov/load"
import { CleanupPanel, needsCleanup } from "./ui/CleanupPanel"
import { formatTime } from "./ui/format"
import { ProposalCard } from "./ui/ProposalCard"
import { ReleaseWizard } from "./ui/ReleaseWizard"
import { choice } from "./ui/tx"
import { UpgradePanel } from "./ui/UpgradePanel"
import { WalletButton } from "./ui/WalletButton"
import { useAccountStatuses } from "./useAccountStatuses"
import { useChainUpgrades } from "./useChainUpgrades"
import { useCleanups } from "./useCleanups"
import { useReleaseHashes } from "./useReleaseHashes"
import { useSnapshot } from "./useSnapshot"
import { useWallet } from "./wallet"

/**
 * The page: header with the wallet, the release wizard, approved upgrades, pending cleanup, and
 * the open proposals.
 */
export default function App() {
  const { snapshot, error, refresh } = useSnapshot()
  const wallet = useWallet()
  const statuses = useAccountStatuses(
    wallet.accounts.map((a) => a.address),
    snapshot,
  )

  const chainUpgrades = useChainUpgrades(snapshot)
  // Release notes are read only when an upgrade is on the page to be named.
  const releaseHashes = useReleaseHashes(
    chainUpgrades.length > 0 || (snapshot?.proposals.some((p) => p.upgrades.length > 0) ?? false),
  )

  const [shown, setShown] = useState<Network | "all">("polkadot")
  // Under "Polkadot", a Fellowship referendum that acts on Kusama is still shown to the members
  // who can vote on it, since that vote is theirs to cast on Polkadot.
  const canVote = (p: Proposal) =>
    p.fellowship !== undefined &&
    statuses.some((s) => s.rank !== null && s.rank >= (p.fellowship?.minRank ?? 0))
  const proposals =
    snapshot?.proposals.filter(
      (p) => shown === "all" || p.network === shown || (shown === "polkadot" && canVote(p)),
    ) ?? []

  const cleanups = useCleanups(
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
          Active Fellowship referenda, and public referenda of Polkadot and Kusama on the Root,
          Whitelisted Caller, and Staking Admin tracks.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Could not read chain state: {error}. {snapshot ? "Showing the last result." : "Retrying."}
        </p>
      )}

      {!snapshot && !error && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Reading chain state…</p>
      )}

      {snapshot && <ReleaseWizard snapshot={snapshot} statuses={statuses} onSubmitted={refresh} />}

      {snapshot && (
        <UpgradePanel
          upgrades={chainUpgrades.filter(
            (u) => shown === "all" || CHAINS[u.chain].network === shown,
          )}
          releaseHashes={releaseHashes}
          loadedAt={snapshot.loadedAt}
          onApplied={refresh}
        />
      )}

      <CleanupPanel cleanups={cleanups} onCleaned={refresh} />

      {snapshot?.unreachable.map((network) => (
        <p key={network} className="mb-4 text-sm text-amber-800 dark:text-amber-300">
          Could not read {NETWORKS[network].name}, so its public referenda are not shown.
        </p>
      ))}

      {snapshot && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Show</span>
          {([...NETWORK_IDS, "all"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={shown === option}
              className={choice(shown === option)}
              onClick={() => setShown(option)}
            >
              {option === "all" ? "All" : NETWORKS[option].name}
            </button>
          ))}
        </div>
      )}

      {snapshot?.pending.map((network) => (
        <p key={network} className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Reading {NETWORKS[network].name}…
        </p>
      ))}

      {snapshot && proposals.length === 0 && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No active referenda.</p>
      )}

      <div className="space-y-4">
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            fellowshipUncertain={snapshot?.fellowshipUncertain ?? true}
            releaseHashes={releaseHashes ?? {}}
            statuses={statuses}
            onVoted={refresh}
          />
        ))}
      </div>

      {snapshot && (
        <footer className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">
          Read from chain state at {formatTime(snapshot.loadedAt)}.
          {cleanups.length > 0 &&
            !cleanups.some(needsCleanup) &&
            " No finished votes or expired locks to clear."}
        </footer>
      )}
    </div>
  )
}
