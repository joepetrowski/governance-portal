import { createContext, useContext } from "react"
import type { Actor, MemberProxies } from "./gov/proxy"
import type { AccountStatus } from "./gov/votes"

/** An actor with everything that is known of its account. */
export type FellowshipActor = Actor<AccountStatus>

/** Who acts in the Fellowship for the wallet, directly and by proxy. */
export interface Fellowship {
  /** Who acts when the selected account signs. Null until that account has been read. */
  actor: FellowshipActor | null
  /** Whom the selected account can act as. */
  options: FellowshipActor[]
  /** Choose one of `options`, by the address of its account. */
  choose: (address: string) => void
  /** Every member that some account of the wallet can act for, with what is known of it. */
  members: FellowshipActor[]
  /** Proxies that cannot be used because they have a delay. */
  delayed: MemberProxies["delayed"]
}

/** Carries who acts in the Fellowship to the controls that vote and open referenda there. */
export const FellowshipContext = createContext<Fellowship>({
  actor: null,
  options: [],
  choose: () => {},
  members: [],
  delayed: [],
})

/** Who acts in the Fellowship for the wallet. */
export const useFellowship = (): Fellowship => useContext(FellowshipContext)
