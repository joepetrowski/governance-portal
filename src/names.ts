import { createContext, useContext } from "react"
import type { Network } from "./chains"
import type { AccountIdentity } from "./gov/identity"

/** Identities of accounts, by network and address. */
export type Names = Record<Network, Record<string, AccountIdentity>>

/** Carries the identity names that have been read to wherever an account is shown. */
export const NamesContext = createContext<Names>({ polkadot: {}, kusama: {} })

/** The identity of an account on a network, if it has one and it has been read. */
export const useName = (network: Network, address: string): AccountIdentity | undefined =>
  useContext(NamesContext)[network][address]
