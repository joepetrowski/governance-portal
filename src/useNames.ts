import { useEffect, useRef, useState } from "react"
import { type Network, NETWORK_IDS } from "./chains"
import { loadNames } from "./gov/identity"
import type { Snapshot } from "./gov/load"
import type { Names } from "./names"

/**
 * Identity names of the accounts that the snapshot shows: those that submitted a referendum or
 * placed its decision deposit. Each account is looked up once per visit. An account that could
 * not be read is tried again with the next snapshot.
 */
export function useNames(snapshot: Snapshot | null): Names {
  const [names, setNames] = useState<Names>({ polkadot: {}, kusama: {} })
  const read = useRef<Record<Network, Set<string>>>({ polkadot: new Set(), kusama: new Set() })

  useEffect(() => {
    if (!snapshot) return
    for (const network of NETWORK_IDS) {
      const done = read.current[network]
      const wanted = snapshot.proposals
        .flatMap((p) => [p.fellowship, p.open])
        .filter((stage) => stage?.network === network)
        .flatMap((stage) => [stage?.submitter, stage?.deposit.placed?.who])
        .filter((address): address is string => !!address && !done.has(address))
      const fresh = [...new Set(wanted)]
      if (fresh.length === 0) continue
      fresh.forEach((address) => done.add(address))
      loadNames(network, fresh).then(
        (found) => setNames((all) => ({ ...all, [network]: { ...all[network], ...found } })),
        () => fresh.forEach((address) => done.delete(address)),
      )
    }
  }, [snapshot])

  return names
}
