// Semantic call decoding. A call is decoded into a tree: calls nested on the same chain (batches,
// whitelist dispatch, scheduler, ...) and calls that XCM programs will `Transact` on other chains
// are all resolved into the call that actually executes, on the chain where it executes.

import { Blake2256 } from "@polkadot-api/substrate-bindings"
import { toHex } from "polkadot-api/utils"
import {
  chainByParaId,
  type ChainId,
  CHAINS,
  decodeCallData,
  NETWORK_IDS,
  NETWORKS,
  type Network,
  relayOf,
} from "../chains"

/** Where a call executes: one of the system chains, or somewhere we can only describe. */
export type ChainRef = { id: ChainId } | { external: string }

/** A decoded call, with the calls it leads to as its children. */
export interface CallNode {
  /** The chain on which this call executes. */
  chain: ChainRef
  /** Pallet name, as in the runtime's metadata. */
  pallet: string
  /** Call name, as in the runtime's metadata. */
  name: string
  /** Decoded arguments, with nested calls and XCM programs left in place. */
  args: unknown
  /** Calls this call will dispatch, locally or on other chains. */
  children: CallNode[]
  /** Set when this call is reached through an XCM `Transact`. */
  xcmOriginKind?: string
  /** Encoded call data, when known (roots and XCM payloads). */
  bytes?: Uint8Array
  /** Set instead of pallet/name/args being meaningful when the call could not be decoded. */
  undecoded?: string
}

/** Display name of the chain, or the description of a place outside the system. */
export const chainLabel = (ref: ChainRef) =>
  "id" in ref
    ? `${CHAINS[ref.id].network === "kusama" ? "Kusama " : ""}${CHAINS[ref.id].name}`
    : ref.external

/** BLAKE2b-256 hash of the bytes, as hex with a `0x` prefix. */
export const blake2Hex = (bytes: Uint8Array) => toHex(Blake2256(bytes))

type Tagged = { type: string; value?: unknown }
const isTagged = (v: unknown): v is Tagged =>
  typeof v === "object" && v !== null && typeof (v as Tagged).type === "string"
const isCall = (v: unknown): v is { type: string; value: Tagged } =>
  isTagged(v) && isTagged(v.value)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)

/** Why a call is undecoded when its network was left out of the decoding on purpose. */
export const NOT_LOADED = "Not loaded yet"

/**
 * Decode call data against the live runtime of the chain, and follow every call it dispatches, on
 * that chain or over XCM. Never throws: a call that cannot be decoded becomes a node with
 * `undecoded` set. Calls on a chain of a network in `skip` are left undecoded without connecting
 * to it, with `NOT_LOADED` as the reason.
 */
export async function decodeCall(
  chain: ChainRef,
  bytes: Uint8Array,
  skip: Network[] = [],
): Promise<CallNode> {
  if (!("id" in chain))
    return failed(chain, bytes, `Calls on ${chain.external} are not decoded yet`)
  if (skip.includes(CHAINS[chain.id].network)) return failed(chain, bytes, NOT_LOADED)
  try {
    const decoded = await decodeCallData(chain.id, bytes)
    const node = await fromDecoded(chain, decoded, skip)
    node.bytes = bytes
    return node
  } catch (e) {
    return failed(chain, bytes, e instanceof Error ? e.message : String(e))
  }
}

const failed = (chain: ChainRef, bytes: Uint8Array, reason: string): CallNode => ({
  chain,
  pallet: "",
  name: "",
  args: undefined,
  children: [],
  bytes,
  undecoded: reason,
})

