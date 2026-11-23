// Referenda that have ended: reading them as they were, and joining them into finished proposals.

import { fromHex } from "polkadot-api/utils"
import { describe, expect, it, vi } from "vitest"
import fixtures from "./fixtures.json"

vi.mock("../src/chains", async (original) => ({
  ...(await original<typeof import("../src/chains")>()),
  ...(await import("./offline")),
}))

const { decodeCall } = await import("../src/gov/decode")
const { endedAgo, finishedProposals } = await import("../src/gov/finished")
const { lastBlockWhere } = await import("../src/gov/history")
const {
  endedOutcome,
  endedStage,
  findByAnchor,
  isFinished,
  makeProposal,
  proposalAnchor,
  whitelistDispatch,
} = await import("../src/gov/load")

const linear = (ceil: number, floor: number) =>
  ({ type: "LinearDecreasing", value: { length: 1e9, floor, ceil } }) as const
const track = {
  name: "fellows",
  prepare_period: 150,
  decision_period: 200_000,
  confirm_period: 150,
  decision_deposit: 50n,
  min_approval: linear(1e9, 5e8),
  min_support: linear(5e8, 0),
}
const who = "15DCWHQknBjc5YPFoVj8Pn2KoqrqYywJJ95BYNYJ4Fj3NLqz"
const ongoing = (tally: object) => ({
  track: 3,
  proposal: { type: "Inline" as const, value: new Uint8Array() },
  submitted: 9_990_000,
  submission_deposit: { who },
  decision_deposit: { who, amount: 50n },
  deciding: { since: 10_000_000, confirming: 10_100_000 },
  in_queue: false,
  tally,
})

// Fellowship referendum 681 as it was in the block before it was approved, with made-up curves.
const fellowshipRef = {
  network: "polkadot",
  body: "fellowship",
  index: 681,
  outcome: "approved",
  at: 10_100_000,
  now: 10_184_756,
} as const
const fellowship = async (call = fixtures.fellowship681) =>
  endedStage({
    ref: fellowshipRef,
    last: { info: ongoing({ bare_ayes: 15, ayes: 20, nays: 0 }), bytes: null, voters: 32n },
    track,
    call: await decodeCall({ id: "collectives" }, fromHex(call)),
  })

const publicRef = {
  network: "polkadot",
  body: "open",
  index: 1973,
  outcome: "rejected",
  at: 10_100_000,
  now: 10_107_200,
} as const
const open = async () =>
  endedStage({
    ref: publicRef,
    last: {
      info: ongoing({ ayes: 30n, nays: 70n, support: 100n }),
      bytes: null,
      voters: 1000n,
    },
    track: { ...track, name: "whitelisted_caller" },
    call: await decodeCall({ id: "assetHub" }, fromHex(fixtures.polkadotOpen1973)),
  })

describe("endedStage", () => {
  it("has ended at its block, on the current clock", async () => {
    const stage = await fellowship()
    expect(stage.status).toEqual({ phase: "ended", outcome: "approved", at: 10_100_000 })
    expect(stage.now).toBe(10_184_756)
    expect(stage.minRank).toBe(3)
  })

  it("keeps the tally that a Fellowship referendum ended with", async () => {
    const stage = await fellowship()
    expect(stage.approval.current).toBe(1)
    expect(stage.support.current).toBe(15 / 32)
    expect(stage.ayes).toBe("20 (15 of 32 members)")
    expect(stage.passing).toBe(true)
  })

  it("takes the thresholds of the block at which it ended, not of the current one", async () => {
    // Half of the decision period had elapsed when it was approved.
    const stage = await fellowship()
    expect(stage.approval.required).toBeCloseTo(0.75)
    expect(stage.support.required).toBeCloseTo(0.25)
  })

  it("measures a public referendum against the issuance of its last block", async () => {
    const stage = await open()
    expect(stage.status).toEqual({ phase: "ended", outcome: "rejected", at: 10_100_000 })
    expect(stage.approval.current).toBeCloseTo(0.3)
    expect(stage.support.current).toBeCloseTo(0.1)
    expect(stage.passing).toBe(false)
    expect(stage.track).toBe("whitelisted caller")
    // It ended 7,200 Relay Chain blocks ago, which is 12 hours.
    expect(endedAgo({ ...publicRef })).toBe(12 * 3_600_000)
  })
})

