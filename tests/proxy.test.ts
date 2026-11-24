// Acting for a Fellowship member by proxy: which proxies can be used, who acts, and how a call
// that failed inside a proxy is told from one that went through.

import { describe, expect, it, vi } from "vitest"
import { followUp, followUpTx } from "../src/gov/followup"
import {
  accountKey,
  actorsFor,
  asMember,
  type FoundProxy,
  pickActor,
  proxyFailure,
  sameAccount,
  usableProxies,
} from "../src/gov/proxy"
import { fellowshipVoteTx } from "../src/gov/votes"
import { type TxState, watchTx } from "../src/ui/tx"

vi.mock("../src/chains", async (original) => ({
  ...(await original<typeof import("../src/chains")>()),
  ...(await import("./offline")),
  holdClients: () => () => {},
}))

// Accounts of the live chain: two members, and an account that each has given a proxy to.
const MEMBER = "16a357f5Sxab3V2ne4emGQvqJaCLeYpTMx3TCjnQhmJQ71DX"
const OTHER_MEMBER = "16JskuojL6mSp6HNcjiHYa9jqksWbLD8L9YGWU1ppiPWQ9sa"
const HOT = "13TRAXTALwNp5vApqwiE74fg8G8ypMyaF9TxRfs4RwrCwxUE"
// The same account as `HOT`, as a wallet writes it, with the generic prefix.
const HOT_GENERIC = "5EX82CC6VA7LePAJtJfDxuqXGe9L84RSAejUGNshsrpgmTsV"

const fellowship = { type: "Fellowship", value: undefined } as FoundProxy["proxyType"]
const any = { type: "Any", value: undefined } as FoundProxy["proxyType"]
const found = (change: Partial<FoundProxy> = {}): FoundProxy => ({
  delegate: HOT,
  real: MEMBER,
  proxyType: fellowship,
  notesPreimage: false,
  delay: 0,
  ...change,
})

describe("accounts", () => {
  it("tells one account written with two prefixes to be the same", () => {
    expect(accountKey(HOT_GENERIC)).toBe(accountKey(HOT))
    expect(sameAccount(HOT, HOT_GENERIC)).toBe(true)
    expect(sameAccount(HOT, MEMBER)).toBe(false)
  })

  it("matches nothing with what is no address", () => {
    expect(accountKey("not an address")).toBeNull()
    expect(sameAccount("not an address", "not an address")).toBe(false)
  })
})

describe("usableProxies", () => {
  it("uses a proxy without a delay", () => {
    expect(usableProxies([found()], [HOT])).toEqual({
      usable: [{ delegate: HOT, real: MEMBER, proxyType: fellowship, notesPreimage: false }],
      delayed: [],
    })
  })

  it("leaves out a proxy with a delay, and says so", () => {
    expect(usableProxies([found({ delay: 10 })], [HOT])).toEqual({
      usable: [],
      delayed: [{ delegate: HOT, real: MEMBER }],
    })
  })

  it("uses the first proxy without a delay of several between two accounts", () => {
    const proxies = [found({ delay: 10 }), found({ proxyType: any }), found()]
    expect(usableProxies(proxies, [HOT])).toEqual({
      usable: [{ delegate: HOT, real: MEMBER, proxyType: any, notesPreimage: false }],
      delayed: [],
    })
  })

  it("prefers a proxy that may note a preimage, unless it has a delay", () => {
    const noting = { proxyType: any, notesPreimage: true }
    expect(usableProxies([found(), found(noting)], [HOT]).usable).toEqual([
      { delegate: HOT, real: MEMBER, ...noting },
    ])
    expect(usableProxies([found(), found({ ...noting, delay: 10 })], [HOT]).usable).toEqual([
      { delegate: HOT, real: MEMBER, proxyType: fellowship, notesPreimage: false },
    ])
  })

  it("needs no proxy for a member whose own account is in the wallet", () => {
    expect(usableProxies([found()], [HOT_GENERIC, MEMBER])).toEqual({ usable: [], delayed: [] })
  })

  it("keeps the proxies of different members apart", () => {
    const { usable } = usableProxies([found(), found({ real: OTHER_MEMBER })], [HOT])
    expect(usable.map((p) => p.real)).toEqual([MEMBER, OTHER_MEMBER])
  })
})

