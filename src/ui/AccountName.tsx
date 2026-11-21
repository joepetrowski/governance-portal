import { useState } from "react"
import type { Network } from "../chains"
import type { Standing } from "../gov/identity"
import { useName } from "../names"
import { Short } from "./Short"

const LABELS: Record<Standing, string> = {
  confirmed: "Identity confirmed by a registrar",
  none: "Identity not confirmed by a registrar",
  negative: "A registrar judged this identity low quality or erroneous",
}

const COLORS: Record<Standing, string> = {
  confirmed: "text-emerald-600 dark:text-emerald-400",
  none: "text-zinc-500 dark:text-zinc-400",
  negative: "text-red-600 dark:text-red-400",
}

/**
 * Marks a name with its standing: a check, a question mark, or a warning. Each has its own shape
 * as well as color. They are drawn, so that text in a name cannot imitate them.
 */
function Mark({ standing }: { standing: Standing }) {
  const line = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const
  // What is drawn on a filled shape takes the color of the page.
  const inner = "stroke-white dark:stroke-zinc-950"
  return (
    <svg
      role="img"
      aria-label={LABELS[standing]}
      viewBox="0 0 16 16"
      className={`ml-1 inline h-3.5 w-3.5 align-[-0.125em] ${COLORS[standing]}`}
    >
      <title>{LABELS[standing]}</title>
      {standing === "confirmed" && (
        <>
          <circle cx="8" cy="8" r="8" fill="currentColor" />
          <path d="M4.5 8.3l2.3 2.3 4.7-5" {...line} className={inner} strokeWidth="1.8" />
        </>
      )}
      {standing === "none" && (
        <g {...line} stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="7" />
          <path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.8c-.6.3-.9.7-.9 1.4" />
          <path d="M8 11.7v.01" strokeWidth="1.8" />
        </g>
      )}
      {standing === "negative" && (
        <>
          <path
            d="M8 1.2 15.3 14.3H.7z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path d="M8 6v4M8 12.3v.01" {...line} className={inner} strokeWidth="1.8" />
        </>
      )}
    </svg>
  )
}

/**
 * An account, shown by its identity name on the network if it has one, and by its shortened
 * address otherwise. Every name carries a mark of its standing with registrars. Activating a name
 * shows the address with it, since a name is only what its owner chose.
 */
export function AccountName({ address, network }: { address: string; network: Network }) {
  const identity = useName(network, address)
  const [full, setFull] = useState(false)
  if (!identity) return <Short value={address} />
  return (
    <button
      type="button"
      aria-expanded={full}
      title={full ? "Hide the address" : "Show the address"}
      className="break-all text-left underline decoration-dotted underline-offset-2"
      onClick={() => setFull(!full)}
    >
      {identity.name}
      <Mark standing={identity.standing} />
      {full && <span className="font-mono"> ({address})</span>}
    </button>
  )
}
