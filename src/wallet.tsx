// Connection to a browser wallet extension (Talisman first, any compatible extension works).

import {
  connectInjectedExtension,
  getInjectedExtensions,
  type InjectedExtension,
  type InjectedPolkadotAccount,
} from "polkadot-api/pjs-signer"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react"

const DAPP_NAME = "Polkadot Governance"
const STORAGE_KEY = "wallet"

/** A wallet account, with the signer that the extension provides for it. */
export type Account = InjectedPolkadotAccount

interface Wallet {
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

const WalletContext = createContext<Wallet | null>(null)

const remembered = (): { extension?: string; address?: string } => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
  } catch {
    return {}
  }
}
const remember = (value: { extension?: string; address?: string }) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage can be unavailable (private windows); the choice is then just not remembered.
  }
}

const talismanFirst = (names: string[]) =>
  [...names].sort((a, b) => Number(b === "talisman") - Number(a === "talisman"))

/** Holds the wallet connection for the page. Reconnects to the extension used on the last visit. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState<string[]>([])
  const [extension, setExtension] = useState<InjectedExtension | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [address, setAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(async (name: string) => {
    try {
      const next = await connectInjectedExtension(name, DAPP_NAME)
      setExtension(next)
      setError(null)
      remember({ ...remembered(), extension: name })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Extensions inject themselves shortly after the page loads, so look more than once.
  useEffect(() => {
    let reconnected = false
    const look = () => {
      const found = talismanFirst(getInjectedExtensions())
      setAvailable(found)
      const previous = remembered().extension
      if (!reconnected && previous && found.includes(previous)) {
        reconnected = true
        void connect(previous)
      }
    }
    look()
    const timers = [300, 1500].map((ms) => setTimeout(look, ms))
    return () => timers.forEach(clearTimeout)
  }, [connect])

  useEffect(() => {
    if (!extension) return
    setAccounts(extension.getAccounts())
    return extension.subscribe(setAccounts)
  }, [extension])

  const disconnect = useCallback(() => {
    extension?.disconnect()
    setExtension(null)
    setAccounts([])
    remember({})
  }, [extension])

  const select = useCallback((next: string) => {
    setAddress(next)
    remember({ ...remembered(), address: next })
  }, [])

  const wanted = address ?? remembered().address
  const selected = accounts.find((a) => a.address === wanted) ?? accounts[0] ?? null

  return (
    <WalletContext.Provider
      value={{
        available,
        connected: extension?.name ?? null,
        accounts,
        selected,
        error,
        connect,
        disconnect,
        select,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}

/** The wallet connection. Must be called inside `WalletProvider`. */
export function useWallet(): Wallet {
  const wallet = useContext(WalletContext)
  if (!wallet) throw new Error("useWallet must be used inside WalletProvider")
  return wallet
}
