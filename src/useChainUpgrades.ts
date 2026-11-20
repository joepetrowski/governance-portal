import { useEffect, useState } from "react"
import { NETWORK_IDS } from "./chains"
import { type ChainUpgrade, loadChainUpgrades } from "./gov/apply"
import type { Snapshot } from "./gov/load"

/**
 * Approved upgrades that are not yet in effect, on every chain of the networks that the snapshot
 * covers. Refreshed with every snapshot.
 */
export function useChainUpgrades(snapshot: Snapshot | null): ChainUpgrade[] {
  const [upgrades, setUpgrades] = useState<ChainUpgrade[]>([])

  useEffect(() => {
    if (!snapshot) return
    let canceled = false
    const networks = NETWORK_IDS.filter((n) => !snapshot.pending.includes(n))
    Promise.all(networks.map((network) => loadChainUpgrades(network).catch(() => [])))
      .then((next) => {
        if (!canceled) setUpgrades(next.flat())
      })
      .catch(() => {
        // Keep the previous result; the next snapshot retries.
      })
    return () => {
      canceled = true
    }
  }, [snapshot])

  return upgrades
}
