import { useState } from "react"
import { shortAddress, shortHex } from "./format"

/**
 * A hash or an address, shortened to its ends. Activating it shows the whole value, so that it can
 * be read, compared, and copied with a keyboard or a touch screen as well as with a mouse.
 */
export function Short({ value }: { value: string }) {
  const [full, setFull] = useState(false)
  const short = value.startsWith("0x") ? shortHex(value) : shortAddress(value)
  return (
    <button
      type="button"
      aria-expanded={full}
      title={full ? "Shorten" : "Show in full"}
      className="break-all text-left font-mono underline decoration-dotted underline-offset-2"
      onClick={() => setFull(!full)}
    >
      {full ? value : short}
    </button>
  )
}