describe("who acts", () => {
  const proxy = { delegate: HOT, real: MEMBER, proxyType: fellowship, notesPreimage: false }
  const other = { delegate: HOT, real: OTHER_MEMBER, proxyType: fellowship, notesPreimage: false }
  const own = { address: HOT_GENERIC, rank: null }
  const members = [
    { address: OTHER_MEMBER, rank: 2 },
    { address: MEMBER, rank: 3 },
  ]

  it("offers the account itself and the members it is a proxy for, highest rank first", () => {
    const options = actorsFor(HOT_GENERIC, [own], [other, proxy], members)
    expect(options.map((o) => [o.status.address, o.proxy?.real ?? null])).toEqual([
      [HOT_GENERIC, null],
      [MEMBER, MEMBER],
      [OTHER_MEMBER, OTHER_MEMBER],
    ])
  })

  it("lets nobody act until the account itself has been read", () => {
    expect(pickActor(actorsFor(HOT_GENERIC, [], [proxy], members), undefined)).toBeNull()
  })

  it("offers nothing by a proxy that another account holds", () => {
    expect(actorsFor(MEMBER, [], [proxy], members)).toEqual([])
  })

  it("leaves out an account that gave a proxy and is no member, or is not read yet", () => {
    expect(actorsFor(HOT, [], [proxy], [{ address: MEMBER, rank: null }])).toEqual([])
    expect(actorsFor(HOT, [], [proxy], [])).toEqual([])
  })

  it("acts for the member when the account itself is none", () => {
    const options = actorsFor(HOT_GENERIC, [own], [proxy, other], members)
    expect(pickActor(options, undefined)?.status.address).toBe(MEMBER)
  })

  it("acts as itself when the account is a member, until the visitor chooses otherwise", () => {
    const options = actorsFor(HOT_GENERIC, [{ address: HOT_GENERIC, rank: 1 }], [proxy], members)
    expect(pickActor(options, undefined)?.proxy).toBeNull()
    expect(pickActor(options, MEMBER)?.proxy).toEqual(proxy)
  })

  it("falls back when the chosen one is no longer offered", () => {
    const options = actorsFor(HOT_GENERIC, [own], [proxy], members)
    expect(pickActor(options, OTHER_MEMBER)?.status.address).toBe(MEMBER)
  })

  it("is the account itself when it has no proxy and is no member, and nobody without one", () => {
    expect(pickActor(actorsFor(HOT_GENERIC, [own], [], []), undefined)?.status).toBe(own)
    expect(pickActor(actorsFor(HOT_GENERIC, [], [], []), undefined)).toBeNull()
  })
})

const executed = (result: unknown) => ({
  type: "Proxy",
  value: { type: "ProxyExecuted", value: { result } },
})
const rankTooLow = {
  success: false,
  value: { type: "Module", value: { type: "FellowshipCollective", value: { type: "RankTooLow" } } },
}

describe("proxyFailure", () => {
  it("finds nothing wrong when the call went through, or when there was no proxy", () => {
    expect(proxyFailure([executed({ success: true, value: undefined })])).toBeNull()
    expect(proxyFailure([{ type: "System", value: { type: "ExtrinsicSuccess" } }])).toBeNull()
    expect(proxyFailure([null, "event", {}])).toBeNull()
  })

  it("names the error of a call that failed inside the proxy", () => {
    expect(proxyFailure([executed(rankTooLow)])).toBe("FellowshipCollective.RankTooLow")
    expect(proxyFailure([executed({ success: false, value: { type: "BadOrigin" } })])).toBe(
      "BadOrigin",
    )
  })
})