async function fromDecoded(
  chain: ChainRef,
  decoded: { type: string; value: Tagged },
  skip: Network[],
): Promise<CallNode> {
  const args = decoded.value.value
  const node: CallNode = {
    chain,
    pallet: decoded.type,
    name: decoded.value.type,
    args,
    children: [],
  }
  if (!isRecord(args)) return node

  // The children are decoded at the same time, since each may wait on a different chain. Their
  // order is kept.
  const children: Promise<CallNode[]>[] = []
  const one = (inner: { type: string; value: Tagged }) =>
    fromDecoded(chain, inner, skip).then((child) => [child])

  // Calls nested on the same chain: by convention these arguments are named `call` or `calls`.
  for (const [key, value] of Object.entries(args)) {
    if (key === "calls" && Array.isArray(value)) children.push(...value.filter(isCall).map(one))
    else if (isCall(value) && (key === "call" || key.endsWith("_call"))) children.push(one(value))
  }

  // XCM programs: `send` executes them at `dest`, `execute` locally.
  const message = args.message
  if (isTagged(message) && Array.isArray(message.value)) {
    const target = "dest" in args ? resolveLocation(chain, versioned(args.dest)) : chain
    children.push(walkXcm(target, message.value, skip))
  }
  node.children = (await Promise.all(children)).flat()
  return node
}

/** Find every call an XCM program dispatches, following onward transfers to further chains. */
async function walkXcm(
  chain: ChainRef,
  instructions: unknown[],
  skip: Network[],
): Promise<CallNode[]> {
  const found = instructions.map(async (instruction): Promise<CallNode[]> => {
    if (!isTagged(instruction) || !isRecord(instruction.value)) return []
    const value = instruction.value
    if (instruction.type === "Transact") {
      const bytes = callBytes(value.call)
      if (!bytes) return []
      const node = await decodeCall(chain, bytes, skip)
      node.xcmOriginKind = isTagged(value.origin_kind) ? value.origin_kind.type : undefined
      return [node]
    }
    // Instructions that forward a nested program to another location.
    const nested = value.remote_xcm ?? value.xcm
    const destination = value.destination ?? value.dest
    if (Array.isArray(nested) && destination !== undefined)
      return walkXcm(resolveLocation(chain, destination), nested, skip)
    return []
  })
  return (await Promise.all(found)).flat()
}

function callBytes(call: unknown): Uint8Array | undefined {
  if (call instanceof Uint8Array) return call
  if (isRecord(call) && call.encoded instanceof Uint8Array) return call.encoded
  return undefined
}

const versioned = (location: unknown) =>
  isTagged(location) && /^V\d+$/.test(location.type) ? location.value : location

/** Resolve an XCM location, relative to `from`, to the chain it names. */
export function resolveLocation(from: ChainRef, location: unknown): ChainRef {
  const unknown: ChainRef = { external: "an unrecognized location" }
  if (!("id" in from) || !isRecord(location)) return unknown
  const parents = Number(location.parents)
  const interior = location.interior
  const junctions: Tagged[] =
    !isTagged(interior) || interior.type === "Here"
      ? []
      : ((Array.isArray(interior.value) ? interior.value : [interior.value]) as Tagged[])
  const { network, paraId } = CHAINS[from.id]
  const fromRelay = paraId === null

  const within = (net: Network, rest: Tagged[]): ChainRef => {
    if (rest.length === 0) return { id: relayOf(net) }
    if (rest.length !== 1 || rest[0].type !== "Parachain") return unknown
    const id = chainByParaId(net, Number(rest[0].value))
    return id ? { id } : { external: `${NETWORKS[net].name} parachain ${rest[0].value}` }
  }

  if (parents === 0 && junctions.length === 0) return from
  if (parents === 0 && fromRelay) return within(network, junctions)
  if (parents === 1 && !fromRelay) return within(network, junctions)

  // Another consensus system, reached over a bridge. The path climbs out of this network first.
  const [first, ...rest] = junctions
  const climbs = parents === (fromRelay ? 1 : 2)
  if (climbs && first?.type === "GlobalConsensus" && isTagged(first.value)) {
    const consensus = first.value.type
    const other = NETWORK_IDS.find((n) => NETWORKS[n].consensus === consensus)
    if (other) return within(other, rest)
    return { external: rest.length === 0 ? consensus : `a chain of ${consensus}` }
  }
  return unknown
}

/** Depth-first search over a call tree. */
export function* walk(node: CallNode): Generator<CallNode> {
  yield node
  for (const child of node.children) yield* walk(child)
}

/** Whether the node is a decoded call to `pallet.name`. */
export const isCallTo = (node: CallNode, pallet: string, name: string) =>
  !node.undecoded && node.pallet === pallet && node.name === name
