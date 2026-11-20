import { useWallet } from "../wallet"
import { shortAddress } from "./format"

const displayName = (extension: string) =>
  extension === "talisman"
    ? "Talisman"
    : extension.replace(/-js$/, "").replace(/^./, (c) => c.toUpperCase())

const button =
  "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"

/** Connects a wallet extension, or, once connected, selects the signing account and disconnects. */
export function WalletButton() {
  const wallet = useWallet()

  if (wallet.connected) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {wallet.accounts.length === 0 ? (
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            No accounts shared by {displayName(wallet.connected)}
          </span>
        ) : (
          <select
            aria-label="Account that signs"
            className={`${button} max-w-56`}
            value={wallet.selected?.address ?? ""}
            onChange={(e) => wallet.select(e.target.value)}
          >
            {wallet.accounts.map((account) => (
              <option key={account.address} value={account.address}>
                {account.name
                  ? `${account.name} (${shortAddress(account.address)})`
                  : shortAddress(account.address)}
              </option>
            ))}
          </select>
        )}
        <button type="button" className={button} onClick={wallet.disconnect}>
          Disconnect
        </button>
      </div>
    )
  }

  if (wallet.available.length === 0)
    return (
      <span className="text-sm text-zinc-500 dark:text-zinc-400">
        No wallet extension found. Install Talisman to vote.
      </span>
    )

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {wallet.available.map((extension) => (
          <button
            key={extension}
            type="button"
            className={button}
            onClick={() => wallet.connect(extension)}
          >
            Connect {displayName(extension)}
          </button>
        ))}
      </div>
      {wallet.error && (
        <span className="text-xs text-red-700 dark:text-red-400">{wallet.error}</span>
      )}
    </div>
  )
}
