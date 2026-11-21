// The vote-lock arithmetic, on hand-built chain state. The expectations follow `try_remove_vote`
// and `update_lock` in `pallet-conviction-voting`.

import { describe, expect, it } from "vitest"
import { cleanupFrom, needsCleanup, type VotingState } from "../src/gov/cleanup"

const ADDRESS = "1eTPAR2TuqLyidmPT9rMmuycHVm9s9czu78sePqg2KHMDrE"
const PERIOD = 100
const NOW = 1_000
const ROOT = 0
const WHITELIST = 1
const AYE = 0x80

type Entry = VotingState["entries"][number]
type Info = NonNullable<ReturnType<VotingState["infos"]["get"]>>
type Vote = Extract<Entry["value"], { type: "Casting" }>["value"]["votes"][number][1]

const standard = (aye: boolean, conviction: number, balance: bigint) =>
  ({ type: "Standard", value: { vote: (aye ? AYE : 0) | conviction, balance } }) as Vote
const split = (aye: bigint, nay: bigint) => ({ type: "Split", value: { aye, nay } }) as Vote

const casting = (
  track: number,
  votes: [number, Vote][],
  prior: [number, bigint] = [0, 0n],
): Entry =>
  ({
    keyArgs: [ADDRESS, track],
    value: { type: "Casting", value: { votes, delegations: { votes: 0n, capital: 0n }, prior } },
  }) as unknown as Entry

const delegating = (track: number, balance: bigint, prior: [number, bigint] = [0, 0n]): Entry =>
  ({
    keyArgs: [ADDRESS, track],
    value: { type: "Delegating", value: { balance, prior } },
  }) as unknown as Entry

const ended = (type: "Approved" | "Rejected" | "Cancelled" | "TimedOut" | "Killed", at: number) =>
  ({ type, value: type === "Killed" ? at : [at, undefined, undefined] }) as unknown as Info
const ongoing = { type: "Ongoing", value: {} } as unknown as Info

const run = (parts: {
  entries: Entry[]
  locks?: [number, bigint][]
  infos?: [number, Info][]
  now?: number
}) =>
  cleanupFrom(ADDRESS, "polkadot", {
    entries: parts.entries,
    classLocks: parts.locks ?? [],
    infos: new Map(parts.infos ?? []),
    period: PERIOD,
    trackNames: new Map([
      [ROOT, "root"],
      [WHITELIST, "whitelisted caller"],
    ]),
    now: parts.now ?? NOW,
    loadedAt: 0,
  })

describe("votes on referenda that are still open", () => {
  it("are kept, and their lock stays", () => {
    const result = run({
      entries: [casting(ROOT, [[7, standard(true, 1, 50n)]])],
      locks: [[ROOT, 50n]],
      infos: [[7, ongoing]],
    })
    expect(result.stale).toEqual([])
    expect(result.tracks).toEqual([])
    expect(result.lockedNow).toBe(50n)
    expect(result.lockedAfter).toBe(50n)
    expect(needsCleanup(result)).toBe(false)
  })
})

