import { useEffect, useState } from "react"
import type { Snapshot } from "./gov/load"
import { type AccountStatus, loadAccountStatus } from "./gov/votes"

/** Votes, rank, and balance of each wallet account, refreshed with every snapshot. */
export function useAccountStatuses(addresses: string[], snapshot: Snapshot | null) {
  const [statuses, setStatuses] = useState<AccountStatus[]>([])
  const key = addresses.join(",")

  useEffect(() => {
    if (!snapshot || key === "") return
    let canceled = false
    const stages = snapshot.proposals.flatMap((p) => [p.fellowship, p.open]).filter((s) => !!s)
    Promise.all(
      key.split(",").map((address) => loadAccountStatus(address, stages, snapshot.pending)),
    )
      .then((next) => {
        if (!canceled) setStatuses(next)
      })
      .catch(() => {
        // Keep the previous result; the next snapshot retries.
      })
    return () => {
      canceled = true
    }
  }, [key, snapshot])

  // With no accounts there is nothing to show, whatever was loaded before.
  return key === "" ? [] : statuses
}
