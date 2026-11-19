import { useEffect, useState } from "react"
import { loadSnapshot, type Snapshot } from "./gov/load"

const REFRESH_MS = 60_000

export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  }, [])

  return { snapshot, error }
}
