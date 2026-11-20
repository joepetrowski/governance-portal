export const percent = (fraction: number) => {
  const pct = fraction * 100
  if (pct === 0 || pct >= 10) return `${pct.toFixed(1)}%`
  if (pct >= 0.1) return `${pct.toFixed(2)}%`
  return `${pct.toPrecision(2)}%`
}

/** A duration such as "3d 4h", from a number of blocks. */
export function duration(blocks: number, blockMs: number): string {
  const minutes = Math.max(0, Math.round((blocks * blockMs) / 60_000))
  if (minutes < 1) return "under a minute"
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** Time of day on the 24-hour clock, e.g., "19:22". */
export const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })

const AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."]

/** A date and time such as "Dec. 1, 14:05", with the year when it is not the current one. */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear() === new Date().getFullYear() ? "" : `, ${date.getFullYear()}`
  return `${AP_MONTHS[date.getMonth()]} ${date.getDate()}${year}, ${formatTime(timestamp)}`
}

/** A list in prose, with the serial comma: "A, B, and C". */
export const formatList = (items: string[]) =>
  new Intl.ListFormat("en-US", { type: "conjunction" }).format(items)

export const DOT_DECIMALS = 10
const PLANCK_PER_DOT = 10n ** BigInt(DOT_DECIMALS)

/** A compact amount such as "26.4K DOT". */
export const formatDot = (planck: bigint) =>
  `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    Number(planck / PLANCK_PER_DOT) + Number(planck % PLANCK_PER_DOT) / Number(PLANCK_PER_DOT),
  )} DOT`

/** Parse a decimal DOT amount typed by a user. Returns null if it is not a valid amount. */
export function parseDot(input: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{0,10}))?$/.exec(input.trim().replaceAll(",", ""))
  if (!match) return null
  const [, whole, fraction = ""] = match
  return BigInt(whole) * PLANCK_PER_DOT + BigInt(fraction.padEnd(DOT_DECIMALS, "0"))
}

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`

export const shortHex = (hex: string) => (hex.length > 22 ? `${hex.slice(0, 10)}…${hex.slice(-8)}` : hex)
