import { useEffect, useState } from "react"
import { loadSnapshot, type Snapshot } from "./gov/load"

const REFRESH_MS = 60_000

export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await loadSnapshot()
        if (cancelled) return
        setSnapshot(next)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
      if (!cancelled) timer = setTimeout(tick, REFRESH_MS)
    }
    tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  return { snapshot, error }
}
