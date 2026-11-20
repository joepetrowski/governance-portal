import { describe, expect, it } from "vitest"
import { type Curve, delay, threshold } from "../src/gov/curves"

const PERBILL = 1_000_000_000

const linear: Curve = {
  type: "LinearDecreasing",
  value: { length: PERBILL, floor: PERBILL / 2, ceil: PERBILL },
}
const stepped: Curve = {
  type: "SteppedDecreasing",
  value: { begin: PERBILL, end: PERBILL / 2, step: PERBILL / 10, period: PERBILL / 5 },
}
// The whitelisted caller support curve of Polkadot: reciprocal from 50% down to 0.01%.
const reciprocal: Curve = {
  type: "Reciprocal",
  value: { factor: 270_899n, x_offset: 541_799n, y_offset: -170_899n },
}

describe("threshold", () => {
  it("falls linearly from the ceiling to the floor", () => {
    expect(threshold(linear, 0)).toBeCloseTo(1)
    expect(threshold(linear, 0.5)).toBeCloseTo(0.75)
    expect(threshold(linear, 1)).toBeCloseTo(0.5)
  })

  it("falls in steps", () => {
    expect(threshold(stepped, 0)).toBeCloseTo(1)
    expect(threshold(stepped, 0.19)).toBeCloseTo(1)
    expect(threshold(stepped, 0.2)).toBeCloseTo(0.9)
    expect(threshold(stepped, 1)).toBeCloseTo(0.5)
  })

  it("never rises as time passes", () => {
    for (const curve of [linear, stepped, reciprocal]) {
      let last = Infinity
      for (let x = 0; x <= 1; x += 0.05) {
        const y = threshold(curve, x)
        expect(y).toBeLessThanOrEqual(last + 1e-9)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(1)
        last = y
      }
    }
  })
})

describe("delay", () => {
  it("is the point at which the threshold falls to a value", () => {
    for (const curve of [linear, reciprocal]) {
      for (const x of [0.1, 0.4, 0.8]) {
        const y = threshold(curve, x)
        const back = delay(curve, y)
        expect(back).not.toBeNull()
        expect(back as number).toBeCloseTo(x, 2)
      }
    }
  })

  it("is zero for a value already above the curve, and null for one never reached", () => {
    expect(delay(linear, 1)).toBe(0)
    expect(delay(linear, 0.4)).toBeNull()
  })
})
