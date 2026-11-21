import { useCallback, useEffect, useRef, useState } from "react"
import { loadSnapshot, type Snapshot } from "./gov/load"
import { errorMessage } from "./util"

const REFRESH_MS = 60_000

/**
 * The current snapshot, reloaded every minute and whenever `refresh` is called. The first one
 * covers Polkadot alone, and Kusama is added in the background. A failed reload keeps the previous
 * snapshot and reports the error.
 */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Bumping this restarts the polling loop, which loads immediately.
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((g) => g + 1), [])
  const first = useRef(true)

  useEffect(() => {
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    // Polkadot is the focus, so the very first read is of Polkadot alone and is shown as soon as
    // it is there. Every read after it includes Kusama and replaces the result when it is
    // complete.
    const tick = async () => {
      try {
        if (first.current) {
          const polkadot = await loadSnapshot(["polkadot"])
          if (canceled) return
          setSnapshot((current) => current ?? polkadot)
          setError(null)
          first.current = false
        }
        const next = await loadSnapshot()
        if (canceled) return
        setSnapshot(next)
        setError(null)
      } catch (e) {
        if (!canceled) setError(errorMessage(e))
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