describe("endedOutcome", () => {
  it("reads how and when a referendum ended", () => {
    expect(endedOutcome({ type: "Approved", value: [7, undefined, undefined] })).toEqual({
      outcome: "approved",
      at: 7,
    })
    expect(endedOutcome({ type: "Cancelled", value: [8, undefined, undefined] })).toEqual({
      outcome: "canceled",
      at: 8,
    })
    expect(endedOutcome({ type: "Killed", value: 9 })).toEqual({ outcome: "killed", at: 9 })
  })

  it("is null for a referendum that is ongoing or missing", () => {
    expect(endedOutcome({ type: "Ongoing", value: { track: 0 } })).toBeNull()
    expect(endedOutcome(undefined)).toBeNull()
  })
})

describe("lastBlockWhere", () => {
  it("finds the last block at which the condition holds", async () => {
    for (const last of [100, 101, 163, 499, 500]) {
      const asked: number[] = []
      const found = await lastBlockWhere(100, 500, async (block) => {
        asked.push(block)
        return block <= last
      })
      expect(found).toBe(last)
      // Bisection, not a walk through every block.
      expect(asked.length).toBeLessThanOrEqual(9)
    }
  })
})

describe("finishedProposals", () => {
  it("joins a public referendum with the Fellowship one that whitelisted its call", async () => {
    const [publicStage, fellowshipStage] = [await open(), await fellowship()]
    const key = `polkadot:${whitelistDispatch(publicStage)?.hash}`
    const proposals = finishedProposals(
      [fellowshipStage, publicStage],
      new Map([[key, fellowshipStage]]),
      new Set(),
    )
    expect(proposals).toHaveLength(1)
    const [proposal] = proposals
    expect(proposal.title).toBe("Runtime upgrade of 7 chains")
    expect(proposal.endedFellowship).toBe(fellowshipStage)
    expect(isFinished(proposal)).toBe(true)
    // The card answers to either referendum, and is named for the public one.
    expect(proposalAnchor(proposal)).toBe("polkadot-1973")
    expect(findByAnchor(proposals, "fellowship-681")).toBe(proposal)
    expect(findByAnchor(proposals, "kusama-1973")).toBeUndefined()
  })

  it("gives a Fellowship referendum its own card, unless it is shown elsewhere", async () => {
    const stage = await fellowship(fixtures.fellowship679)
    const [alone] = finishedProposals([stage], new Map(), new Set())
    expect(alone.endedFellowship).toBe(stage)
    expect(alone.open).toBeUndefined()
    expect(isFinished(alone)).toBe(true)
    expect(proposalAnchor(alone)).toBe("fellowship-681")
    expect(finishedProposals([stage], new Map(), new Set([681]))).toEqual([])
  })

  it("puts the one that ended last first", async () => {
    // The public one ended 12 hours ago, and the Fellowship one more than 11 days ago.
    const proposals = finishedProposals(
      [await fellowship(fixtures.fellowship679), await open()],
      new Map(),
      new Set(),
    )
    expect(proposals.map(proposalAnchor)).toEqual(["polkadot-1973", "fellowship-681"])
  })
})

describe("isFinished", () => {
  it("is false while a referendum of the proposal is open", async () => {
    const stage = await fellowship()
    const active = { ...stage, status: { phase: "queued" } as const }
    expect(isFinished(makeProposal({ network: "polkadot", fellowship: active, call: null }))).toBe(
      false,
    )
    // An active public referendum with the Fellowship one that whitelisted its call.
    const paired = makeProposal({
      network: "polkadot",
      open: { ...active, body: "open" },
      endedFellowship: stage,
      call: null,
    })
    expect(isFinished(paired)).toBe(false)
  })
})
