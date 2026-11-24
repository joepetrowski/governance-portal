// Dev tool: Check proxy reading and the calls made by proxy against the live Collectives chain.
// Run with `npx tsx scripts/proxies.ts [address...]`. Never signs or submits anything: The calls
// are only dry-run.
// With no address, it takes the accounts that Fellowship members have given a proxy to.
import { Binary } from "polkadot-api"
import { toHex } from "polkadot-api/utils"
import { blake2Hex } from "../src/gov/decode"
import { collectivesApi, decodeCallData } from "../src/chains"
import { loadSnapshot } from "../src/gov/load"
import { type FollowUpCall, followUpTx } from "../src/gov/followup"
import { asMember, loadMemberProxies, proxyFailure } from "../src/gov/proxy"
import { fellowshipSubmitAllTx, fellowshipSubmitTx } from "../src/gov/release"
import { decisionDepositTx, fellowshipVoteTx } from "../src/gov/votes"

const api = collectivesApi()
const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x))
let addresses = process.argv.slice(2)
if (addresses.length === 0) {
  // Proxies are kept by the account that gave them. No runtime API lists them.
  const entries = await api.query.Proxy.Proxies.getEntries()
  addresses = [...new Set(entries.flatMap((e) => e.value[0].map((d) => d.delegate)))]
}
// A submission as the wizard builds it, with a preimage, so that the batch around the proxy is
// checked too. Its proposal is a remark of the given byte.
async function sampleBuilt(byte: string): Promise<Parameters<typeof fellowshipSubmitTx>[0]> {
  const remark = Binary.fromHex("0x" + byte.repeat(200))
  const proposal = await api.tx.System.remark({ remark }).getEncodedData()
  const preimage = api.tx.Preimage.note_preimage({ bytes: proposal })
  const referendum = api.tx.FellowshipReferenda.submit({
    proposal_origin: { type: "FellowshipOrigins", value: { type: "Fellows", value: undefined } },
    proposal: { type: "Lookup", value: { hash: blake2Hex(proposal), len: proposal.length } },
    enactment_moment: { type: "After", value: 10 },
  })
  const calls = {
    fellowship_preimage: { encoded: toHex(await preimage.getEncodedData()) },
    fellowship_referendum: { encoded: toHex(await referendum.getEncodedData()) },
  }
  return { calls } as Parameters<typeof fellowshipSubmitTx>[0]
}
const builts = [await sampleBuilt("00"), await sampleBuilt("01")]
const proxies = await loadMemberProxies(addresses)
console.log("delayed", show(proxies.delayed))
for (const proxy of proxies.usable) console.log("usable", show(proxy))

const snap = await loadSnapshot()
const open = snap.proposals.flatMap((p) => p.fellowship ?? [])
// Without an open referendum the vote fails inside the proxy, which shows how that is reported.
const stage = open[0] ?? { body: "fellowship" as const, network: "polkadot" as const, index: 0 }
console.log("referendum", stage.index, open[0] ? `needs rank ${open[0].minRank}` : "(none open)")

const opened = { body: "fellowship" as const, network: "polkadot" as const, index: stage.index }
const followUpCalls: FollowUpCall[] = [
  { kind: "deposit", referendum: { ...opened, track: 3 } },
  { kind: "fellowshipAye", referendum: { ...opened, track: 3 } },
]

for (const proxy of proxies.usable.slice(0, 4)) {
  const rank = await api.query.FellowshipCollective.Members.getValue(proxy.real)
  console.log(`\n${proxy.delegate} for ${proxy.real} (rank ${rank}) as ${proxy.proxyType.type}`)
  for (const [name, tx] of [
    ["vote aye", asMember(fellowshipVoteTx(stage, true), proxy)],
    ["decision deposit", asMember(decisionDepositTx(stage), proxy)],
    ["open a referendum, noting its preimage", await fellowshipSubmitTx(builts[0], proxy)],
    ["open two referenda", await fellowshipSubmitAllTx(builts, proxy)],
    ["deposit and vote after opening", followUpTx(followUpCalls, proxy)],
  ] as const) {
    const data = await tx.getEncodedData()
    console.log(`  ${name}:`, toHex(data).slice(0, 200))
    const decoded = await decodeCallData("collectives", data)
    // Bytes are shown as hex, and long ones are cut short.
    const text = JSON.stringify(decoded, (_, x) =>
      x instanceof Uint8Array ? toHex(x).slice(0, 20) + "…" : typeof x === "bigint" ? `${x}n` : x,
    )
    console.log("   ", text)
    const run = await api.apis.DryRunApi.dry_run_call(
      { type: "system", value: { type: "Signed", value: proxy.delegate } },
      tx.decodedCall as never,
      5,
    )
    if (!run.success) {
      console.log("    dry run not possible:", show(run.value))
      continue
    }
    const outer = run.value.execution_result
    const inner = proxyFailure(run.value.emitted_events)
    console.log(
      "    transaction:",
      outer.success ? "ok" : show(outer.value.error),
      "| call by proxy:",
      inner ?? "ok",
    )
  }
}
process.exit(0)
