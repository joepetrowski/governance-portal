// Threshold curves from pallet-referenda, evaluated in floating point for display.
// All inputs and outputs are fractions in [0, 1].

const PERBILL = 1e9

export type Curve =
  | { type: "LinearDecreasing"; value: { length: number; floor: number; ceil: number } }
  | { type: "SteppedDecreasing"; value: { begin: number; end: number; step: number; period: number } }
  | { type: "Reciprocal"; value: { factor: bigint; x_offset: bigint; y_offset: bigint } }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** The threshold required at `x`, the elapsed fraction of the decision period. */
export function threshold(curve: Curve, x: number): number {
  x = clamp01(x)
  switch (curve.type) {
    case "LinearDecreasing": {
      const length = curve.value.length / PERBILL
      const floor = curve.value.floor / PERBILL
      const ceil = curve.value.ceil / PERBILL
      return ceil - (Math.min(x, length) / length) * (ceil - floor)
    }
    case "SteppedDecreasing": {
      const { begin, end, step, period } = curve.value
      const steps = Math.floor((x * PERBILL) / period)
      return Math.max(end, begin - step * steps) / PERBILL
    }
    case "Reciprocal": {
      const factor = Number(curve.value.factor) / PERBILL
      const xOffset = Number(curve.value.x_offset) / PERBILL
      const yOffset = Number(curve.value.y_offset) / PERBILL
      return clamp01(factor / (x + xOffset) + yOffset)
    }
  }
}

/**
 * The earliest `x` at which the (monotonically decreasing) curve drops to `y` or below, or null
 * if it never does within the decision period.
 */
export function delay(curve: Curve, y: number): number | null {
  if (threshold(curve, 0) <= y) return 0
  if (threshold(curve, 1) > y) return null
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (threshold(curve, mid) <= y) hi = mid
    else lo = mid
  }
  return hi
}
