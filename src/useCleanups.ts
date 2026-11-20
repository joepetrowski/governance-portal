import { useEffect, useState } from "react"
import { NETWORK_IDS } from "./chains"
import { type Cleanup, loadCleanup } from "./gov/cleanup"
import type { Snapshot } from "./gov/load"

/**
 * Stale votes and locks of each wallet account on each network, refreshed with every snapshot. A
 * network that cannot be read is left out.
 */
export function useCleanups(addresses: string[], snapshot: Snapshot | null) {
  const [cleanups, setCleanups] = useState<Cleanup[]>([])
  const key = addresses.join(",")

  useEffect(() => {
    if (!snapshot || key === "") return
    let canceled = false
    const loads = key
      .split(",")
      .flatMap((address) =>
        NETWORK_IDS.filter((network) => !snapshot.pending.includes(network)).map((network) =>
          loadCleanup(address, network).catch(() => null),
        ),
      )
    Promise.all(loads)
      .then((next) => {
        if (!canceled) setCleanups(next.filter((c) => c !== null))
      })
      .catch(() => {
        // Keep the previous result; the next snapshot retries.
      })
    return () => {
      canceled = true
    }
  }, [key, snapshot])

  return key === "" ? [] : cleanups
}
