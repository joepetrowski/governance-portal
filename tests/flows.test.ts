// Opening a referendum and then placing its deposit and voting, as two transactions.

import { describe, expect, it, vi } from "vitest"
import type { FollowUpCall } from "../src/gov/followup"
import type { Account } from "../src/wallet"

vi.mock("../src/chains", async (original) => ({
  ...(await original<typeof import("../src/chains")>()),
  ...(await import("./offline")),
}))

/** A transaction that records the observer of whoever follows it, in place of a wallet. */
function fakeTx() {
  type Observer = { next: (event: object) => void; error: (e: unknown) => void }
  const tx = {
    observer: null as Observer | null,
    createSubmitAndWatch: () => ({ subscribe: (o: Observer) => void (tx.observer = o) }),
    finalize: (events: unknown[] = []) =>
      tx.observer?.next({ type: "finalized", ok: true, events }),
  }
  return tx
}

// The second transaction is built from the calls it is given. What they are is recorded here.
const second = { calls: [] as FollowUpCall[][], txs: [] as ReturnType<typeof fakeTx>[] }
vi.mock("../src/gov/followup", async (original) => ({
  ...(await original<typeof import("../src/gov/followup")>()),
  decisionDeposits: async () => [{ id: 3, name: "fellows", deposit: 50_000_000_000n }],
  followUpTx: (calls: FollowUpCall[]) => {
    second.calls.push(calls)
    second.txs.push(fakeTx())
    return second.txs.at(-1)
  },
}))

const { flowActive, flowSubmitted, getFlow, startFlow } = await import("../src/ui/flows")

const submitted = (index: number) => ({
  type: "FellowshipReferenda",
  value: { type: "Submitted", value: { index, track: 3 } },
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let serial = 0
/** Start a flow of a new key, and return what the test drives and observes. */
async function start(choice: { deposit: boolean; aye: boolean }) {
  const key = `test-${++serial}`
  const first = fakeTx()
  const makeTx = vi.fn(async () => first)
  const onDone = vi.fn()
  const opts = {
    key,
    title: "A test referendum",
    body: "fellowship" as const,
    network: "polkadot" as const,
    account: { txCreator: {} } as unknown as Account,
    makeTx,
    choice,
    onDone,
  }
  startFlow(opts)
  await settle()
  return { key, first, makeTx, onDone, opts, seconds: second.txs.length }
}

describe("startFlow", () => {
  it("asks for the second signature on the referendum that the submission opened", async () => {
    const flow = await start({ deposit: true, aye: true })
    expect(getFlow(flow.key)?.first).toEqual({ step: "signing" })
    expect(second.txs).toHaveLength(flow.seconds)

    flow.first.finalize([submitted(684)])
    await settle()
    expect(second.calls.at(-1)).toEqual([
      {
        kind: "deposit",
        referendum: { body: "fellowship", network: "polkadot", index: 684, track: 3 },
      },
      {
        kind: "fellowshipAye",
        referendum: { body: "fellowship", network: "polkadot", index: 684, track: 3 },
      },
    ])
    // What it does is on the page while the wallet is asked.
    expect(getFlow(flow.key)).toMatchObject({
      next: "Place the decision deposit of 5 DOT and vote aye on Fellowship referendum #684.",
      second: { step: "signing" },
      deposit: true,
      over: false,
    })
    expect(flow.onDone).not.toHaveBeenCalled()

    second.txs.at(-1)?.finalize()
    expect(getFlow(flow.key)).toMatchObject({ second: { step: "finalized" }, over: true })
    expect(flow.onDone).toHaveBeenCalledTimes(1)
  })

  it("sends no second transaction when nothing was chosen", async () => {
    const flow = await start({ deposit: false, aye: false })
    flow.first.finalize([submitted(685)])
    await settle()
    expect(second.txs).toHaveLength(flow.seconds)
    expect(getFlow(flow.key)).toMatchObject({ next: null, over: true })
    expect(flow.onDone).toHaveBeenCalledTimes(1)
  })

  it("sends none, and says so, when the events name no referendum", async () => {
    const flow = await start({ deposit: true, aye: true })
    flow.first.finalize([{ type: "System", value: { type: "ExtrinsicSuccess", value: {} } }])
    await settle()
    expect(second.txs).toHaveLength(flow.seconds)
    expect(getFlow(flow.key)?.error).toMatch(/name no referendum/)
    expect(flow.onDone).toHaveBeenCalledTimes(1)
  })

  it("does not start again while it is under way, or after it went through", async () => {
    const flow = await start({ deposit: true, aye: true })
    startFlow(flow.opts)
    flow.first.observer?.next({ type: "inBestBlock", ok: true, events: [submitted(686)] })
    expect(flowSubmitted(getFlow(flow.key))).toBe(true)
    startFlow(flow.opts)
    // Being in a block is not finality, so nothing follows yet.
    await settle()
    expect(second.txs).toHaveLength(flow.seconds)
    flow.first.finalize([submitted(686)])
    await settle()
    startFlow(flow.opts)
    await settle()
    expect(flow.makeTx).toHaveBeenCalledTimes(1)
    expect(second.txs).toHaveLength(flow.seconds + 1)
  })

  it("ends once when the second transaction is declined or fails", async () => {
    const flow = await start({ deposit: true, aye: false })
    flow.first.finalize([submitted(687)])
    await settle()
    second.txs.at(-1)?.observer?.error(new Error("Cancelled"))
    expect(getFlow(flow.key)).toMatchObject({
      second: { step: "failed", reason: "Cancelled" },
      over: true,
    })
    // It stays active, so that the referendum that is open is not offered again.
    expect(flowActive(getFlow(flow.key))).toBe(true)
    expect(flow.onDone).toHaveBeenCalledTimes(1)
  })

  it("may be tried again after the submission was declined", async () => {
    const flow = await start({ deposit: true, aye: true })
    flow.first.observer?.error(new Error("Cancelled"))
    expect(flowActive(getFlow(flow.key))).toBe(false)
    expect(second.txs).toHaveLength(flow.seconds)
    startFlow(flow.opts)
    await settle()
    expect(flow.makeTx).toHaveBeenCalledTimes(2)
    expect(getFlow(flow.key)?.first).toEqual({ step: "signing" })
  })

  it("is not written over by a transaction of an earlier attempt", async () => {
    const flow = await start({ deposit: true, aye: true })
    const earlier = flow.first.observer
    earlier?.next({ type: "inBestBlock", ok: false, dispatchError: { type: "Other" } })
    expect(flowActive(getFlow(flow.key))).toBe(false)
    startFlow(flow.opts)
    await settle()
    // The earlier transaction is finalized as failed while the new one waits for a signature.
    earlier?.next({ type: "finalized", ok: false, dispatchError: { type: "Other" } })
    expect(getFlow(flow.key)?.first).toEqual({ step: "signing" })
  })

  it("makes no second transaction when the chain rejected the submission", async () => {
    const flow = await start({ deposit: true, aye: true })
    flow.first.observer?.next({ type: "finalized", ok: false, dispatchError: { type: "Other" } })
    await settle()
    expect(second.txs).toHaveLength(flow.seconds)
    expect(getFlow(flow.key)?.first.step).toBe("failed")
  })
})
