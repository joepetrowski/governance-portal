import { useEffect, useRef, useState } from "react"
import { CHAINS, type Network, NETWORK_IDS, NETWORKS } from "./chains"
import { findByAnchor, parseAnchor, type Proposal, proposalAnchor } from "./gov/load"
import { NamesContext } from "./names"
import { needsCleanup } from "./gov/cleanup"
import { CleanupPanel } from "./ui/CleanupPanel"
import { formatTime } from "./ui/format"
import { ProposalCard } from "./ui/ProposalCard"
import { ReleaseWizard } from "./ui/ReleaseWizard"
import { choice } from "./ui/tx"
import { UpgradePanel } from "./ui/UpgradePanel"
import { WalletButton } from "./ui/WalletButton"
import { useAccountStatuses } from "./useAccountStatuses"
import { useAnchor } from "./useAnchor"
import { useFinished } from "./useFinished"
import { useChainUpgrades } from "./useChainUpgrades"
import { useNames } from "./useNames"
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

  const anchor = useAnchor()
  const { finished, done: finishedRead } = useFinished(snapshot, anchor)
  const names = useNames(snapshot, finished)

  // The network that the visitor chose to see, and the link that the page had then.
  const [picked, setPicked] = useState<{ shown: Network | "all"; anchor: string | null }>({
    shown: "polkadot",
    anchor: null,
  })
  // Under "Polkadot", a Fellowship referendum that acts on Kusama is still shown to the members
  // who can vote on it, since that vote is theirs to cast on Polkadot.
  const canVote = (p: Proposal) =>
    p.fellowship !== undefined &&
    statuses.some((s) => s.rank !== null && s.rank >= (p.fellowship?.minRank ?? 0))
  const visible = (p: Proposal, under: Network | "all") =>
    under === "all" || p.network === under || (under === "polkadot" && canVote(p))

  // The card that the address of the page links to, among the active and the finished ones. Its
  // network is shown in place of the chosen one, until the visitor chooses again.
  const target =
    snapshot && anchor ? findByAnchor([...snapshot.proposals, ...finished], anchor) : undefined
  const shown =
    target && picked.anchor !== anchor && !visible(target, picked.shown)
      ? target.network
      : picked.shown
  const setShown = (next: Network | "all") => setPicked({ shown: next, anchor })
  const proposals = snapshot?.proposals.filter((p) => visible(p, shown)) ?? []
  const finishedShown = finished.filter((p) => visible(p, shown))

  // The page scrolls to the card the first time it is there. After that the browser follows links
  // to cards by itself.
  const targetShown =
    target !== undefined && (proposals.includes(target) || finishedShown.includes(target))
  const reached = useRef<string | null>(null)
  useEffect(() => {
    if (!target || !targetShown || reached.current === anchor) return
    reached.current = anchor
    document.getElementById(proposalAnchor(target))?.scrollIntoView()
  }, [anchor, target, targetShown])
  // A link to a referendum that is not listed is said to be so, once its network and the finished
  // referenda have been read.
  const linked = anchor ? parseAnchor(anchor) : null
  const missing =
    snapshot &&
    finishedRead &&
    linked &&
    !target &&
    (linked.where === "fellowship" ||
      !(snapshot.pending.includes(linked.where) || snapshot.unreachable.includes(linked.where)))
      ? `${linked.where === "fellowship" ? "Fellowship" : NETWORKS[linked.where].name} referendum #${linked.index}`
      : null

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

      {missing && (
        <p className="mb-3 text-sm text-amber-800 dark:text-amber-300">
          {missing} is not among the referenda shown here. It may be on a track that the portal does
          not show, or it ended and its last state could not be read.
        </p>
      )}

      {snapshot && proposals.length === 0 && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No active referenda.</p>
      )}

      <NamesContext.Provider value={names}>
        <div className="space-y-4">
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              fellowshipUncertain={snapshot?.fellowshipUncertain ?? true}
              releaseHashes={releaseHashes ?? {}}
              statuses={statuses}
              linked={proposal === target}
              onVoted={refresh}
            />
          ))}
        </div>
        {finishedShown.length > 0 && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Finished</h2>
            <p className="mt-1 mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              Referenda that ended in the last 24 hours, or that the address of this page links to,
              with their final tallies.
            </p>
            <div className="space-y-4">
              {finishedShown.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  fellowshipUncertain={snapshot?.fellowshipUncertain ?? true}
                  releaseHashes={releaseHashes ?? {}}
                  statuses={statuses}
                  linked={proposal === target}
                  onVoted={refresh}
                />
              ))}
            </div>
          </section>
        )}
      </NamesContext.Provider>

      <footer className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">
        {snapshot && (
          <p>
            Read from chain state at {formatTime(snapshot.loadedAt)}.
            {cleanups.length > 0 &&
              !cleanups.some(needsCleanup) &&
              " No finished votes or expired locks to clear."}
          </p>
        )}
        <p className="mt-1">
          The portal is open source.{" "}
          <a
            className="font-medium underline"
            href="https://github.com/joepetrowski/governance-portal"
            target="_blank"
            rel="noreferrer"
          >
            Contribute or report a problem on GitHub
          </a>
          .
        </p>
      </footer>
    </div>
  )
}
