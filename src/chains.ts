// The chains that make up the Polkadot and Kusama systems. The UI presents each network as one
// system; this registry is plumbing for knowing where to read state and how to decode calls.

import {
  assetHub,
  bridgeHub,
  bulletin,
  collectives,
  coretime,
  getMetadata,
  kusama,
  kusamaAssetHub,
  kusamaBridgeHub,
  kusamaCoretime,
  kusamaEncointer,
  kusamaPeople,
  people,
  relay,
} from "@polkadot-api/descriptors"
import type { PolkadotClient } from "polkadot-api"
import { createWsClient } from "polkadot-api/ws"

/** A network: a relay chain with its system parachains, governed as one. */
export type Network = "polkadot" | "kusama"

/** What differs between the networks beyond their chains. */
export const NETWORKS: Record<
  Network,
  {
    /** Display name. */
    name: string
    /** Symbol of the native token. */
    token: string
    /** Decimal places of the native token. */
    decimals: number
    /** The chain that hosts public referenda, preimages, and the whitelist. */
    assetHub: "assetHub" | "kusamaAssetHub"
    /** The network's name in XCM, as the `GlobalConsensus` junction spells it. */
    consensus: string
  }
> = {
  polkadot: {
    name: "Polkadot",
    token: "DOT",
    decimals: 10,
    assetHub: "assetHub",
    consensus: "Polkadot",
  },
  kusama: {
    name: "Kusama",
    token: "KSM",
    decimals: 12,
    assetHub: "kusamaAssetHub",
    consensus: "Kusama",
  },
}

/** Every network, Polkadot first. */
export const NETWORK_IDS = Object.keys(NETWORKS) as Network[]

/** Identifier of a system chain of either network, as used throughout the code. */
export type ChainId =
  | "relay"
  | "assetHub"
  | "collectives"
  | "bridgeHub"
  | "people"
  | "coretime"
  | "bulletin"
  | "kusama"
  | "kusamaAssetHub"
  | "kusamaEncointer"
  | "kusamaBridgeHub"
  | "kusamaPeople"
  | "kusamaCoretime"

interface ChainConfig {
  /** The network the chain belongs to. */
  network: Network
  /** Display name within its network, used as a label inside the unified view. */
  name: string
  /** `null` for the Relay Chain. */
  paraId: number | null
  /**
   * Public RPC endpoints, in order of preference. Empty if none is known yet. Each provider must
   * also be allowed by the content security policy in `netlify.toml`, or browsers block it.
   */
  rpcs: string[]
  /** Runtime name as used in Fellowship release artifacts. */
  runtime: string
}

/** Name, parachain ID, endpoints, and runtime name of every chain in the system. */
export const CHAINS: Record<ChainId, ChainConfig> = {
  relay: {
    network: "polkadot",
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
    network: "polkadot",
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
    network: "polkadot",
    name: "Collectives",
    paraId: 1001,
    rpcs: [
      "wss://polkadot-collectives-rpc.polkadot.io",
      "wss://sys.ibp.network/collectives-polkadot",
    ],
    runtime: "collectives-polkadot",
  },
  bridgeHub: {
    network: "polkadot",
    name: "Bridge Hub",
    paraId: 1002,
    rpcs: ["wss://polkadot-bridge-hub-rpc.polkadot.io", "wss://sys.ibp.network/bridgehub-polkadot"],
    runtime: "bridge-hub-polkadot",
  },
  people: {
    network: "polkadot",
    name: "People",
    paraId: 1004,
    rpcs: ["wss://polkadot-people-rpc.polkadot.io", "wss://sys.ibp.network/people-polkadot"],
    runtime: "people-polkadot",
  },
  coretime: {
    network: "polkadot",
    name: "Coretime",
    paraId: 1005,
    rpcs: ["wss://polkadot-coretime-rpc.polkadot.io", "wss://sys.ibp.network/coretime-polkadot"],
    runtime: "coretime-polkadot",
  },
  bulletin: {
    network: "polkadot",
    name: "Bulletin",
    paraId: 1010,
    rpcs: [
      "wss://bulletin-rpc.polkadot.io",
      "wss://rpc-bulletin.luckyfriday.io",
      "wss://spectrum-03.simplystaking.xyz",
    ],
    runtime: "bulletin-polkadot",
  },
  kusama: {
    network: "kusama",
    name: "Relay Chain",
    paraId: null,
    rpcs: [
      "wss://kusama-rpc.polkadot.io",
      "wss://kusama-rpc.n.dwellir.com",
      "wss://rpc-kusama.luckyfriday.io",
    ],
    runtime: "kusama",
  },
  kusamaAssetHub: {
    network: "kusama",
    name: "Asset Hub",
    paraId: 1000,
    rpcs: [
      "wss://kusama-asset-hub-rpc.polkadot.io",
      "wss://sys.ibp.network/asset-hub-kusama",
      "wss://asset-hub-kusama-rpc.n.dwellir.com",
    ],
    runtime: "asset-hub-kusama",
  },
  kusamaEncointer: {
    network: "kusama",
    name: "Encointer",
    paraId: 1001,
    rpcs: ["wss://kusama.api.encointer.org", "wss://sys.ibp.network/encointer-kusama"],
    runtime: "encointer-kusama",
  },
  kusamaBridgeHub: {
    network: "kusama",
    name: "Bridge Hub",
    paraId: 1002,
    rpcs: ["wss://kusama-bridge-hub-rpc.polkadot.io", "wss://sys.ibp.network/bridgehub-kusama"],
    runtime: "bridge-hub-kusama",
  },
  kusamaPeople: {
    network: "kusama",
    name: "People",
    paraId: 1004,
    rpcs: ["wss://kusama-people-rpc.polkadot.io", "wss://sys.ibp.network/people-kusama"],
    runtime: "people-kusama",
  },
  kusamaCoretime: {
    network: "kusama",
    name: "Coretime",
    paraId: 1005,
    rpcs: ["wss://kusama-coretime-rpc.polkadot.io", "wss://sys.ibp.network/coretime-kusama"],
    runtime: "coretime-kusama",
  },
}

