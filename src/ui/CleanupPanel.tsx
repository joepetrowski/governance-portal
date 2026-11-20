import { NETWORKS, RELAY_BLOCK_MS } from "../chains"
import { type Cleanup, cleanupTx, MAX_REMOVALS } from "../gov/cleanup"
import { type Account, useWallet } from "../wallet"
import { formatBalance, formatDateTime, shortAddress } from "./format"
import { choice, TxStatus, useSubmit } from "./tx"

/** One account's stale votes and lock, with the button that clears them. */
function AccountCleanup(props: { cleanup: Cleanup; account: Account; onCleaned: () => void }) {
  const { cleanup, account } = props
  const { state, busy, submit } = useSubmit(props.onCleaned)
  const when = (block: number) =>
    formatDateTime(cleanup.loadedAt + (block - cleanup.now) * RELAY_BLOCK_MS)
  const count = cleanup.stale.length
  const freed = cleanup.lockedNow - cleanup.lockedAfter
  const amount = (planck: bigint) => formatBalance(planck, cleanup.network)

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm">
          <p className="font-medium">
            {account.name ?? shortAddress(account.address)}{" "}
            <span className="font-normal text-zinc-500">on {NETWORKS[cleanup.network].name}</span>
          </p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {count === 0
              ? "No votes on finished referenda."
              : `${count} ${count === 1 ? "vote" : "votes"} on finished referenda.`}{" "}
            {cleanup.lockedNow === 0n
              ? "Nothing is locked by voting."
              : `${amount(cleanup.lockedNow)} is locked by voting, and ${
                  freed > 0n ? amount(freed) : "none"
                } of it can be unlocked now.`}
            {cleanup.lockedAfter > 0n &&
              cleanup.nextUnlock !== null &&
              ` The next part of the lock expires around ${when(cleanup.nextUnlock)}.`}
          </p>
        </div>
        <div className="flex flex-col items-end">
          <button
            type="button"
            disabled={busy}
            className={choice(true)}
            onClick={() => submit(cleanupTx(cleanup), account)}
          >
            {count === 0 ? "Unlock" : freed > 0n ? "Clear votes and unlock" : "Clear votes"}
          </button>
          <TxStatus state={state} />
        </div>
      </div>
      {count > MAX_REMOVALS && (
        <p className="mt-2 text-xs text-zinc-500">
          One transaction clears {MAX_REMOVALS} votes, newest first. Repeat it for the rest; the
          full amount unlocks once all of them are cleared.
        </p>
      )}
      {count > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-zinc-700 dark:text-zinc-300">
            Votes to clear
          </summary>
          <ul className="mt-2 space-y-0.5 text-sm">
            {cleanup.stale.map((vote) => (
              <li key={`${vote.trackId}-${vote.index}`}>
                <span className="tabular-nums">#{vote.index}</span>{" "}
                <span className="text-zinc-500">
                  ({vote.track}, {vote.outcome.toLowerCase()})
                </span>
                : {vote.detail}
                {vote.lockedUntil !== null && (
                  <span className="text-amber-700 dark:text-amber-400">
                    , locked until around {when(vote.lockedUntil)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  )
}

/** Whether the account has stale votes to remove or a voting lock that can be lowered. */
export const needsCleanup = (cleanup: Cleanup) => cleanup.stale.length + cleanup.tracks.length > 0

/**
 * Votes on finished public referenda, and voting locks that can be lowered, per wallet account.
 * Shown above the proposals, and only when an account has something to clear, so that it is seen
 * without scrolling but takes no room otherwise.
 */
export function CleanupPanel(props: { cleanups: Cleanup[]; onCleaned: () => void }) {
  const wallet = useWallet()
  const pending = props.cleanups.flatMap((cleanup) => {
    const account = wallet.accounts.find((a) => a.address === cleanup.address)
    return account && needsCleanup(cleanup) ? [{ cleanup, account }] : []
  })
  if (pending.length === 0) return null

  return (
    <section className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/30">
      <h2 className="text-lg font-semibold">Finished votes and locks</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Votes stay on record after a public referendum ends, and they keep their balance locked
        until they are removed. Removing a vote that is still within its conviction lock loses
        nothing: That balance stays locked until the lock expires.
      </p>
      <ul className="mt-3 space-y-3">
        {pending.map(({ cleanup, account }) => (
          <AccountCleanup
            key={`${cleanup.network}-${cleanup.address}`}
            cleanup={cleanup}
            account={account}
            onCleaned={props.onCleaned}
          />
        ))}
      </ul>
    </section>
  )
}
