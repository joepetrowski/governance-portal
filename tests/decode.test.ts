import { fromHex, toHex } from "polkadot-api/utils"
import { describe, expect, it, vi } from "vitest"
import fixtures from "./fixtures.json"

vi.mock("../src/chains", async (original) => ({
  ...(await original<typeof import("../src/chains")>()),
  ...(await import("./offline")),
}))

const { chainLabel, decodeCall, effects, isPlumbing, resolveLocation, walk, NOT_LOADED } =
  await import("../src/gov/decode")

const named = (n: { pallet: string; name: string }) => `${n.pallet}.${n.name}`
const here = { type: "Here", value: undefined }
const x = (...junctions: { type: string; value: unknown }[]) =>
  junctions.length === 1
    ? { type: "X1", value: junctions[0] }
    : { type: `X${junctions.length}`, value: junctions }
const para = (id: number) => ({ type: "Parachain", value: id })
const consensus = (name: string) => ({
  type: "GlobalConsensus",
  value: { type: name, value: undefined },
})

describe("resolveLocation", () => {
  it("resolves within a network", () => {
    expect(resolveLocation({ id: "assetHub" }, { parents: 1, interior: here })).toEqual({
      id: "relay",
    })
    expect(resolveLocation({ id: "assetHub" }, { parents: 1, interior: x(para(1001)) })).toEqual({
      id: "collectives",
    })
    expect(resolveLocation({ id: "relay" }, { parents: 0, interior: x(para(1000)) })).toEqual({
      id: "assetHub",
    })
    expect(resolveLocation({ id: "assetHub" }, { parents: 0, interior: here })).toEqual({
      id: "assetHub",
    })
  })

  it("keeps the two networks apart, although their parachain IDs coincide", () => {
    expect(
      resolveLocation({ id: "kusamaAssetHub" }, { parents: 1, interior: x(para(1001)) }),
    ).toEqual({ id: "kusamaEncointer" })
    expect(resolveLocation({ id: "kusamaAssetHub" }, { parents: 1, interior: here })).toEqual({
      id: "kusama",
    })
  })

  it("crosses the bridge", () => {
    expect(
      resolveLocation(
        { id: "assetHub" },
        { parents: 2, interior: x(consensus("Kusama"), para(1000)) },
      ),
    ).toEqual({ id: "kusamaAssetHub" })
    expect(
      resolveLocation({ id: "relay" }, { parents: 1, interior: x(consensus("Kusama")) }),
    ).toEqual({ id: "kusama" })
  })

  it("does not guess at places it does not know", () => {
    expect(resolveLocation({ id: "assetHub" }, { parents: 1, interior: x(para(2000)) })).toEqual({
      external: "Polkadot parachain 2000",
    })
    expect(
      "external" in
        resolveLocation({ id: "assetHub" }, { parents: 2, interior: x(consensus("Ethereum")) }),
    ).toBe(true)
    // A bridge path with the wrong number of parents is not a bridge path.
    expect(
      "external" in
        resolveLocation(
          { id: "assetHub" },
          { parents: 1, interior: x(consensus("Kusama"), para(1000)) },
        ),
    ).toBe(true)
  })
})

describe("decodeCall on live referenda", () => {
  it("resolves the Polkadot system upgrade to one authorization per chain", async () => {
    // The preimage is `dispatch_whitelisted_call_with_preimage(call)`.
    const tree = await decodeCall({ id: "assetHub" }, fromHex(fixtures.polkadotOpen1973))
    expect(named(tree)).toBe("Whitelist.dispatch_whitelisted_call_with_preimage")
    const done = effects(tree)
    expect(done.map(named)).toEqual(Array(7).fill("System.authorize_upgrade"))
    expect(done.map((n) => chainLabel(n.chain))).toEqual([
      "Relay Chain",
      "Asset Hub",
      "Collectives",
      "Bridge Hub",
      "People",
      "Coretime",
      "Bulletin",
    ])
    expect([...walk(tree)].some((n) => n.undecoded)).toBe(false)
  })

  it("resolves the Kusama upgrade on Kusama's chains", async () => {
    const tree = await decodeCall({ id: "kusamaAssetHub" }, fromHex(fixtures.kusamaOpen679))
    expect(effects(tree).map((n) => chainLabel(n.chain))).toEqual([
      "Kusama Relay Chain",
      "Kusama Asset Hub",
      "Kusama Encointer",
      "Kusama Bridge Hub",
      "Kusama People",
      "Kusama Coretime",
    ])
  })

  it("follows a Fellowship whitelist to Polkadot Asset Hub", async () => {
    const tree = await decodeCall({ id: "collectives" }, fromHex(fixtures.fellowship681))
    const [only, ...rest] = effects(tree)
    expect(rest).toEqual([])
    expect(named(only)).toBe("Whitelist.whitelist_call")
    expect(only.chain).toEqual({ id: "assetHub" })
  })

  it("follows a Fellowship whitelist over the bridge to Kusama Asset Hub", async () => {
    const tree = await decodeCall({ id: "collectives" }, fromHex(fixtures.fellowship679))
    const [only, ...rest] = effects(tree)
    expect(rest).toEqual([])
    expect(named(only)).toBe("Whitelist.whitelist_call")
    expect(only.chain).toEqual({ id: "kusamaAssetHub" })
    // The hash it whitelists is that of the call the Kusama referendum dispatches.
    const { blake2Hex } = await import("../src/gov/decode")
    const dispatched = fromHex(fixtures.kusamaOpen679).subarray(2)
    const hash = (only.args as { call_hash: unknown }).call_hash
    expect(hash instanceof Uint8Array ? toHex(hash) : hash).toBe(blake2Hex(dispatched))
  })

  it("leaves a skipped network undecoded without failing", async () => {
    const tree = await decodeCall({ id: "collectives" }, fromHex(fixtures.fellowship679), [
      "kusama",
    ])
    const undecoded = [...walk(tree)].filter((n) => n.undecoded)
    expect(undecoded.map((n) => n.undecoded)).toEqual([NOT_LOADED])
    expect(undecoded[0].chain).toEqual({ id: "kusamaAssetHub" })
  })

  it("turns bytes that are not a call into an undecoded node", async () => {
    const tree = await decodeCall({ id: "assetHub" }, new Uint8Array([255, 255, 255]))
    expect(tree.undecoded).toBeTruthy()
    expect(effects(tree)).toHaveLength(1)
  })
})

