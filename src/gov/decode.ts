// Semantic call decoding. A call is decoded into a tree: calls nested on the same chain (batches,
// whitelist dispatch, scheduler, ...) and calls that XCM programs will `Transact` on other chains
// are all resolved into the call that actually executes, on the chain where it executes.
//
// The tree is what voters and signers read, so it must not leave anything out. Every XCM
// instruction becomes a node, not only `Transact`, and anything that cannot be followed is
// flagged as not decoded instead of being dropped.

import { Blake2256 } from "@polkadot-api/substrate-bindings"
import { toHex } from "polkadot-api/utils"
import {
  chainByParaId,
  type ChainId,
  CHAINS,
  decodeCallData,
  isRuntimeCall,
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
  /** Pallet name, as in the runtime's metadata. "XCM" for an XCM instruction. */
  pallet: string
  /** Call name, as in the runtime's metadata, or the name of the XCM instruction. */
  name: string
  /** Set when this node is an XCM instruction other than `Transact`, and not a call. */
  xcm?: true
  /** Names of the arguments whose content is shown as the children. */
  shownAsChildren?: string[]
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
 * that chain or over XCM. Never throws: A call that cannot be decoded becomes a node with
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
    const node = await fromDecoded({ id: chain.id }, decoded, skip)
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

const isXcmProgram = (v: unknown): v is { type: string; value: unknown[] } =>
  isTagged(v) && /^V\d+$/.test(v.type) && Array.isArray(v.value)

async function fromDecoded(
  chain: ChainRef & { id: ChainId },
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

  // A value has the shape of a call if it is an enum inside an enum, which is also the shape of
  // an origin and of other things. Under the conventional argument names it is taken as a call;
  // under any other name the runtime is asked whether it is one.
  const conventional = (key: string) => key === "call" || key === "calls" || key.endsWith("_call")
  const nestedCall = async (key: string, value: unknown): Promise<CallNode[] | null> => {
    if (!isCall(value)) return null
    const sure =
      conventional(key) ||
      (await isRuntimeCall(chain.id, value.type, value.value.type, value.value.value))
    return sure ? [await fromDecoded(chain, value, skip)] : null
  }

  // The children are decoded at the same time, since each may wait on a different chain. Their
  // order is kept.
  const perArg = Object.entries(args).map(async ([key, value]): Promise<CallNode[] | null> => {
    // XCM programs: `send` and the transfer calls execute them at `dest`, `execute` locally.
    if (isXcmProgram(value)) {
      const target = "dest" in args ? resolveLocation(chain, versioned(args.dest)) : chain
      return walkXcm(target, value.value, skip)
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isCall)) {
      const all = await Promise.all(value.map((inner) => nestedCall(key, inner)))
      return all.every((found) => found !== null) ? all.flat() : null
    }
    return nestedCall(key, value)
  })
  const found = await Promise.all(perArg)
  node.children = found.flatMap((children) => children ?? [])
  node.shownAsChildren = Object.keys(args).filter((_, i) => found[i] !== null)
  return node
}

/**
 * XCM instructions that neither move assets nor dispatch anything: They pay for execution, check
 * expectations, or tidy up. They are listed in the tree but do not count as what a proposal does.
 */
const XCM_PLUMBING = new Set([
  "UnpaidExecution",
  "BuyExecution",
  "PayFees",
  "RefundSurplus",
  "SetFeesMode",
  "ClearOrigin",
  "ClearError",
  "ClearTransactStatus",
  "ExpectOrigin",
  "ExpectError",
  "ExpectPallet",
  "ExpectAsset",
  "ExpectTransactStatus",
])

/** Whether the node is an XCM instruction with no effect of its own. */
export const isPlumbing = (node: CallNode) =>
  node.xcm === true && node.children.length === 0 && XCM_PLUMBING.has(node.name)

const mentionsTransact = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(mentionsTransact)
    : isRecord(value)
      ? value.type === "Transact" || Object.values(value).some(mentionsTransact)
      : false

/**
 * Turn an XCM program into nodes: the call of each `Transact`, decoded on the chain where the
 * program runs, and one node for every other instruction. Programs nested in an instruction are
 * followed, to another chain where the instruction sends them there.
 */
async function walkXcm(
  chain: ChainRef,
  instructions: unknown[],
  skip: Network[],
): Promise<CallNode[]> {
  const nodes = instructions.map(async (instruction): Promise<CallNode> => {
    if (!isTagged(instruction))
      return failed(chain, new Uint8Array(), "An XCM instruction of an unknown form")
    const value = instruction.value
    if (instruction.type === "Transact") {
      const bytes = isRecord(value) ? callBytes(value.call) : undefined
      if (!bytes) return failed(chain, new Uint8Array(), "A `Transact` without readable call data")
      const node = await decodeCall(chain, bytes, skip)
      if (isRecord(value) && isTagged(value.origin_kind))
        node.xcmOriginKind = value.origin_kind.type
      return node
    }

    const node: CallNode = {
      chain,
      pallet: "XCM",
      name: instruction.type,
      args: value,
      children: [],
      xcm: true,
    }
    // Nested programs: the instruction is one (`SetAppendix`, `SetErrorHandler`), or carries one
    // to run at a destination or after a transfer.
    if (Array.isArray(value) && value.every(isTagged)) {
      node.children = await walkXcm(chain, value, skip)
      node.args = undefined
    } else if (isRecord(value)) {
      const shown: string[] = []
      const destination = value.destination ?? value.dest ?? value.reserve
      const target = destination === undefined ? chain : resolveLocation(chain, destination)
      for (const key of ["xcm", "remote_xcm"]) {
        const nested = value[key]
        if (!Array.isArray(nested)) continue
        node.children.push(...(await walkXcm(target, nested, skip)))
        shown.push(key)
      }
      node.shownAsChildren = shown
      // A call anywhere else in the instruction is in a place this code does not know.
      const elsewhere = Object.entries(value).filter(([key]) => !shown.includes(key))
      if (elsewhere.some(([, v]) => mentionsTransact(v)))
        node.children.push(
          failed(chain, new Uint8Array(), "This instruction carries a call that was not followed"),
        )
    }
    return node
  })
  return Promise.all(nodes)
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

/**
 * Whether an XCM instruction with a nested program only carries that program: It moves no assets
 * and has no other effect of its own.
 */
function onlyCarries(node: CallNode): boolean {
  if (["SetAppendix", "SetErrorHandler", "ExecuteWithOrigin"].includes(node.name)) return true
  if (node.name !== "InitiateTransfer" || !isRecord(node.args)) return false
  const { assets, remote_fees } = node.args
  return Array.isArray(assets) && assets.length === 0 && remote_fees === undefined
}

/**
 * What a call does in the end: every node of its tree that leads to nothing further, and every
 * XCM instruction that does something besides carrying a nested program. XCM instructions with no
 * effect of their own are left out. A call that could not be decoded counts, since what it does is
 * unknown.
 */
export const effects = (node: CallNode): CallNode[] =>
  [...walk(node)].filter((n) =>
    n.children.length === 0 ? !isPlumbing(n) : n.xcm === true && !onlyCarries(n),
  )