describe("a vote on a finished referendum", () => {
  // Approved at block 900. A 2x vote locks for two periods, so until block 1,100.
  const winning = {
    entries: [casting(ROOT, [[7, standard(true, 2, 50n)]])],
    locks: [[ROOT, 50n]] as [number, bigint][],
    infos: [[7, ended("Approved", 900)]] as [number, Info][],
  }

  it("stays locked while its conviction period runs, if it was on the winning side", () => {
    const result = run(winning)
    expect(result.stale).toHaveLength(1)
    expect(result.stale[0]).toMatchObject({
      index: 7,
      trackId: ROOT,
      track: "root",
      outcome: "Approved",
      lockedUntil: 1_100,
    })
    expect(result.tracks).toEqual([ROOT])
    expect(result.lockedAfter).toBe(50n)
    expect(result.nextUnlock).toBe(1_100)
    expect(needsCleanup(result)).toBe(true)
  })

  it("is free once the conviction period is over", () => {
    const result = run({ ...winning, now: 1_100 })
    expect(result.stale[0].lockedUntil).toBeNull()
    expect(result.lockedNow).toBe(50n)
    expect(result.lockedAfter).toBe(0n)
    expect(result.nextUnlock).toBeNull()
  })

  it("counts lock periods by conviction: 6x locks for 32 periods", () => {
    const result = run({ ...winning, entries: [casting(ROOT, [[7, standard(true, 6, 50n)]])] })
    expect(result.stale[0].lockedUntil).toBe(900 + 32 * PERIOD)
  })

  it("is free at once on the losing side", () => {
    const nayOnApproved = run({
      ...winning,
      entries: [casting(ROOT, [[7, standard(false, 2, 50n)]])],
    })
    expect(nayOnApproved.stale[0].lockedUntil).toBeNull()
    expect(nayOnApproved.lockedAfter).toBe(0n)

    const ayeOnRejected = run({ ...winning, infos: [[7, ended("Rejected", 900)]] })
    expect(ayeOnRejected.stale[0]).toMatchObject({ outcome: "Rejected", lockedUntil: null })
  })

  it("is locked on the winning side of a rejection too", () => {
    const result = run({
      ...winning,
      entries: [casting(ROOT, [[7, standard(false, 2, 50n)]])],
      infos: [[7, ended("Rejected", 900)]],
    })
    expect(result.stale[0].lockedUntil).toBe(1_100)
  })

  it("is free at once without conviction, and when it is a split vote", () => {
    const noConviction = run({
      ...winning,
      entries: [casting(ROOT, [[7, standard(true, 0, 50n)]])],
    })
    expect(noConviction.stale[0].lockedUntil).toBeNull()
    const splitVote = run({ ...winning, entries: [casting(ROOT, [[7, split(30n, 20n)]])] })
    expect(splitVote.stale[0].lockedUntil).toBeNull()
    expect(splitVote.lockedAfter).toBe(0n)
  })

  it("is free at once when the referendum was not decided", () => {
    const outcomes = [
      ["Cancelled", "Canceled"],
      ["TimedOut", "Timed out"],
      ["Killed", "Killed"],
    ] as const
    for (const [type, outcome] of outcomes) {
      const result = run({ ...winning, infos: [[7, ended(type, 900)]] })
      expect(result.stale[0]).toMatchObject({ outcome, lockedUntil: null })
    }
    const forgotten = run({ ...winning, infos: [] })
    expect(forgotten.stale[0]).toMatchObject({ outcome: "Unknown", lockedUntil: null })
  })
})

describe("what remains locked", () => {
  it("is the largest of the votes kept and the locks that have not expired", () => {
    const result = run({
      entries: [
        casting(ROOT, [
          [7, standard(true, 2, 80n)],
          [9, standard(true, 1, 30n)],
        ]),
        casting(WHITELIST, [[8, standard(true, 1, 60n)]]),
      ],
      locks: [
        [ROOT, 80n],
        [WHITELIST, 60n],
      ],
      infos: [
        [7, ended("Approved", 500)],
        [8, ended("Approved", 950)],
        [9, ongoing],
      ],
    })
    // 7 is free (its lock ended at 700), 9 is still open, 8 is locked until 1,050.
    expect(result.stale.map((v) => v.index)).toEqual([8, 7])
    expect(result.lockedNow).toBe(80n)
    expect(result.lockedAfter).toBe(60n)
    expect(result.nextUnlock).toBe(1_050)
    expect(result.tracks.sort()).toEqual([ROOT, WHITELIST])
  })

  it("includes a prior lock until it expires", () => {
    const running = run({ entries: [casting(ROOT, [], [1_200, 40n])], locks: [[ROOT, 40n]] })
    expect(running.tracks).toEqual([])
    expect(running.lockedAfter).toBe(40n)
    expect(running.nextUnlock).toBe(1_200)

    const expired = run({ entries: [casting(ROOT, [], [900, 40n])], locks: [[ROOT, 40n]] })
    expect(expired.stale).toEqual([])
    expect(expired.tracks).toEqual([ROOT])
    expect(expired.lockedAfter).toBe(0n)
    expect(needsCleanup(expired)).toBe(true)
  })

  it("keeps the larger amount and the later block when a removal adds to a prior lock", () => {
    const result = run({
      entries: [casting(ROOT, [[7, standard(true, 1, 50n)]], [1_300, 20n])],
      locks: [[ROOT, 50n]],
      infos: [[7, ended("Approved", 950)]],
    })
    expect(result.lockedAfter).toBe(50n)
    expect(result.nextUnlock).toBe(1_300)
  })

  it("includes a delegated balance", () => {
    const result = run({ entries: [delegating(ROOT, 70n)], locks: [[ROOT, 70n]] })
    expect(result.tracks).toEqual([])
    expect(result.lockedAfter).toBe(70n)
  })

  it("can be lowered when a lock is left with no record of votes", () => {
    const result = run({ entries: [], locks: [[WHITELIST, 25n]] })
    expect(result.tracks).toEqual([WHITELIST])
    expect(result.lockedNow).toBe(25n)
    expect(result.lockedAfter).toBe(0n)
  })
})
