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
    const addresses = key.split(",")
    // One account that cannot be read must not hide the others.
    const loads = addresses.map((address) =>
      loadAccountStatus(address, stages, snapshot.pending).catch(() => null),
    )
    Promise.all(loads).then((next) => {
      if (canceled) return
      // An account that could not be read keeps what was read before, so that its controls do
      // not disappear over one failed request. The next snapshot tries again.
      setStatuses((previous) =>
        addresses.flatMap(
          (address, i) => next[i] ?? previous.find((s) => s.address === address) ?? [],
        ),
      )
    })
    return () => {
      canceled = true
    }
  }, [key, snapshot])

  // With no accounts there is nothing to show, whatever was loaded before.
  return key === "" ? [] : statuses
}