describe("watchTx", () => {
  const follow = (events: unknown[]) => {
    const states: TxState[] = []
    const finalized = vi.fn()
    watchTx(
      { subscribe: (o) => o.next({ type: "finalized", ok: true, events }) },
      (state) => states.push(state),
      finalized,
    )
    return { last: states.at(-1), finalized }
  }

  it("counts a transaction as failed when its call by proxy failed", () => {
    const { last, finalized } = follow([executed(rankTooLow)])
    expect(last).toEqual({
      step: "failed",
      reason: "The call made by proxy was rejected by the chain: FellowshipCollective.RankTooLow",
    })
    expect(finalized).not.toHaveBeenCalled()
  })

  it("finalizes a transaction whose call by proxy went through", () => {
    const { last, finalized } = follow([executed({ success: true, value: undefined })])
    expect(last).toEqual({ step: "finalized" })
    expect(finalized).toHaveBeenCalledOnce()
  })
})

describe("followUp by proxy", () => {
  const opened = [{ body: "fellowship" as const, network: "polkadot" as const, index: 7, track: 3 }]
  const proxy = { delegate: HOT, real: MEMBER, proxyType: fellowship, notesPreimage: false }
  const deposits = new Map([[3, 50_000_000_000n]])

  it("says for whom the calls are made, and whose account pays the deposit", () => {
    const plan = followUp(opened, { deposit: true, aye: true }, deposits, proxy)
    expect(plan?.description).toBe(
      "Place the decision deposit of 5 DOT and vote aye on Fellowship referendum #7. " +
        `Made by proxy for ${MEMBER}, whose account pays the deposit.`,
    )
  })

  it("says nothing of a deposit when there is none", () => {
    const plan = followUp(opened, { deposit: false, aye: true }, deposits, proxy)
    expect(plan?.description).toBe(
      `Vote aye on Fellowship referendum #7. Made by proxy for ${MEMBER}.`,
    )
  })

  it("says nothing of a proxy when there is none", () => {
    const plan = followUp(opened, { deposit: false, aye: true }, deposits)
    expect(plan?.description).toBe("Vote aye on Fellowship referendum #7.")
  })
})

describe("calls by proxy", () => {
  const proxy = { delegate: HOT, real: MEMBER, proxyType: fellowship, notesPreimage: false }
  const referendum = {
    body: "fellowship" as const,
    network: "polkadot" as const,
    index: 7,
    track: 3,
  }
  const vote = {
    type: "FellowshipCollective",
    value: { type: "vote", value: { poll: 7, aye: true } },
  }
  const viaProxy = (call: unknown) => ({
    type: "Proxy",
    value: {
      type: "proxy",
      value: { real: { type: "Id", value: MEMBER }, force_proxy_type: fellowship, call },
    },
  })

  it("leaves a call as it is without a proxy", () => {
    const tx = fellowshipVoteTx(referendum, true)
    expect(asMember(tx, null)).toBe(tx)
    expect(tx.decodedCall).toEqual(vote)
  })

  it("wraps a call for the member, naming the kind of proxy", () => {
    expect(asMember(fellowshipVoteTx(referendum, true), proxy).decodedCall).toEqual(viaProxy(vote))
  })

  it("makes the deposit and the vote in one batch inside the proxy", () => {
    const calls = [
      { kind: "deposit" as const, referendum },
      { kind: "fellowshipAye" as const, referendum },
    ]
    const deposit = {
      type: "FellowshipReferenda",
      value: { type: "place_decision_deposit", value: { index: 7 } },
    }
    const batch = {
      type: "Utility",
      value: { type: "batch_all", value: { calls: [deposit, vote] } },
    }
    expect(followUpTx(calls, proxy).decodedCall).toEqual(viaProxy(batch))
    expect(followUpTx(calls).decodedCall).toEqual(batch)
    expect(followUpTx([calls[1]], proxy).decodedCall).toEqual(viaProxy(vote))
  })

  it("refuses to act on a public referendum by a Fellowship proxy", () => {
    const open = { ...referendum, body: "open" as const }
    expect(() => followUpTx([{ kind: "deposit", referendum: open }], proxy)).toThrow(
      "cannot act on a public referendum",
    )
  })
})
