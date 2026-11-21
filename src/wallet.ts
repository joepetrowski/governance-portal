// Connection to a browser wallet extension (Talisman first, any compatible extension works).

import type { InjectedPolkadotAccount } from "polkadot-api/pjs-signer"
import { createContext, useContext } from "react"

/** A wallet account, with the signer that the extension provides for it. */
export type Account = InjectedPolkadotAccount

/** The wallet connection as the page sees it. */
export interface Wallet {
  /** Extensions found in this browser, Talisman first. */
  available: string[]
  /** Name of the connected extension. */
  connected: string | null
  /** Accounts the extension has shared with this page. */
  accounts: Account[]
  /** The account that signs. */
  selected: Account | null
  /** Why the last attempt to connect failed, if it did. */
  error: string | null
  /** Connect to an extension by name, and remember it for the next visit. */
  connect: (extension: string) => Promise<void>
  /** Forget the extension and its accounts. */
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
