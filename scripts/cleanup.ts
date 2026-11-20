// Dev tool: show stale votes and locks for accounts, and the weight of the cleanup batch.
// Run with `npx tsx scripts/cleanup.ts [address...]`. Never signs or submits anything.
// With no address, it picks accounts that still have votes on record on the Root track.
import { toHex } from "polkadot-api/utils"
import { assetHubApi } from "../src/chains"
import { cleanupTx, loadCleanup } from "../src/gov/cleanup"

const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x))
let addresses = process.argv.slice(2)
if (addresses.length === 0) {
  const locks = await assetHubApi().query.ConvictionVoting.ClassLocksFor.getEntries()
  addresses = locks
    .filter((e) => e.value.some(([, amount]) => amount > 0n))
    .slice(0, 400)
    .map((e) => e.keyArgs[0])
}
let shown = 0
for (const address of addresses) {
  const cleanup = await loadCleanup(address)
  if (process.argv.length <= 2 && (cleanup.stale.length < 20 || shown >= 4)) continue
  shown++
  console.log(address, show({ ...cleanup, stale: cleanup.stale.length }))
  for (const vote of cleanup.stale.slice(0, 5)) console.log("   ", show(vote))
  if (cleanup.stale.length + cleanup.tracks.length === 0) continue
  const tx = cleanupTx(cleanup)
  const data = await tx.getEncodedData()
  console.log("    call", toHex(data).slice(0, 80), "…")
  const info = await assetHubApi().apis.TransactionPaymentCallApi.query_call_info(tx.decodedCall, data.length)
  console.log("    fee and weight", show(info))
}
process.exit(0)
