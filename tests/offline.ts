// Stand-ins for the two functions of `src/chains.ts` that talk to a chain, so that the tests can
// decode calls without a network. They decode against the metadata bundled in `.papi/metadata`,
// which is what the page itself uses for as long as the chains have not been upgraded past it.

import { readFileSync } from "node:fs"
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders"
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings"
import type { ChainId } from "../src/chains"

type Decoded = { type: string; value: { type: string; value: unknown } }

const builders = new Map<ChainId, ReturnType<typeof builderFor>>()

function builderFor(chain: ChainId) {
  const metadata = unifyMetadata(decAnyMetadata(readFileSync(`.papi/metadata/${chain}.scale`)))
  const lookup = getLookupFn(metadata)
  if (lookup.call === null) throw new Error(`The metadata of ${chain} names no call type`)
  const dynamic = getDynamicBuilder(lookup)
  return { dynamic, call: dynamic.buildDefinition(lookup.call) }
}

const builder = (chain: ChainId) => {
  let found = builders.get(chain)
  if (!found) builders.set(chain, (found = builderFor(chain)))
  return found
}

/** Offline version of `decodeCallData`. */
export async function decodeCallData(chain: ChainId, bytes: Uint8Array): Promise<Decoded> {
  return builder(chain).call.dec(bytes) as Decoded
}

/** Offline version of `isRuntimeCall`. */
export async function isRuntimeCall(
  chain: ChainId,
  pallet: string,
  name: string,
  args: unknown,
): Promise<boolean> {
  try {
    builder(chain).dynamic.buildCall(pallet, name).codec.enc(args)
    return true
  } catch {
    return false
  }
}
