import { fromHex } from "polkadot-api/utils"
import { describe, expect, it, vi } from "vitest"
import fixtures from "./fixtures.json"

vi.mock("../src/chains", async (original) => ({
  ...(await original<typeof import("../src/chains")>()),
  ...(await import("./offline")),
}))

const { decodeCall } = await import("../src/gov/decode")
const { effectsBesidesWhitelist, fellowshipMinRank, makeProposal, passedFellowshipStage } =
  await import("../src/gov/load")
const { parseReleaseHashes, upgradeVersion } = await import("../src/gov/versions")

const proposalOf = async (hex: string, chain: "assetHub" | "kusamaAssetHub" = "assetHub") => {
  const tree = await decodeCall({ id: chain }, fromHex(hex))
  // What a card shows for a whitelisted call is the call inside the whitelist dispatch.
  const call = tree.name === "dispatch_whitelisted_call_with_preimage" ? tree.children[0] : tree
  return makeProposal({ network: chain === "assetHub" ? "polkadot" : "kusama", call })
}

describe("proposal titles", () => {
  it("names a plain upgrade by its chains", async () => {
    const proposal = await proposalOf(fixtures.polkadotOpen1973)
    expect(proposal.title).toBe("Runtime upgrade of 7 chains")
    expect(proposal.kind).toBe("upgrade")
    expect(proposal.otherEffects).toBe(0)
    expect(proposal.upgrades).toHaveLength(7)
    expect(proposal.upgrades.every((u) => !u.unchecked)).toBe(true)
  })

  it("says so when an upgrade does something else as well", async () => {
    const proposal = await proposalOf(fixtures.craftedUpgradeWithTransfer)
    expect(proposal.title).toBe("Runtime upgrade of Asset Hub and 1 other call")
    expect(proposal.otherEffects).toBe(1)
  })

  it("marks an upgrade that skips the version checks", async () => {
    const proposal = await proposalOf(fixtures.craftedUncheckedUpgrade)
    expect(proposal.upgrades).toEqual([
      { chain: "Asset Hub", codeHash: "0x" + "22".repeat(32), unchecked: true },
    ])
  })

  it("names other proposals by what they do and where", async () => {
    const proposal = await proposalOf(fixtures.polkadotOpen1972)
    expect(proposal.title).toBe(
      "`Staking.set_validator_count`, `Dap.set_budget_allocation`, and 2 more on Asset Hub and " +
        "Relay Chain",
    )
    const xcm = await proposalOf(fixtures.craftedXcmWithAppendix)
    expect(xcm.title).toBe("`System.remark` and XCM `DepositAsset` on Relay Chain")
  })
})

describe("upgradeVersion", () => {
  const release = (tag: string, hashes: string[]) => ({
    tag_name: tag,
    body: hashes.map((h) => `## Runtime\n~~~\n🗳️ Blake2-256 hash:        ${h}\n~~~\n`).join(""),
  })

  it("reads hashes from release notes, ignoring tags that are not versions", () => {
    const a = "0x" + "aa".repeat(32)
    const b = "0x" + "bb".repeat(32)
    expect(
      parseReleaseHashes([
        release("v2.6.0", [a]),
        release("nightly", [b]),
        { tag_name: "v2.5.0", body: null },
      ]),
    ).toEqual({ [a]: "v2.6.0" })
  })

  it("names a system upgrade only when every runtime is in one release", async () => {
    const proposal = await proposalOf(fixtures.polkadotOpen1973)
    const hashes = proposal.upgrades.map((u) => u.codeHash)
    const all = parseReleaseHashes([release("v2.6.0", hashes)])
    expect(upgradeVersion(proposal, all)).toEqual({ version: "2.6.0", whole: true })

    const split = parseReleaseHashes([
      release("v2.6.0", hashes.slice(1)),
      release("v2.5.3", hashes.slice(0, 1)),
    ])
    expect(upgradeVersion(proposal, split)).toBeNull()
    expect(upgradeVersion(proposal, parseReleaseHashes([release("v2.6.0", hashes.slice(1))]))).toBe(
      null,
    )
    expect(upgradeVersion(proposal, {})).toBeNull()
  })

  it("does not name an upgrade that does something else, or that skips checks", async () => {
    const mixed = await proposalOf(fixtures.craftedUpgradeWithTransfer)
    const unchecked = await proposalOf(fixtures.craftedUncheckedUpgrade)
    const hashes = { ["0x" + "11".repeat(32)]: "v9.9.9", ["0x" + "22".repeat(32)]: "v9.9.9" }
    expect(upgradeVersion(mixed, hashes)).toBeNull()
    expect(upgradeVersion(unchecked, hashes)).toBeNull()
  })

  it("tells a partial upgrade from a whole one", async () => {
    const proposal = await proposalOf(fixtures.polkadotOpen1973)
    const partial = { ...proposal, upgrades: proposal.upgrades.slice(0, 2) }
    const hashes = parseReleaseHashes([
      release(
        "v2.6.0",
        partial.upgrades.map((u) => u.codeHash),
      ),
    ])
    expect(upgradeVersion(partial, hashes)).toEqual({ version: "2.6.0", whole: false })
  })
})

