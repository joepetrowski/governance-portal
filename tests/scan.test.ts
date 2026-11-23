// Finding the ongoing referenda without reading every referendum ever submitted.

import { describe, expect, it } from "vitest"
import { type ScannedInfo, scanOngoing } from "../src/gov/load"

const ROOT = 0
const ended = (at: number): ScannedInfo => ({ type: "Approved", value: [at, undefined, undefined] })
const ongoing = (track: number, deciding: boolean): ScannedInfo => ({
  type: "Ongoing",
  value: { track, deciding: deciding ? { since: 0, confirming: undefined } : undefined },
})

/** A chain of referenda by index, and a record of the indexes that were read from it. */
function chain(referenda: Record<number, ScannedInfo>, count: number) {
  const reads: number[] = []
  return {
    count,
    reads,
    read: async (indexes: number[]) => {
      reads.push(...indexes)
      return indexes.map((i) => referenda[i] ?? ended(1_000_000))
    },
  }
}

const HORIZON = 500_000
/** Fills the indexes from `from` to `to` with referenda that ended before the horizon. */
const old = (from: number, to: number) =>
  Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, ended(100)]))

describe("scanOngoing", () => {
  it("finds the ongoing referenda and stops once the rest must have ended", async () => {
    const c = chain({ ...old(0, 799), 990: ongoing(ROOT, true), 950: ongoing(1, false) }, 1000)
    const found = await scanOngoing({ ...c, horizon: HORIZON, deciding: new Map(), queued: [] })
    expect(found.ongoing.map((f) => f.index)).toEqual([990, 950])
    // The ended referenda that it read on the way are reported with how they ended.
    expect(found.ended.every((e) => e.outcome === "approved")).toBe(true)
    expect(found.ended.map((e) => e.index)).toContain(999)
    // It stopped with the first chunk that reached a referendum from before the horizon.
    expect(Math.min(...c.reads)).toBeGreaterThan(700)
  })

  it("reads a referendum that has waited in a queue since before the horizon", async () => {
    const c = chain({ ...old(0, 799), 300: ongoing(ROOT, false), 990: ongoing(ROOT, true) }, 1000)
    const found = await scanOngoing({
      ...c,
      horizon: HORIZON,
      deciding: new Map([[ROOT, 1]]),
      queued: [300],
    })
    expect(found.ongoing.map((f) => f.index)).toEqual([990, 300])
    // It was read directly, without scanning down to it.
    expect(c.reads).not.toContain(301)
  })

  it("scans on for a deciding referendum that left a queue after the horizon passed", async () => {
    const c = chain({ ...old(0, 799), 300: ongoing(ROOT, true) }, 1000)
    const found = await scanOngoing({
      ...c,
      horizon: HORIZON,
      deciding: new Map([[ROOT, 1]]),
      queued: [],
    })
    expect(found.ongoing.map((f) => f.index)).toEqual([300])
    // And stops once it has it.
    expect(Math.min(...c.reads)).toBeGreaterThan(200)
  })

  it("does not list a queued index whose referendum is no longer ongoing", async () => {
    const c = chain(old(0, 99), 100)
    const found = await scanOngoing({ ...c, horizon: HORIZON, deciding: new Map(), queued: [5] })
    expect(found.ongoing).toEqual([])
  })
})
