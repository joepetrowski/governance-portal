// The chains that make up the Polkadot system. The UI presents them as one system; this registry
// is plumbing for knowing where to read state and how to decode calls.

import {
  assetHub,
  bridgeHub,
  bulletin,
  collectives,
  coretime,
  getMetadata,
  people,
  relay,
} from "@polkadot-api/descriptors"
import type { PolkadotClient } from "polkadot-api"
import { createWsClient } from "polkadot-api/ws"

/** Identifier of a chain in the Polkadot system, as used throughout the code. */
export type ChainId =
  "relay" | "assetHub" | "collectives" | "bridgeHub" | "people" | "coretime" | "bulletin"

interface ChainConfig {
  /** Display name, used as a label inside the unified view. */
  name: string
  /** `null` for the Relay Chain. */
  paraId: number | null
  /** Public RPC endpoints, in order of preference. Empty if none is known yet. */
  rpcs: string[]
  /** Runtime name as used in Fellowship release artifacts. */
  runtime: string
}

/** Name, parachain ID, endpoints, and runtime name of every chain in the system. */
export const CHAINS: Record<ChainId, ChainConfig> = {
  relay: {
    name: "Relay Chain",
    paraId: null,
    rpcs: [
      "wss://polkadot-rpc.n.dwellir.com",
      "wss://rpc-polkadot.luckyfriday.io",
      "wss://polkadot.api.onfinality.io/public-ws",
      "wss://polkadot-rpc.polkadot.io",
    ],
    runtime: "polkadot",
  },
  assetHub: {
    name: "Asset Hub",
    paraId: 1000,
    rpcs: [
      "wss://polkadot-asset-hub-rpc.polkadot.io",
      "wss://sys.ibp.network/asset-hub-polkadot",
      "wss://asset-hub-polkadot-rpc.dwellir.com",
    ],
    runtime: "asset-hub-polkadot",
  },
  collectives: {
    name: "Collectives",
    paraId: 1001,
    rpcs: [
      "wss://polkadot-collectives-rpc.polkadot.io",
      "wss://sys.ibp.network/collectives-polkadot",
    ],
    runtime: "collectives-polkadot",
  },
  bridgeHub: {
    name: "Bridge Hub",
    paraId: 1002,
    rpcs: ["wss://polkadot-bridge-hub-rpc.polkadot.io", "wss://sys.ibp.network/bridgehub-polkadot"],
    runtime: "bridge-hub-polkadot",
  },
  people: {
    name: "People",
    paraId: 1004,
    rpcs: ["wss://polkadot-people-rpc.polkadot.io", "wss://sys.ibp.network/people-polkadot"],
    runtime: "people-polkadot",
  },
  coretime: {
    name: "Coretime",
    paraId: 1005,
    rpcs: ["wss://polkadot-coretime-rpc.polkadot.io", "wss://sys.ibp.network/coretime-polkadot"],
    runtime: "coretime-polkadot",
  },
  bulletin: {
    name: "Bulletin",
    paraId: 1010,
    rpcs: [
      "wss://bulletin-rpc.polkadot.io",
      "wss://rpc-bulletin.luckyfriday.io",
      "wss://spectrum-03.simplystaking.xyz",
    ],
    runtime: "bulletin-polkadot",
  },
}

/** Every chain identifier, in the order the chains are listed and upgraded. */
export const CHAIN_IDS = Object.keys(CHAINS) as ChainId[]

/** The system chain with the given parachain ID, if there is one. */
export const chainByParaId = (paraId: number): ChainId | undefined =>
  CHAIN_IDS.find((id) => CHAINS[id].paraId === paraId)

const DESCRIPTORS = { relay, assetHub, collectives, bridgeHub, people, coretime, bulletin }

/**
 * Block time of the Relay Chain, in milliseconds. Public referenda count Relay Chain blocks, even
 * though they run on Asset Hub.
 */
export const RELAY_BLOCK_MS = 6_000
/**
 * Block time of Collectives, in milliseconds. Fellowship referenda count Collectives blocks (e.g.,
 * the 30-day fast-promotion decision period is 216,000 blocks).
 */
export const COLLECTIVES_BLOCK_MS = 12_000

const DECODE_TIMEOUT_MS = 20_000

const clients = new Map<ChainId, PolkadotClient>()

/** A lazily created client per chain. Throws if the chain has no known endpoint. */
export function getClient(chain: ChainId): PolkadotClient {
  let client = clients.get(chain)
  if (!client) {
    const { rpcs, name } = CHAINS[chain]
    if (rpcs.length === 0) throw new Error(`No RPC endpoint configured for ${name}`)
    // `getMetadata` lets the client use the bundled metadata when the on-chain code hash still
    // matches, instead of downloading it.
    client = createWsClient(rpcs, { getMetadata })
    clients.set(chain, client)
  }
  return client
}

/** Typed API of Asset Hub, which hosts public referenda, preimages, and the whitelist. */
export const assetHubApi = () => getClient("assetHub").getTypedApi(assetHub)
/** Typed API of Collectives, which hosts the Fellowship and its referenda. */
export const collectivesApi = () => getClient("collectives").getTypedApi(collectives)

/** Decode SCALE-encoded call data against a chain's live runtime. */
export async function decodeCallData(
  chain: ChainId,
  bytes: Uint8Array,
): Promise<{ type: string; value: { type: string; value: unknown } }> {
  const api = getClient(chain).getTypedApi(DESCRIPTORS[chain])
  // An unreachable endpoint must not stall everything else, so give up after a while.
  const tx = await Promise.race([
    api.txFromCallData(bytes),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out connecting to ${CHAINS[chain].name}`)),
        DECODE_TIMEOUT_MS,
      ),
    ),
  ])
  return tx.decodedCall as { type: string; value: { type: string; value: unknown } }
}
