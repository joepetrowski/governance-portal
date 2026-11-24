import { useEffect, useState } from "react"
import type { Snapshot } from "./gov/load"
import { loadMemberProxies, type MemberProxies } from "./gov/proxy"

const NONE: MemberProxies = { usable: [], delayed: [] }

/**
 * The Fellowship members that the wallet's accounts may act for by proxy, read again with every
 * snapshot. A read that fails keeps what was read before for the same accounts.
 */
export function useMemberProxies(addresses: string[], snapshot: Snapshot | null): MemberProxies {
  // What was read, with the accounts that it was read for.
  const [read, setRead] = useState<{ key: string; proxies: MemberProxies } | null>(null)
  const key = addresses.join(",")

  useEffect(() => {
    if (!snapshot || key === "") return
    let canceled = false
    loadMemberProxies(key.split(",")).then(
      (next) => {
        if (!canceled) setRead({ key, proxies: next })
      },
      () => {
        // Keep the previous result. The next snapshot tries again.
      },
    )
    return () => {
      canceled = true
    }
  }, [key, snapshot])

  // What was read for other accounts, such as those of another wallet, says nothing of these.
  return read?.key === key ? read.proxies : NONE
}
