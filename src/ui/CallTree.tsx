import { toHex } from "polkadot-api/utils"
import { type CallNode, chainLabel, isCallTo } from "../gov/decode"
import { shortHex } from "./format"

// Arguments that the tree already shows as child calls.
const SHOWN_AS_CHILDREN = new Set(["call", "calls", "message", "dest"])

function formatValue(value: unknown): string {
  if (value instanceof Uint8Array) return shortHex(toHex(value))
  if (typeof value === "string") return value.startsWith("0x") ? shortHex(value) : value
  if (typeof value === "bigint") return value.toLocaleString("en")
  if (typeof value === "number") return value.toLocaleString("en")
  if (value === undefined || value === null) return "none"
  if (typeof value !== "object") return String(value)
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`
  const tagged = value as { type?: unknown; value?: unknown }
  if (
    typeof tagged.type === "string" &&
    Object.keys(value).every((k) => k === "type" || k === "value")
  )
    return tagged.value === undefined ? tagged.type : `${tagged.type}(${formatValue(tagged.value)})`
  return `{ ${Object.entries(value)
    .map(([k, v]) => `${k}: ${formatValue(v)}`)
    .join(", ")} }`
}

// A `send` is plumbing: what matters is the call it delivers and where.
const isTransport = (node: CallNode) =>
  node.children.length > 0 &&
  (isCallTo(node, "PolkadotXcm", "send") || isCallTo(node, "XcmPallet", "send"))

function Node({ node }: { node: CallNode }) {
  if (isTransport(node))
    return (
      <>
        {node.children.map((child, i) => (
          <Node key={i} node={child} />
        ))}
      </>
    )

  const args =
    typeof node.args === "object" && node.args !== null && !Array.isArray(node.args)
      ? Object.entries(node.args).filter(([key]) => !SHOWN_AS_CHILDREN.has(key))
      : []

  return (
    <li className="py-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-medium dark:bg-zinc-800">
          {chainLabel(node.chain)}
        </span>
        {node.undecoded ? (
          <span className="text-sm text-amber-700 dark:text-amber-400">
            Not decoded: {node.undecoded}
            {node.bytes && (
              <span className="ml-2 font-mono text-xs">{shortHex(toHex(node.bytes))}</span>
            )}
          </span>
        ) : (
          <span className="font-mono text-sm">
            {node.pallet}.{node.name}
          </span>
        )}
        {node.xcmOriginKind && (
          <span className="text-xs text-zinc-500">as {node.xcmOriginKind}</span>
        )}
      </div>
      {args.length > 0 && (
        <dl className="mt-0.5 ml-1 text-xs text-zinc-600 dark:text-zinc-400">
          {args.map(([key, value]) => (
            <div key={key} className="flex gap-1.5">
              <dt>{key}:</dt>
              <dd className="font-mono break-all">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {node.children.length > 0 && (
        <ul className="mt-1 ml-2 border-l border-zinc-300 pl-3 dark:border-zinc-700">
          {node.children.map((child, i) => (
            <Node key={i} node={child} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** A call and everything it dispatches, as a nested list with each call's chain and arguments. */
export function CallTree({ call }: { call: CallNode }) {
  return (
    <ul>
      <Node node={call} />
    </ul>
  )
}
