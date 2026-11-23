import { useSyncExternalStore } from "react"
import { parseAnchor } from "./gov/load"

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange)
  return () => window.removeEventListener("hashchange", onChange)
}

/**
 * The referendum that the address of the page links to, as an anchor such as "polkadot-1973". Null
 * if the address names none. Follows the address as it changes.
 */
export function useAnchor(): string | null {
  const anchor = useSyncExternalStore(subscribe, () => window.location.hash.slice(1))
  return parseAnchor(anchor) ? anchor : null
}
