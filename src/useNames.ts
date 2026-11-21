import { useEffect, useRef, useState } from "react"
import { type Network, NETWORK_IDS } from "./chains"
import { loadNames } from "./gov/identity"
import type { Snapshot } from "./gov/load"
import type { Names } from "./names"

/** How long a name is shown before it is read again, in case it or its standing has changed. */
const STALE_MS = 10 * 60_000

/**
 * Identities of the accounts that the snapshot shows: those that submitted a referendum or placed
 * its decision deposit. Each account is read once, and again every ten minutes while it is shown,
 * so that a name that is cleared or judged erroneous does not keep its mark. An account that
 * could not be read is tried again with the next snapshot.
 */
export function useNames(snapshot: Snapshot | null): Names {
  const [names, setNames] = useState<Names>({ polkadot: {}, kusama: {} })
  // When each account was last read, or asked for.
  const read = useRef<Record<Network, Map<string, number>>>({
    polkadot: new Map(),
    kusama: new Map(),
  })

  useEffect(() => {
    if (!snapshot) return
    const now = Date.now()
    for (const network of NETWORK_IDS) {
      const done = read.current[network]
      const wanted = snapshot.proposals
        .flatMap((p) => [p.fellowship, p.open])
        .filter((stage) => stage?.network === network)
        .flatMap((stage) => [stage?.submitter, stage?.deposit.placed?.who])
        .filter((address): address is string => !!address)
        .filter((address) => now - (done.get(address) ?? -Infinity) >= STALE_MS)
      const fresh = [...new Set(wanted)]
      if (fresh.length === 0) continue
      fresh.forEach((address) => done.set(address, now))
      loadNames(network, fresh).then(
        (found) =>
          setNames((all) => {
            // An account that was read and has no identity now loses the name it had.
            const kept = Object.entries(all[network]).filter(
              ([address]) => !fresh.includes(address),
            )
            return { ...all, [network]: { ...Object.fromEntries(kept), ...found } }
          }),
        () => fresh.forEach((address) => done.delete(address)),
      )
    }
  }, [snapshot])

  return names
}
