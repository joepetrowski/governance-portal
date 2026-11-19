// Semantic call decoding. A call is decoded into a tree: calls nested on the same chain (batches,
// whitelist dispatch, scheduler, ...) and calls that XCM programs will `Transact` on other chains
// are all resolved into the call that actually executes, on the chain where it executes.

import { Blake2256 } from "@polkadot-api/substrate-bindings"
import { toHex } from "polkadot-api/utils"
import { chainByParaId, type ChainId, CHAINS, decodeCallData } from "../chains"

/** Where a call executes: one of the system chains, or somewhere we can only describe. */
export type ChainRef = { id: ChainId } | { external: string }

export interface CallNode {
  chain: ChainRef
  pallet: string
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

export const chainLabel = (ref: ChainRef) => ("id" in ref ? CHAINS[ref.id].name : ref.external)

export const blake2Hex = (bytes: Uint8Array) => toHex(Blake2256(bytes))

type Tagged = { type: string; value?: unknown }
const isTagged = (v: unknown): v is Tagged =>
  typeof v === "object" && v !== null && typeof (v as Tagged).type === "string"
const isCall = (v: unknown): v is { type: string; value: Tagged } =>
  isTagged(v) && isTagged(v.value)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)

export async function decodeCall(chain: ChainRef, bytes: Uint8Array): Promise<CallNode> {
  if (!("id" in chain))
    return failed(chain, bytes, `Calls on ${chain.external} are not decoded yet`)
  try {
    const decoded = await decodeCallData(chain.id, bytes)
    const node = await fromDecoded(chain, decoded)
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

  // Calls nested on the same chain: by convention these arguments are named `call` or `calls`.
  for (const [key, value] of Object.entries(args)) {
    if (key === "calls" && Array.isArray(value)) {
      for (const inner of value)
        if (isCall(inner)) node.children.push(await fromDecoded(chain, inner))
    } else if (isCall(value) && (key === "call" || key.endsWith("_call"))) {
      node.children.push(await fromDecoded(chain, value))
    }
  }

  // XCM programs: `send` executes them at `dest`, `execute` locally.
  const message = args.message
  if (isTagged(message) && Array.isArray(message.value)) {
    const target = "dest" in args ? resolveLocation(chain, versioned(args.dest)) : chain
    node.children.push(...(await walkXcm(target, message.value)))
  }
  return node
}

/** Find every call an XCM program dispatches, following onward transfers to further chains. */
async function walkXcm(chain: ChainRef, instructions: unknown[]): Promise<CallNode[]> {
  const out: CallNode[] = []
  for (const instruction of instructions) {
    if (!isTagged(instruction) || !isRecord(instruction.value)) continue
    const value = instruction.value
    if (instruction.type === "Transact") {
      const bytes = callBytes(value.call)
      if (!bytes) continue
      const node = await decodeCall(chain, bytes)
      node.xcmOriginKind = isTagged(value.origin_kind) ? value.origin_kind.type : undefined
      out.push(node)
      continue
    }
    // Instructions that forward a nested program to another location.
    const nested = value.remote_xcm ?? value.xcm
    const destination = value.destination ?? value.dest
    if (Array.isArray(nested) && destination !== undefined)
      out.push(...(await walkXcm(resolveLocation(chain, destination), nested)))
  }
  return out
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
  const junctions: Tagged[] = !isTagged(interior) || interior.type === "Here"
    ? []
    : ((Array.isArray(interior.value) ? interior.value : [interior.value]) as Tagged[])
  const fromRelay = CHAINS[from.id].paraId === null

  const para = (n: unknown): ChainRef => {
    const id = chainByParaId(Number(n))
    return id ? { id } : { external: `Polkadot parachain ${n}` }
  }

  if (parents === 0) {
    if (junctions.length === 0) return from
    if (fromRelay && junctions.length === 1 && junctions[0].type === "Parachain")
      return para(junctions[0].value)
  }
  if (parents === 1 && !fromRelay) {
    if (junctions.length === 0) return { id: "relay" }
    if (junctions.length === 1 && junctions[0].type === "Parachain") return para(junctions[0].value)
  }
  // Another consensus system, reached over a bridge.
  const [first, second] = junctions
  if (first?.type === "GlobalConsensus" && isTagged(first.value)) {
    const network = first.value.type
    if (!second) return { external: network }
    if (second.type === "Parachain") {
      const name = Number(second.value) === 1000 ? "Asset Hub" : `parachain ${second.value}`
      return { external: `${network} ${name}` }
    }
  }
  return unknown
}

/** Depth-first search over a call tree. */
export function* walk(node: CallNode): Generator<CallNode> {
  yield node
  for (const child of node.children) yield* walk(child)
}

export const isCallTo = (node: CallNode, pallet: string, name: string) =>
  !node.undecoded && node.pallet === pallet && node.name === name
