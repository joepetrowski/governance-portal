// Connection to a wallet that injects itself into the page: a browser extension, or the browser
// of a wallet app such as Nova. Talisman is offered first, and any compatible wallet works.

import type { InjectedPolkadotAccount } from "polkadot-api/pjs-signer"
import { createContext, useContext } from "react"

/** A wallet account, with the signer that the wallet provides for it. */
export type Account = InjectedPolkadotAccount

/**
 * Names under which wallets inject themselves, with what they are called. A map, since the names
 * come from whatever is installed, and a plain object would also answer to names such as
 * `constructor`.
 */
const WALLET_NAMES = new Map([
  ["talisman", "Talisman"],
  ["polkadot-js", "Polkadot.js"],
  ["subwallet-js", "SubWallet"],
  ["polkagate", "PolkaGate"],
  ["nova-wallet", "Nova Wallet"],
])

/**
 * What a wallet is called, given the name under which it injected itself. A name that is not
 * known is shown as it is, without the `-js` that many end in, and without control and formatting
 * characters, which could reorder or hide what is around it.
 *
 * In the browser of Nova Wallet, `nova` is set, and the `polkadot-js` entry is Nova: It injects
 * itself under that name, for pages that know no other.
 */
export function walletLabel(name: string, nova: boolean): string {
  if (nova && name === "polkadot-js") return "Nova Wallet"
  const known = WALLET_NAMES.get(name)
  if (known) return known
  const plain = name.replace(/\p{C}/gu, "").replace(/-js$/, "")
  return plain.replace(/^./, (c) => c.toUpperCase())
}

/**
 * The wallets to offer, from the names found in the page: Talisman first, and each wallet once.
 * Nova Wallet injects itself under two names. The `polkadot-js` entry is kept, since every version
 * of Nova has it.
 */
export function walletChoices(names: string[], nova: boolean): string[] {
  const kept =
    nova && names.includes("polkadot-js") ? names.filter((n) => n !== "nova-wallet") : names
  return [...new Set(kept)].sort((a, b) => Number(b === "talisman") - Number(a === "talisman"))
}

/**
 * The wallet to connect to again, given the one used on the last visit and those offered now.
 * Null if it is not among them. In Nova Wallet, a visit remembered under `nova-wallet` is one with
 * the `polkadot-js` entry, which is the same wallet and the one that is offered.
 */
export function walletToRejoin(
  previous: string | undefined,
  offered: string[],
  nova: boolean,
): string | null {
  const name = nova && previous === "nova-wallet" ? "polkadot-js" : previous
  return name !== undefined && offered.includes(name) ? name : null
}

/** Whether the page runs in the browser of Nova Wallet, which sets a flag to say so. */
export const inNovaWallet = (): boolean =>
  (window as { walletExtension?: { isNovaWallet?: unknown } }).walletExtension?.isNovaWallet ===
  true

/** The wallet connection as the page sees it. */
export interface Wallet {
  /** Wallets found in the page, by the name each injected itself under. See `walletChoices`. */
  available: string[]
  /** Whether the page is still looking for wallets, which inject themselves after it loads. */
  looking: boolean
  /** Name under which the connected wallet injected itself. */
  connected: string | null
  /** Accounts the wallet has shared with this page. */
  accounts: Account[]
  /** The account that signs. */
  selected: Account | null
  /** Why the last attempt to connect failed, if it did. */
  error: string | null
  /** Connect to a wallet by name, and remember it for the next visit. */
  connect: (extension: string) => Promise<void>
  /** Forget the wallet and its accounts. */
  disconnect: () => void
  /** Choose the account that signs. */
  select: (address: string) => void
}

/** Carries the wallet connection from `WalletProvider` to `useWallet`. */
export const WalletContext = createContext<Wallet | null>(null)

/** The wallet connection. Must be called inside `WalletProvider`. */
export function useWallet(): Wallet {
  const wallet = useContext(WalletContext)
  if (!wallet) throw new Error("useWallet must be used inside WalletProvider")
  return wallet
}
