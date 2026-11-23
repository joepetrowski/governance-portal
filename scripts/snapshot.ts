// Dev tool: Print the governance snapshot the UI renders. Run with `npx tsx scripts/snapshot.ts`.
import { loadFinished } from "../src/gov/finished"
import { loadSnapshot } from "../src/gov/load"
import { walk, chainLabel } from "../src/gov/decode"

// An anchor such as "polkadot-1973" may be given, to read that referendum if it has ended.
const snap = await loadSnapshot()
const started = Date.now()
const finished = await loadFinished(snap, process.argv[2] ?? null)
console.log(`${finished.length} finished, read in ${Date.now() - started} ms`)
for (const p of [...snap.proposals, ...finished]) {
  console.log(`\n== [${p.kind}] ${p.title}  (${p.id})`)
  if (p.whitelist) console.log("   whitelist", p.whitelist)
  for (const s of [p.fellowship, p.endedFellowship, p.open]) {
    if (!s) continue
    console.log(
      `   ${s.body} #${s.index} track=${s.track} status=${JSON.stringify(s.status)} now=${s.now}`,
    )
    console.log(
      `     approval ${s.approval.current} / ${s.approval.required.toFixed(4)}` +
        `  support ${s.support.current.toFixed(6)} / ${s.support.required.toFixed(6)}` +
        ` passing=${s.passing} ayes=${s.ayes} nays=${s.nays}`,
    )
  }
  if (p.call)
    for (const n of walk(p.call))
      console.log(
        `     - ${chainLabel(n.chain)}:`,
        n.undecoded ? `UNDECODED ${n.undecoded}` : `${n.pallet}.${n.name}`,
      )
}
process.exit(0)
