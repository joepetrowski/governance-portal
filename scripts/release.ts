// Dev tool: Run the release wizard's logic against a real release and live chains.
// Run with `npx tsx scripts/release.ts [tag]`. Never signs or submits anything.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as lib from "opengov"
import { toHex } from "polkadot-api/utils"
import { CHAINS, NETWORK_IDS } from "../src/chains"
import { loadSnapshot } from "../src/gov/load"
import {
  buildUpgrade,
  fellowshipSubmitTx,
  fetchRelease,
  parseTag,
  planRelease,
  publicSubmitTx,
} from "../src/gov/release"

const require = createRequire(import.meta.url)
await lib.default({ module_or_path: readFileSync(require.resolve("opengov/opengov_bg.wasm")) })

const tag = parseTag(process.argv[2] ?? "") ?? "latest"
const release = await fetchRelease(tag)
console.log("release", release.tag, release.publishedAt)
const plans = await planRelease(lib, release)
const direct = async (t: string, file: string) => {
  const url = `https://github.com/polkadot-fellows/runtimes/releases/download/${t}/${file}`
  return new Uint8Array(await (await fetch(url)).arrayBuffer())
}
const snap = await loadSnapshot()

for (const network of NETWORK_IDS) {
  console.log(`\n== ${network}`)
  const mine = plans.filter((p) => CHAINS[p.chain].network === network)
  for (const p of mine)
    console.log(
      "  ",
      p.chain,
      p.file,
      p.asset ? "found" : "MISSING",
      p.currentVersion,
      "->",
      p.newVersion,
    )
  const built = await buildUpgrade(
    lib,
    release,
    network,
    mine.filter((p) => p.asset),
    direct,
  )
  console.log("proposal hash", built.proposal.hash)
  console.log("public preimage", built.calls.public_preimage_hash, built.calls.public_preimage_len)
  console.log("submission deposit", built.submissionDeposit)
  const existing = snap.proposals.find(
    (p) => p.network === network && p.whitelist?.hash === built.proposal.hash,
  )
  console.log("already proposed:", existing ? `${existing.id} (${existing.title})` : "no")
  const fellowship = await (await fellowshipSubmitTx(built)).getEncodedData()
  console.log("fellowship tx", toHex(fellowship).slice(0, 60), "…")
  const open = await (await publicSubmitTx(built)).getEncodedData()
  console.log("public tx", toHex(open).slice(0, 60), "…")
}
process.exit(0)
