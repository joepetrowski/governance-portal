// Dev tool: check the last step of an upgrade against live chains. Run with
// `npx tsx scripts/apply.ts`. It reads which upgrades are authorized or scheduled, and builds the
// unsigned `apply_authorized_upgrade` transaction for one runtime without submitting it: the
// chain is only asked whether it would accept the transaction.
import { toHex } from "polkadot-api/utils"
import { type ChainId, CHAINS, getClient, NETWORK_IDS } from "../src/chains"
import { loadChainUpgrades, runtimeFileName } from "../src/gov/apply"
import { blake2Hex } from "../src/gov/decode"
import { loadReleaseHashes } from "../src/gov/versions"

// Node has no session storage, which the release reader tolerates.
const hashes = await loadReleaseHashes()
console.log("release hashes known:", Object.keys(hashes).length)
for (const network of NETWORK_IDS) {
  const upgrades = await loadChainUpgrades(network)
  console.log(network, "upgrades in progress:", upgrades.length)
  for (const u of upgrades)
    console.log("  ", CHAINS[u.chain].name, u.state, u.codeHash, hashes[u.codeHash] ?? "unknown")
}

// Ask each of two chains for its verdict: Bulletin, which has authorized nothing, and whichever
// chain has an upgrade waiting.
const [waiting] = (await Promise.all(NETWORK_IDS.map(loadChainUpgrades)))
  .flat()
  .filter((u) => u.state === "authorized" && hashes[u.codeHash])
const cases: [ChainId, string][] = [["bulletin", process.argv[2] ?? "v2.6.0"]]
if (waiting) cases.push([waiting.chain, hashes[waiting.codeHash]])

for (const [chain, tag] of cases) {
  const file = runtimeFileName(chain, tag)
  const url = `https://github.com/polkadot-fellows/runtimes/releases/download/${tag}/${file}`
  const code = new Uint8Array(await (await fetch(url)).arrayBuffer())
  const hash = blake2Hex(code)
  console.log(`\n${file}: ${code.length} bytes, hash ${hash}, in release ${hashes[hash] ?? "NONE"}`)

  const client = getClient(chain)
  const tx = client.getUnsafeApi().tx.System.apply_authorized_upgrade({ code })
  const bare = await tx.getBareTx()
  console.log("bare transaction:", bare.length, "bytes, starts", toHex(bare.subarray(0, 12)))
  // The runtime API takes the extrinsic as bytes and adds the length prefix itself, so the one
  // that the bare transaction already carries is removed.
  const prefix = [1, 2, 4][bare[0] & 3] ?? 5
  const block = await client.getFinalizedBlock()
  const validity = await client
    .getUnsafeApi()
    .apis.TaggedTransactionQueue.validate_transaction(
      { type: "External", value: undefined },
      bare.subarray(prefix),
      block.hash,
    )
  const show = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)
  console.log("verdict of", CHAINS[chain].name, JSON.stringify(validity, show).slice(0, 300))
}
process.exit(0)
