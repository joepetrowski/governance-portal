import { useCallback, useEffect, useState } from "react"
import { loadSnapshot, type Snapshot } from "./gov/load"

const REFRESH_MS = 60_000

/**
 * The current snapshot, reloaded every minute and whenever `refresh` is called. A failed reload
 * keeps the previous snapshot and reports the error.
 */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Bumping this restarts the polling loop, which loads immediately.
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  useEffect(() => {
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await loadSnapshot()
        if (canceled) return
        setSnapshot(next)
        setError(null)
      } catch (e) {
        if (!canceled) setError(e instanceof Error ? e.message : String(e))
      }
      if (!canceled) timer = setTimeout(tick, REFRESH_MS)
    }
    tick()
    return () => {
      canceled = true
      clearTimeout(timer)
    }
  }, [generation])

  return { snapshot, error, refresh }
}
