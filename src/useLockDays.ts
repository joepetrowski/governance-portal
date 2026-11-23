import { useEffect, useState } from "react"
import type { Network } from "./chains"
import { loadLockDays } from "./gov/votes"

/** Lock durations per network, read once. */
const cache: Partial<Record<Network, Promise<number[]>>> = {}

/** The lock in days of each conviction on a network, or null until it is read. */
export function useLockDays(network: Network): number[] | null {
  const [lockDays, setLockDays] = useState<number[] | null>(null)
  useEffect(() => {
    const cached = (cache[network] ??= loadLockDays(network))
    cached.then(setLockDays).catch(() => delete cache[network])
  }, [network])
  return lockDays
}
