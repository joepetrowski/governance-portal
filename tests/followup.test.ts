// The deposit and the vote that follow the opening of a referendum.

import { describe, expect, it, vi } from "vitest"

vi.mock("../src/chains", async (original) => ({
  ...(await original<typeof import("../src/chains")>()),
  ...(await import("./offline")),
}))

const { followUp, openedBy } = await import("../src/gov/followup")

const submitted = (pallet: string, index: number, track: number) => ({
  type: pallet,
  value: { type: "Submitted", value: { index, track, proposal: { type: "Inline" } } },
})

describe("openedBy", () => {
  const events = [
    { type: "Balances", value: { type: "Reserved", value: { who: "x", amount: 1n } } },
    submitted("FellowshipReferenda", 684, 3),
    { type: "FellowshipReferenda", value: { type: "DecisionDepositPlaced", value: { index: 1 } } },
    submitted("FellowshipReferenda", 685, 3),
    submitted("AmbassadorReferenda", 9, 1),
    { type: "System", value: { type: "ExtrinsicSuccess", value: {} } },
  ]

  it("finds every referendum of the body that the transaction opened", () => {
    expect(openedBy(events, "fellowship", "polkadot")).toEqual([
      { body: "fellowship", network: "polkadot", index: 684, track: 3 },
      { body: "fellowship", network: "polkadot", index: 685, track: 3 },
    ])
  })

  it("finds none of another body, or in events that open nothing", () => {
    expect(openedBy(events, "open", "polkadot")).toEqual([])
    expect(openedBy([submitted("Referenda", 5, 1)], "open", "kusama")).toEqual([
      { body: "open", network: "kusama", index: 5, track: 1 },
    ])
    expect(
      openedBy(
        [{ type: "Referenda", value: { type: "Submitted", value: {} } }],
        "open",
        "polkadot",
      ),
    ).toEqual([])
    expect(openedBy([null, "text", {}], "open", "polkadot")).toEqual([])
  })
})

describe("followUp", () => {
  const fellowship = { body: "fellowship", network: "polkadot", index: 684, track: 3 } as const
  const open = { body: "open", network: "polkadot", index: 1974, track: 1 } as const
  const deposits = new Map([
    [3, 50_000_000_000n],
    [1, 100_000_000_000_000n],
  ])

  it("places the deposit and votes aye on a Fellowship referendum", () => {
    const plan = followUp([fellowship], { deposit: true, aye: true }, deposits)
    expect(plan?.calls).toEqual([
      { kind: "deposit", referendum: fellowship },
      { kind: "fellowshipAye", referendum: fellowship },
    ])
    expect(plan?.description).toBe(
      "Place the decision deposit of 5 DOT and vote aye on Fellowship referendum #684.",
    )
  })

  it("does only what was chosen, and nothing if nothing was", () => {
    const plan = followUp([fellowship], { deposit: false, aye: true }, deposits)
    expect(plan?.calls).toEqual([{ kind: "fellowshipAye", referendum: fellowship }])
    expect(plan?.description).toBe("Vote aye on Fellowship referendum #684.")
    expect(followUp([fellowship], { deposit: false, aye: false }, deposits)).toBeNull()
    expect(followUp([], { deposit: true, aye: true }, deposits)).toBeNull()
  })

  it("votes on a public referendum with the stake that was given, and not without one", () => {
    // The sentence gives the amounts in full, since it is what the account is asked to sign.
    const stake = { amount: 12_345_000_000_000n, conviction: 1 }
    const plan = followUp([open], { deposit: true, aye: true, stake }, deposits)
    expect(plan?.calls).toEqual([
      { kind: "deposit", referendum: open },
      { kind: "openAye", referendum: open, stake },
    ])
    expect(plan?.description).toBe(
      "Place the decision deposit of 10,000 DOT and vote aye with 1,234.5 DOT at 1x on public " +
        "referendum #1974.",
    )
    const without = followUp([open], { deposit: true, aye: true }, deposits)
    expect(without?.calls).toEqual([{ kind: "deposit", referendum: open }])
    expect(without?.description).toBe(
      "Place the decision deposit of 10,000 DOT on public referendum #1974.",
    )
  })

  it("covers every referendum that was opened, each by its own index", () => {
    const second = { ...fellowship, index: 685 }
    const plan = followUp([fellowship, second], { deposit: true, aye: true }, deposits)
    expect(plan?.calls.map((c) => [c.kind, c.referendum.index])).toEqual([
      ["deposit", 684],
      ["fellowshipAye", 684],
      ["deposit", 685],
      ["fellowshipAye", 685],
    ])
    expect(plan?.description).toBe(
      "Place the decision deposit of 5 DOT and vote aye on Fellowship referendum #684. " +
        "Place the decision deposit of 5 DOT and vote aye on Fellowship referendum #685.",
    )
  })
})
