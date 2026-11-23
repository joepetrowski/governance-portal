import { useSyncExternalStore } from "react"
import { parseAnchor } from "./gov/load"

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange)
  return () => window.removeEventListener("hashchange", onChange)
}

/**
 * The referendum that the address of the page links to, as an anchor such as "polkadot-1973". Null
 * if the address names none. Follows the address as it changes.
 *
 * The anchor is built from what the address names, not taken from it, so that an index written
 * differently, such as "polkadot-01973", is the same anchor.
 */
export function useAnchor(): string | null {
  const named = parseAnchor(useSyncExternalStore(subscribe, () => window.location.hash.slice(1)))
  return named ? `${named.where}-${named.index}` : null
}
