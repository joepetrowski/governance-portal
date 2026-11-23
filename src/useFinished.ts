import { useEffect, useState } from "react"
import { loadFinished } from "./gov/finished"
import type { Proposal, Snapshot } from "./gov/load"

/**
 * The proposals that finished in the last day, and the finished one that `linked` names, read
 * after every snapshot. `done` says whether they have been read for this snapshot and link. A read
 * that fails keeps what was shown before.
 */
export function useFinished(snapshot: Snapshot | null, linked: string | null) {
  const [result, setResult] = useState<{
    finished: Proposal[]
    snapshot: Snapshot | null
    linked: string | null
  }>({ finished: [], snapshot: null, linked: null })

  useEffect(() => {
    if (!snapshot) return
    let canceled = false
    loadFinished(snapshot, linked).then(
      (finished) => !canceled && setResult({ finished, snapshot, linked }),
      () => !canceled && setResult((last) => ({ ...last, snapshot, linked })),
    )
    return () => {
      canceled = true
    }
  }, [snapshot, linked])

  const done = result.snapshot === snapshot && result.linked === linked
  return { finished: result.finished, done }
}
