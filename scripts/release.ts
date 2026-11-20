// Dev tool: run the release wizard's logic against a real release and live chains.
// Run with `npx tsx scripts/release.ts [tag]`. Never signs or submits anything.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as lib from "opengov"
import { toHex } from "polkadot-api/utils"
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
for (const p of plans)
  console.log(
    "  ",
    p.chain,
    p.file,
    p.asset ? "found" : "MISSING",
    p.currentVersion,
    "->",
    p.newVersion,
  )

const direct = async (t: string, file: string) =>
  new Uint8Array(
    await (
      await fetch(`https://github.com/polkadot-fellows/runtimes/releases/download/${t}/${file}`)
    ).arrayBuffer(),
  )
const built = await buildUpgrade(lib, release, plans, direct, (d, n) =>
  console.log(`   downloaded ${d} of ${n}`),
)
console.log("proposal hash", built.proposal.hash)
console.log("public preimage", built.calls.public_preimage_hash, built.calls.public_preimage_len)
const snap = await loadSnapshot()
const existing = snap.proposals.find((p) => p.whitelist?.hash === built.proposal.hash)
console.log("already proposed:", existing ? `${existing.id} (${existing.title})` : "no")
console.log(
  "fellowship tx",
  toHex(await (await fellowshipSubmitTx(built)).getEncodedData()).slice(0, 60),
  "…",
)
console.log(
  "public tx",
  toHex(await (await publicSubmitTx(built)).getEncodedData()).slice(0, 60),
  "…",
)
process.exit(0)
