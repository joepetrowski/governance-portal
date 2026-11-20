import { useEffect, useState } from "react"
import { loadReleaseHashes, type ReleaseHashes } from "./gov/versions"

const RETRY_MS = 60_000

/**
 * The runtime hashes of recent releases, once `wanted` is true. Null until they are read. A read
 * that fails, for example because GitHub limits requests, is tried again every minute.
 */
export function useReleaseHashes(wanted: boolean): ReleaseHashes | null {
  const [hashes, setHashes] = useState<ReleaseHashes | null>(null)
  useEffect(() => {
    if (!wanted) return
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    const read = () =>
      loadReleaseHashes()
        .then((next) => {
          if (!canceled) setHashes(next)
        })
        .catch(() => {
          if (!canceled) timer = setTimeout(read, RETRY_MS)
        })
    void read()
    return () => {
      canceled = true
      clearTimeout(timer)
    }
  }, [wanted])
  return hashes
}
