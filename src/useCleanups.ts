import { useEffect, useState } from "react"
import { type Cleanup, loadCleanup } from "./gov/cleanup"
import type { Snapshot } from "./gov/load"

/** Stale votes and locks of each wallet account, refreshed with every snapshot. */
export function useCleanups(addresses: string[], snapshot: Snapshot | null) {
  const [cleanups, setCleanups] = useState<Cleanup[]>([])
  const key = addresses.join(",")

  useEffect(() => {
    if (!snapshot || key === "") return
    let canceled = false
    Promise.all(key.split(",").map(loadCleanup))
      .then((next) => {
        if (!canceled) setCleanups(next)
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
