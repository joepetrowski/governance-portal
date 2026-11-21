// Holds the connection to a browser wallet extension and remembers the last choice.

import {
  connectInjectedExtension,
  getInjectedExtensions,
  type InjectedExtension,
} from "polkadot-api/pjs-signer"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type Account, WalletContext } from "./wallet"

const DAPP_NAME = "Polkadot Governance"
const STORAGE_KEY = "wallet"

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
  // Accounts that the extension reported after connecting, kept with the extension they are from.
  const [reported, setReported] = useState<{ from: InjectedExtension; accounts: Account[] } | null>(
    null,
  )
  const [address, setAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Set by any attempt to connect, so that the automatic one never follows a manual one.
  const attempted = useRef(false)

  const connect = useCallback(async (name: string) => {
    attempted.current = true
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
    const look = () => {
      const found = talismanFirst(getInjectedExtensions())
      setAvailable(found)
      const previous = remembered().extension
      if (!attempted.current && previous && found.includes(previous)) void connect(previous)
    }
    look()
    const timers = [300, 1500].map((ms) => setTimeout(look, ms))
    return () => timers.forEach(clearTimeout)
  }, [connect])

  useEffect(
    () => extension?.subscribe((all) => setReported({ from: extension, accounts: all })),
    [extension],
  )
  // Until the extension reports a change, its accounts are the ones it has at connection.
  const accounts = useMemo(() => {
    const all = reported?.from === extension ? reported.accounts : (extension?.getAccounts() ?? [])
    // Extensions also share Ethereum accounts, which these chains cannot use.
    return all.filter((a) => !a.address.startsWith("0x"))
  }, [extension, reported])

  const disconnect = useCallback(() => {
    extension?.disconnect()
    setExtension(null)
    setReported(null)
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