describe("decodeCall on calls crafted to hide something", () => {
  it("shows a transfer batched in with an upgrade", async () => {
    const tree = await decodeCall({ id: "assetHub" }, fromHex(fixtures.craftedUpgradeWithTransfer))
    expect(effects(tree).map(named)).toEqual([
      "System.authorize_upgrade",
      "Balances.force_transfer",
    ])
  })

  it("shows a call in `SetAppendix` and instructions that move assets", async () => {
    const tree = await decodeCall({ id: "assetHub" }, fromHex(fixtures.craftedXcmWithAppendix))
    expect([...walk(tree)].map(named)).toEqual([
      "PolkadotXcm.send",
      "XCM.UnpaidExecution",
      "System.remark",
      "XCM.SetAppendix",
      "System.remark",
      "XCM.DepositAsset",
    ])
    // Paying for execution is not an effect; the two calls and the deposit are.
    expect(effects(tree).map(named)).toEqual(["System.remark", "System.remark", "XCM.DepositAsset"])
    expect([...walk(tree)].filter(isPlumbing).map(named)).toEqual(["XCM.UnpaidExecution"])
    expect(effects(tree).every((n) => "id" in n.chain && n.chain.id === "relay")).toBe(true)
  })

  it("follows calls under argument names it has no convention for", async () => {
    const tree = await decodeCall({ id: "assetHub" }, fromHex(fixtures.craftedIfElse))
    expect(named(tree)).toBe("Utility.if_else")
    expect(tree.shownAsChildren).toEqual(["main", "fallback"])
    expect(effects(tree).map(named)).toEqual(["System.remark", "Balances.force_transfer"])
  })

  it("does not take an origin for a call", async () => {
    // `FellowshipReferenda.submit` has an origin argument with the same shape as a call.
    const tree = await decodeCall({ id: "collectives" }, fromHex(fixtures.craftedSubmit))
    expect(named(tree)).toBe("FellowshipReferenda.submit")
    const origin = (tree.args as { proposal_origin: { type: string } }).proposal_origin
    expect(origin.type).toBe("FellowshipOrigins")
    expect(tree.children).toEqual([])
    expect(tree.shownAsChildren).toEqual([])
  })

  it("does not take the assets of a transfer for an XCM program", async () => {
    const tree = await decodeCall({ id: "assetHub" }, fromHex(fixtures.craftedTeleport))
    expect(named(tree)).toBe("PolkadotXcm.limited_teleport_assets")
    expect(tree.children).toEqual([])
    // The assets stay among the arguments, where the amount can be read.
    expect(tree.shownAsChildren).toEqual([])
    expect(Object.keys(tree.args as object)).toContain("assets")
    expect([...walk(tree)].some((n) => n.undecoded)).toBe(false)
    expect(effects(tree).map(named)).toEqual(["PolkadotXcm.limited_teleport_assets"])
  })

  it("keeps the arguments of a call that has no children", async () => {
    const tree = await decodeCall({ id: "assetHub" }, fromHex(fixtures.craftedTransfer))
    expect(tree.shownAsChildren).toEqual([])
    expect(Object.keys(tree.args as object)).toEqual(["source", "dest", "value"])
  })
})
