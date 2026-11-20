// Dev tool: Check vote reading and vote call encoding against live chains.
// Run with `npx tsx scripts/votes.ts [address...]`. Never signs or submits anything.
import { toHex } from "polkadot-api/utils"
import { collectivesApi, decodeCallData } from "../src/chains"
import { loadSnapshot } from "../src/gov/load"
import { fellowshipVoteTx, loadAccountStatus, loadLockDays, openVoteTx } from "../src/gov/votes"

const snap = await loadSnapshot()
const stages = snap.proposals.flatMap((p) => [p.fellowship, p.open]).filter((s) => !!s)
let addresses = process.argv.slice(2)
if (addresses.length === 0) {
  // Default to the members who voted on the newest Fellowship referendum.
  const newest = Math.max(...stages.filter((s) => s.body === "fellowship").map((s) => s.index))
  const entries = await collectivesApi().query.FellowshipCollective.Voting.getEntries(newest)
  addresses = entries.map((e) => e.keyArgs[1]).slice(0, 4)
}
for (const address of addresses) {
  const status = await loadAccountStatus(address, stages)
  console.log(address, "rank", status.rank, "balance", status.balance)
  for (const [key, vote] of Object.entries(status.votes))
    if (vote.type !== "none") console.log("   ", key, JSON.stringify(vote))
}
console.log("lock days", await loadLockDays("polkadot"))

const open = stages.find((s) => s.body === "open")
const fellowship = stages.find((s) => s.body === "fellowship")
const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x))
if (open) {
  for (const vote of [
    { direction: "aye", amount: 15_000_000_000n, conviction: 2 },
    { direction: "nay", amount: 10_000_000_000n, conviction: 0 },
    { direction: "abstain", amount: 10_000_000_000n, conviction: 0 },
  ] as const) {
    const data = await openVoteTx(open, vote).getEncodedData()
    console.log(vote.direction, toHex(data), show(await decodeCallData("assetHub", data)))
  }
}
if (fellowship) {
  const data = await fellowshipVoteTx(fellowship, true).getEncodedData()
  console.log("fellowship aye", toHex(data), show(await decodeCallData("collectives", data)))
}
process.exit(0)