describe("fellowshipMinRank", () => {
  it("follows the track rules of the Collectives runtime", () => {
    // Tracks 1 to 9 are the voice of that rank.
    expect(fellowshipMinRank(1)).toBe(1)
    expect(fellowshipMinRank(3)).toBe(3)
    // Retention, promotion, and fast promotion need two ranks above the rank decided.
    expect(fellowshipMinRank(13)).toBe(5)
    expect(fellowshipMinRank(23)).toBe(5)
    expect(fellowshipMinRank(32)).toBe(4)
  })
})

describe("effectsBesidesWhitelist", () => {
  // The hash that Fellowship referendum 681 whitelists on Polkadot Asset Hub.
  const HASH = "0x680f831072c8c3b77dd52407f095e4f2254568ff5b6ba1fd13766f8f1ba981ed"

  it("is zero for a Fellowship referendum that only whitelists the call", async () => {
    const call = await decodeCall({ id: "collectives" }, fromHex(fixtures.fellowship681))
    expect(effectsBesidesWhitelist(call, "polkadot", HASH)).toBe(0)
    expect(effectsBesidesWhitelist(null, "polkadot", HASH)).toBe(0)
  })

  it("counts a whitelist of another hash, or on another network", async () => {
    const call = await decodeCall({ id: "collectives" }, fromHex(fixtures.fellowship681))
    expect(effectsBesidesWhitelist(call, "polkadot", `0x${"00".repeat(32)}`)).toBe(1)
    expect(effectsBesidesWhitelist(call, "kusama", HASH)).toBe(1)
  })

  it("counts everything that is not the whitelist", async () => {
    const batch = await decodeCall({ id: "assetHub" }, fromHex(fixtures.craftedUpgradeWithTransfer))
    expect(effectsBesidesWhitelist(batch, "polkadot", HASH)).toBe(2)
  })
})

describe("passedFellowshipStage", () => {
  // Fellowship referendum 681 as it was in the block before it was approved, with made-up curves.
  const linear = (ceil: number, floor: number) =>
    ({ type: "LinearDecreasing", value: { length: 1e9, floor, ceil } }) as const
  const stage = passedFellowshipStage({
    index: 681,
    info: {
      track: 3,
      proposal: { type: "Inline", value: new Uint8Array() },
      submitted: 10_152_829,
      submission_deposit: { who: "15DCWHQknBjc5YPFoVj8Pn2KoqrqYywJJ95BYNYJ4Fj3NLqz" },
      decision_deposit: { who: "12T8DKkCLf2C6ddnkVFDdzY2mM8Q4GE7RpZVhL7P9jbFMfoe", amount: 50n },
      deciding: { since: 10_000_000, confirming: 10_100_000 },
      in_queue: false,
      tally: { bare_ayes: 15, ayes: 20, nays: 0 },
    },
    track: {
      name: "fellows",
      prepare_period: 150,
      decision_period: 200_000,
      confirm_period: 150,
      decision_deposit: 50n,
      min_approval: linear(1e9, 5e8),
      min_support: linear(5e8, 0),
    },
    eligible: 32,
    since: 10_100_000,
    now: 10_184_756,
    call: null,
  })

  it("is passed at the block of its approval, on the current clock", () => {
    expect(stage.status).toEqual({ phase: "passed", at: 10_100_000 })
    expect(stage.now).toBe(10_184_756)
    expect(stage.body).toBe("fellowship")
    expect(stage.minRank).toBe(3)
  })

  it("keeps the tally it passed with", () => {
    expect(stage.approval.current).toBe(1)
    expect(stage.support.current).toBe(15 / 32)
    expect(stage.ayes).toBe("20 (15 of 32 members)")
    expect(stage.nays).toBe("0")
    expect(stage.passing).toBe(true)
  })

  it("takes the thresholds of the block at which it passed, not of the current one", () => {
    // Half of the decision period had elapsed when it was approved.
    expect(stage.approval.required).toBeCloseTo(0.75)
    expect(stage.support.required).toBeCloseTo(0.25)
  })
})
