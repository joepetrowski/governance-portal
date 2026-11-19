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

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`

export const shortHex = (hex: string) => (hex.length > 22 ? `${hex.slice(0, 10)}…${hex.slice(-8)}` : hex)
