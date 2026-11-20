import { type Network, NETWORKS } from "../chains"

/** A fraction in [0, 1] as a percentage, with more digits the smaller it is. */
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

const AP_MONTHS = [
  "Jan.",
  "Feb.",
  "March",
  "April",
  "May",
  "June",
  "July",
  "Aug.",
  "Sept.",
  "Oct.",
  "Nov.",
  "Dec.",
]

/** A date and time such as "Dec. 1, 14:05", with the year when it is not the current one. */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear() === new Date().getFullYear() ? "" : `, ${date.getFullYear()}`
  return `${AP_MONTHS[date.getMonth()]} ${date.getDate()}${year}, ${formatTime(timestamp)}`
}

/** A list in prose, with the serial comma: "A, B, and C". */
export const formatList = (items: string[]) =>
  new Intl.ListFormat("en-US", { type: "conjunction" }).format(items)

const unit = (network: Network) => 10n ** BigInt(NETWORKS[network].decimals)

/**
 * A compact amount of a network's token, such as "26.4K DOT". Amounts below one keep two
 * significant digits, so that a small deposit does not read as zero.
 */
export function formatBalance(planck: bigint, network: Network): string {
  const amount =
    Number(planck / unit(network)) + Number(planck % unit(network)) / Number(unit(network))
  const digits =
    amount > 0 && amount < 1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 }
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", ...digits })
  return `${compact.format(amount)} ${NETWORKS[network].token}`
}

/**
 * An amount of a network's token in full, without rounding, such as "1,234.5 DOT". For amounts
 * that a user is about to commit, where the compact form could mislead.
 */
export function formatExact(planck: bigint, network: Network): string {
  const { decimals, token } = NETWORKS[network]
  const whole = (planck / unit(network)).toLocaleString("en-US")
  const fraction = (planck % unit(network)).toString().padStart(decimals, "0").replace(/0+$/, "")
  return `${whole}${fraction ? `.${fraction}` : ""} ${token}`
}

/**
 * Parse a decimal amount of a network's token typed by a user. Returns null if it is not a valid
 * amount. Only digits and a period are accepted: A comma could be meant as a decimal mark or as a
 * thousands separator, and guessing wrong would change the amount tenfold or more.
 */
export function parseBalance(input: string, network: Network): bigint | null {
  const { decimals } = NETWORKS[network]
  const match = /^(\d+)(?:\.(\d*))?$/.exec(input.trim())
  if (!match) return null
  const [, whole, fraction = ""] = match
  if (fraction.length > decimals) return null
  return BigInt(whole) * unit(network) + BigInt(fraction.padEnd(decimals, "0"))
}

/** An address shortened to its first and last six characters. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`

/** A hex string shortened in the middle, if it is long. */
export const shortHex = (hex: string) =>
  hex.length > 22 ? `${hex.slice(0, 10)}…${hex.slice(-8)}` : hex
