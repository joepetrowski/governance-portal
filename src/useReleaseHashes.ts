import { useEffect, useState } from "react"
import { loadReleaseHashes, type ReleaseHashes } from "./gov/versions"

/**
 * The runtime hashes of recent releases, once `wanted` is true. Empty until they are read, and if
 * they cannot be read, in which case upgrades keep their plain titles.
 */
export function useReleaseHashes(wanted: boolean): ReleaseHashes {
  const [hashes, setHashes] = useState<ReleaseHashes>({})
  useEffect(() => {
    if (!wanted) return
    let canceled = false
    loadReleaseHashes()
      .then((next) => {
        if (!canceled) setHashes(next)
      })
      .catch(() => {
        // The titles stay as they are.
      })
    return () => {
      canceled = true
    }
  }, [wanted])
  return hashes
}
