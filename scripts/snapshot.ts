// Dev tool: print the governance snapshot the UI renders. Run with `npx tsx scripts/snapshot.ts`.
import { loadSnapshot } from "../src/gov/load"
import { walk, chainLabel } from "../src/gov/decode"

const snap = await loadSnapshot()
for (const p of snap.proposals) {
  console.log(`\n== [${p.kind}] ${p.title}  (${p.id})`)
  if (p.whitelist) console.log("   whitelist", p.whitelist)
  for (const s of [p.fellowship, p.open]) {
    if (!s) continue
    console.log(`   ${s.body} #${s.index} track=${s.track} status=${JSON.stringify(s.status)} now=${s.now}`)
    console.log(`     approval ${s.approval.current} / ${s.approval.required.toFixed(4)}  support ${s.support.current.toFixed(6)} / ${s.support.required.toFixed(6)} passing=${s.passing} ayes=${s.ayes} nays=${s.nays}`)
  }
  if (p.call) for (const n of walk(p.call)) console.log(`     - ${chainLabel(n.chain)}: ${n.undecoded ? "UNDECODED " + n.undecoded : n.pallet + "." + n.name}`)
}
process.exit(0)
