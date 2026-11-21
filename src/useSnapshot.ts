import { useCallback, useEffect, useRef, useState } from "react"
import { closeClients } from "./chains"
import { loadSnapshot, type Snapshot } from "./gov/load"
import { errorMessage } from "./util"

const REFRESH_MS = 60_000
/** How long the page may be in the background before it stops reading and disconnects. */
const IDLE_MS = 5 * 60_000

/**
 * The current snapshot, reloaded every minute and whenever `refresh` is called. The first one
 * covers Polkadot alone, and Kusama is added in the background. A failed reload keeps the previous
 * snapshot and reports the error.
 *
 * A page that has been in the background for five minutes closes its connections and stops
 * reloading, so that a forgotten tab does not keep 13 chains streaming blocks to it. It reloads
 * when it is shown again.
 */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Bumping this restarts the polling loop, which loads immediately.
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((g) => g + 1), [])
  const first = useRef(true)
  const asleep = useRef(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const sleep = () => {
      // A transaction that is being followed holds the connections open, so try again later.
      if (closeClients()) asleep.current = true
      else timer = setTimeout(sleep, IDLE_MS)
    }
    const onVisibility = () => {
      clearTimeout(timer)
      if (document.hidden) timer = setTimeout(sleep, IDLE_MS)
      else if (asleep.current) {
        asleep.current = false
        refresh()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [refresh])

  useEffect(() => {
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    // Polkadot is the focus, so the very first read is of Polkadot alone and is shown as soon as
    // it is there. Every read after it includes Kusama and replaces the result when it is
    // complete.
    const tick = async () => {
      // Reading would connect again. The loop restarts when the page is shown.
      if (asleep.current) return
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
