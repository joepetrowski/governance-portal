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
const { lastBlockWhere, lastOngoingBlock } = await import("../src/gov/history")
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

describe("lastOngoingBlock", () => {
  // A chain with about three blocks to a Relay Chain block, as Asset Hub has.
  const relayOf = (block: number) => 5_000_000 + Math.floor(block / 2.93)
  const head = 3_000_000
  /**
   * Search for a referendum that was ongoing from block `submitted` until block `ended`. The chain
   * records the Relay Chain block that it had seen by the block before, or by that block itself.
   */
  const search = async (submitted: number, ended: number, seenBy: "before" | "same") => {
    const asked = new Set<number>()
    const found = await lastOngoingBlock({
      head,
      relayNow: relayOf(head),
      endedAt: relayOf(seenBy === "before" ? ended - 1 : ended),
      relayAt: async (block) => (asked.add(block), relayOf(block)),
      ongoingAt: async (block) => (asked.add(block), block >= submitted && block < ended),
    })
    return { found, reads: asked.size }
  }

  it("finds the last block of a referendum that lived for weeks", async () => {
    for (const seenBy of ["before", "same"] as const) {
      const { found, reads } = await search(1_000_000, 2_950_000, seenBy)
      expect(found).toBe(2_949_999)
      expect(reads).toBeLessThan(30)
    }
  })

  it("finds one that lived for an hour and ended long ago", async () => {
    // It was submitted long after the block that the search starts from.
    for (const seenBy of ["before", "same"] as const) {
      const { found } = await search(1_500_000, 1_501_800, seenBy)
      expect(found).toBe(1_501_799)
    }
  })

  it("finds one that ended moments ago", async () => {
    const { found } = await search(2_999_000, 2_999_990, "before")
    expect(found).toBe(2_999_989)
  })

  it("gives up on one that ended before the chain began, or was never ongoing", async () => {
    const early = await lastOngoingBlock({
      head,
      relayNow: relayOf(head),
      endedAt: 4_000_000,
      relayAt: async (block) => relayOf(block),
      ongoingAt: async () => false,
    })
    expect(early).toBeNull()
    expect((await search(2_000_000, 2_000_000, "same")).found).toBeNull()
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

  it("does not join a Fellowship referendum that ended after the public one", async () => {
    // The public one ended 12 hours ago. This Fellowship one ended a minute ago.
    const late = endedStage({
      ref: { ...fellowshipRef, at: fellowshipRef.now - 5 },
      last: { info: ongoing({ bare_ayes: 15, ayes: 20, nays: 0 }), bytes: null, voters: 32n },
      track,
      call: await decodeCall({ id: "collectives" }, fromHex(fixtures.fellowship681)),
    })
    const publicStage = await open()
    const key = `polkadot:${whitelistDispatch(publicStage)?.hash}`
    const proposals = finishedProposals([late, publicStage], new Map([[key, late]]), new Set())
    expect(proposals.map((p) => [p.open?.index, p.endedFellowship?.index])).toEqual([
      [undefined, 681],
      [1973, undefined],
    ])
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
