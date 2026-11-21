// Dev tool: Record the fixtures that the tests decode, from live chains. Run with
// `npx tsx scripts/fixtures.ts` when a runtime upgrade changes how the fixtures decode, then
// review the difference. The referenda it reads must still be in chain state.
import { writeFileSync } from "node:fs"
import { toHex } from "polkadot-api/utils"
import { assetHubApi, collectivesApi, getClient } from "../src/chains"
const out: Record<string, string> = {}
const pre = async (net: "polkadot" | "kusama", index: number) => {
  const api = assetHubApi(net)
  const info: any = await api.query.Referenda.ReferendumInfoFor.getValue(index)
  const p = info.value.proposal
  const bytes =
    p.type === "Inline"
      ? p.value
      : await api.query.Preimage.PreimageFor.getValue([p.value.hash, p.value.len])
  return toHex(bytes as Uint8Array)
}
const fel = async (index: number) => {
  const info: any =
    await collectivesApi().query.FellowshipReferenda.ReferendumInfoFor.getValue(index)
  return toHex(info.value.proposal.value as Uint8Array)
}
out.polkadotOpen1973 = await pre("polkadot", 1973)
out.polkadotOpen1972 = await pre("polkadot", 1972)
out.kusamaOpen679 = await pre("kusama", 679)
out.fellowship681 = await fel(681)
out.fellowship680 = await fel(680)
out.fellowship679 = await fel(679)
// Crafted calls that an incomplete decoder would understate.
const ah: any = getClient("assetHub").getUnsafeApi()
const relay: any = getClient("relay").getUnsafeApi()
const enc = async (tx: any) => ({ encoded: await tx.getEncodedData(), decoded: tx.decodedCall })
const remark = (api: any, text: string) =>
  enc(api.tx.System.remark({ remark: new TextEncoder().encode(text) }))
const who = { type: "Id", value: "13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB" }
const up = await enc(ah.tx.System.authorize_upgrade({ code_hash: "0x" + "11".repeat(32) }))
const unchecked = await enc(
  ah.tx.System.authorize_upgrade_without_checks({ code_hash: "0x" + "22".repeat(32) }),
)
const transfer = await enc(
  ah.tx.Balances.force_transfer({ source: who, dest: who, value: 10n ** 10n }),
)
out.craftedUpgradeWithTransfer = toHex(
  (await enc(ah.tx.Utility.force_batch({ calls: [up.decoded, transfer.decoded] }))).encoded,
)
out.craftedUncheckedUpgrade = toHex(unchecked.encoded)
const r1 = await remark(relay, "visible"),
  r2 = await remark(relay, "hidden in appendix")
const transact = (bytes: Uint8Array) => ({
  type: "Transact",
  value: {
    origin_kind: { type: "Superuser", value: undefined },
    fallback_max_weight: undefined,
    call: bytes,
  },
})
const here = { parents: 0, interior: { type: "Here", value: undefined } }
const program = [
  {
    type: "UnpaidExecution",
    value: { weight_limit: { type: "Unlimited", value: undefined }, check_origin: undefined },
  },
  transact(r1.encoded),
  { type: "SetAppendix", value: [transact(r2.encoded)] },
  {
    type: "DepositAsset",
    value: {
      assets: { type: "Wild", value: { type: "All", value: undefined } },
      beneficiary: here,
    },
  },
]
out.craftedXcmWithAppendix = toHex(
  (
    await enc(
      ah.tx.PolkadotXcm.send({
        dest: { type: "V5", value: { parents: 1, interior: { type: "Here", value: undefined } } },
        message: { type: "V5", value: program },
      }),
    )
  ).encoded,
)
out.craftedIfElse = toHex(
  (
    await enc(
      ah.tx.Utility.if_else({
        main: (await remark(ah, "main")).decoded,
        fallback: transfer.decoded,
      }),
    )
  ).encoded,
)
out.craftedTransfer = toHex(transfer.encoded)
// An origin has the shape of a call, and must not be taken for one.
const collectives: any = getClient("collectives").getUnsafeApi()
out.craftedSubmit = toHex(
  (
    await enc(
      collectives.tx.FellowshipReferenda.submit({
        proposal_origin: {
          type: "FellowshipOrigins",
          value: { type: "Fellows", value: undefined },
        },
        proposal: { type: "Inline", value: new Uint8Array(2) },
        enactment_moment: { type: "After", value: 10 },
      }),
    )
  ).encoded,
)
// Versioned assets have the outer shape of an XCM program, and must not be taken for one.
const treasury = {
  type: "AccountId32",
  value: {
    network: undefined,
    id: "0x" + "6d6f646c70792f74727372790000000000000000000000000000000000000000",
  },
}
out.craftedTeleport = toHex(
  (
    await enc(
      ah.tx.PolkadotXcm.limited_teleport_assets({
        dest: { type: "V5", value: { parents: 1, interior: { type: "Here", value: undefined } } },
        beneficiary: {
          type: "V5",
          value: { parents: 0, interior: { type: "X1", value: treasury } },
        },
        assets: {
          type: "V5",
          value: [
            {
              id: { parents: 1, interior: { type: "Here", value: undefined } },
              fun: { type: "Fungible", value: 10n ** 16n },
            },
          ],
        },
        fee_asset_item: 0,
        weight_limit: { type: "Unlimited", value: undefined },
      }),
    )
  ).encoded,
)
writeFileSync("tests/fixtures.json", JSON.stringify(out, null, 2) + "\n")
for (const [k, v] of Object.entries(out)) console.log(k, (v.length - 2) / 2, "bytes")
process.exit(0)