/**
 * Every chain identifier. Within a network, the order is the Relay Chain and then the parachains
 * by ID, which is the order in which an upgrade lists them.
 */
export const CHAIN_IDS = Object.keys(CHAINS) as ChainId[]

/** The chains of one network, in the order of `CHAIN_IDS`. */
export const chainsOf = (network: Network): ChainId[] =>
  CHAIN_IDS.filter((id) => CHAINS[id].network === network)

/** The Relay Chain of a network. */
export const relayOf = (network: Network): ChainId => (network === "polkadot" ? "relay" : "kusama")

/** The system chain of the network with the given parachain ID, if there is one. */
export const chainByParaId = (network: Network, paraId: number): ChainId | undefined =>
  chainsOf(network).find((id) => CHAINS[id].paraId === paraId)

const DESCRIPTORS = {
  relay,
  assetHub,
  collectives,
  bridgeHub,
  people,
  coretime,
  bulletin,
  kusama,
  kusamaAssetHub,
  kusamaEncointer,
  kusamaBridgeHub,
  kusamaPeople,
  kusamaCoretime,
}

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

const polkadotAssetHubApi = () => getClient("assetHub").getTypedApi(assetHub)

/**
 * Typed API of a network's Asset Hub, which hosts its public referenda, preimages, and whitelist.
 *
 * Kusama Asset Hub is given the type of Polkadot Asset Hub. The governance pallets used here are
 * the same on both, and values are encoded against each chain's own metadata, so only the static
 * types are shared.
 */
export const assetHubApi = (network: Network = "polkadot") =>
  network === "polkadot"
    ? polkadotAssetHubApi()
    : (getClient("kusamaAssetHub").getTypedApi(kusamaAssetHub) as unknown as ReturnType<
        typeof polkadotAssetHubApi
      >)
/** Typed API of Collectives, which hosts the Fellowship and its referenda. */
export const collectivesApi = () => getClient("collectives").getTypedApi(collectives)

/** Give up on a chain that does not answer, so that it cannot stall everything else. */
const withTimeout = <T>(promise: Promise<T>, chainName: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out connecting to ${chainName}`)),
        DECODE_TIMEOUT_MS,
      ),
    ),
  ])

/** Decode SCALE-encoded call data against a chain's live runtime. */
export async function decodeCallData(
  chain: ChainId,
  bytes: Uint8Array,
): Promise<{ type: string; value: { type: string; value: unknown } }> {
  const api = getClient(chain).getTypedApi(DESCRIPTORS[chain])
  const tx = await withTimeout(api.txFromCallData(bytes), CHAINS[chain].name)
  return tx.decodedCall as { type: string; value: { type: string; value: unknown } }
}

/**
 * Whether `pallet.name` is a call of the chain's live runtime that accepts these arguments. Used
 * to tell a nested call apart from other values of the same shape, such as origins.
 */
export async function isRuntimeCall(
  chain: ChainId,
  pallet: string,
  name: string,
  args: unknown,
): Promise<boolean> {
  try {
    const tx = getClient(chain).getUnsafeApi().tx[pallet][name](args)
    await withTimeout(tx.getEncodedData(), CHAINS[chain].name)
    return true
  } catch {
    return false
  }
}
