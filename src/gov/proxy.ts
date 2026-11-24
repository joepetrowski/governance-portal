// Acting in the Fellowship by proxy. A member can let another account make calls for it on
// Collectives, with `Proxy.add_proxy`. The portal finds the members that a wallet account may act
// for, and wraps the Fellowship calls of that account in `Proxy.proxy`.
//
// How the pallet behaves, from `substrate/frame/proxy/src/lib.rs`:
//
// - `Proxy.proxy` takes the first proxy that the member has given to the signer. If that one does
//   not permit the call, the call fails, even when a later one would permit it. So the portal
//   names the type of the proxy that it found to permit the call.
// - A proxy with a delay must announce a call and wait. The portal does not do that, and leaves
//   such a proxy out.
// - `Proxy.proxy` succeeds when the call inside it fails. The failure is only in its
//   `ProxyExecuted` event. See `proxyFailure`.

import { MultiAddress } from "@polkadot-api/descriptors"
import { AccountId, Binary } from "polkadot-api"
import { toHex } from "polkadot-api/utils"
import { collectivesApi } from "../chains"

type Api = ReturnType<typeof collectivesApi>
type Definition = Awaited<ReturnType<Api["query"]["Proxy"]["Proxies"]["getValue"]>>[0][number]

/** What a proxy on Collectives may do, such as `Fellowship` or `Any`, as the chain names it. */
export type ProxyType = Definition["proxy_type"]

/** A wallet account that may act at once for a Fellowship member on Collectives. */
export interface MemberProxy {
  /** The wallet account, which signs and pays the fee. */
  delegate: string
  /** The member that the calls are made for. */
  real: string
  /** The kind of proxy, which permits the Fellowship calls that the portal makes. */
  proxyType: ProxyType
  /**
   * Whether this kind of proxy may also note a preimage for the member, as `NonTransfer` and
   * `Any` may and `Fellowship` may not. If not, the signer notes it and pays its deposit.
   */
  notesPreimage: boolean
}

/** A proxy that a member has given to a wallet account, of a kind that is of use here. */
export interface FoundProxy extends MemberProxy {
  /** Blocks that a call must be announced ahead. Only a proxy with none can be used. */
  delay: number
}

/** The proxies of the wallet's accounts for Fellowship members. */
export interface MemberProxies {
  /** Those that the portal can use, at most one for each pair of accounts. */
  usable: MemberProxy[]
  /** Pairs whose only proxies have a delay, which the portal does not support. */
  delayed: Pick<MemberProxy, "delegate" | "real">[]
}

const codec = AccountId()

/**
 * The public key of an address, by which two addresses of one account are told to be the same.
 * Wallets and chains write the same account with different prefixes. Null if it is no address.
 */
export function accountKey(address: string): string | null {
  try {
    return toHex(codec.enc(address))
  } catch {
    return null
  }
}

/** Whether two addresses are of one account. */
export const sameAccount = (a: string, b: string): boolean => {
  const key = accountKey(a)
  return key !== null && key === accountKey(b)
}

/**
 * Sort the proxies found into those that can be used and those that cannot for their delay. Of
 * several between the same two accounts, the first without a delay that may note a preimage is
 * used, and failing that the first without a delay. An account is never its own proxy here, and
 * a member whose own account is in the wallet needs none.
 */
export function usableProxies(found: FoundProxy[], wallet: string[]): MemberProxies {
  const own = new Set(wallet.map(accountKey))
  const pairs = new Map<string, FoundProxy[]>()
  for (const proxy of found) {
    if (own.has(accountKey(proxy.real))) continue
    const pair = `${accountKey(proxy.delegate)}>${accountKey(proxy.real)}`
    pairs.set(pair, [...(pairs.get(pair) ?? []), proxy])
  }
  const result: MemberProxies = { usable: [], delayed: [] }
  for (const proxies of pairs.values()) {
    const prompt = proxies.filter((p) => p.delay === 0)
    const ready = prompt.find((p) => p.notesPreimage) ?? prompt[0]
    const { delegate, real } = proxies[0]
    if (ready) {
      const { proxyType, notesPreimage } = ready
      result.usable.push({ delegate, real, proxyType, notesPreimage })
    } else result.delayed.push({ delegate, real })
  }
  return result
}

/**
 * What a kind of proxy permits. `fellowship` is whether it permits every Fellowship call that the
 * portal makes: a vote, a submission, a decision deposit, and a batch of them. `preimage` is whether it permits
 * noting a preimage. The chain is asked through the view function of the proxy pallet, so that no
 * list of kinds is kept here. The runtime decides by the pallet and the call, so the arguments of
 * the calls asked about do not matter.
 */
async function permissions(
  proxyType: ProxyType,
): Promise<{ fellowship: boolean; preimage: boolean }> {
  const api = collectivesApi()
  const calls = [
    api.tx.FellowshipCollective.vote({ poll: 0, aye: true }),
    api.tx.FellowshipReferenda.place_decision_deposit({ index: 0 }),
    api.tx.FellowshipReferenda.submit({
      proposal_origin: { type: "FellowshipOrigins", value: { type: "Fellows", value: undefined } },
      proposal: { type: "Inline", value: Binary.fromHex("0x00") },
      enactment_moment: { type: "After", value: 0 },
    }),
    api.tx.Preimage.note_preimage({ bytes: Binary.fromHex("0x00") }),
  ]
  // Several calls for a member go in one batch inside the proxy, which the kind must permit too.
  const batch = api.tx.Utility.batch_all({ calls: [calls[0].decodedCall] as never })
  // A decoded call is typed loosely. These are calls of this chain, built just above.
  const answers = await Promise.all(
    [...calls, batch].map((tx) =>
      api.view.Proxy.check_permissions(tx.decodedCall as never, proxyType),
    ),
  )
  const [vote, deposit, submit, preimage, batched] = answers
  return { fellowship: vote && deposit && submit && batched, preimage }
}

/**
 * The Fellowship members that the given wallet accounts may act for on Collectives.
 *
 * The chain keeps proxies by the account that gave them, so finding those given to an account
 * means reading them all. There are few on Collectives. No runtime API or view function lists
 * them, nor the members, so both are read from storage.
 */
export async function loadMemberProxies(wallet: string[]): Promise<MemberProxies> {
  const api = collectivesApi()
  const keys = new Map(wallet.map((address) => [accountKey(address), address]))
  const entries = await api.query.Proxy.Proxies.getEntries()
  const given = entries.flatMap((entry) =>
    entry.value[0].flatMap((definition) => {
      const delegate = keys.get(accountKey(definition.delegate))
      return delegate === undefined
        ? []
        : [
            {
              delegate,
              real: entry.keyArgs[0],
              proxyType: definition.proxy_type,
              delay: definition.delay,
            },
          ]
    }),
  )
  if (given.length === 0) return { usable: [], delayed: [] }

  const reals = [...new Set(given.map((p) => p.real))]
  const kinds = [...new Set(given.map((p) => p.proxyType.type))]
  const [ranks, permitted] = await Promise.all([
    api.query.FellowshipCollective.Members.getValues(reals.map((real) => [real] as [string])),
    Promise.all(
      kinds.map((kind) => permissions(given.find((p) => p.proxyType.type === kind)!.proxyType)),
    ),
  ])
  const members = new Set(reals.filter((_, i) => ranks[i] !== undefined))
  const allowed = new Map(kinds.map((kind, i) => [kind, permitted[i]]))
  return usableProxies(
    given
      .filter((p) => members.has(p.real) && allowed.get(p.proxyType.type)?.fellowship)
      .map((p) => ({ ...p, notesPreimage: allowed.get(p.proxyType.type)?.preimage ?? false })),
    wallet,
  )
}

/** A transaction of Collectives, as far as wrapping it needs. */
type CollectivesTx = ReturnType<Api["tx"]["FellowshipCollective"]["vote"]>

/**
 * The transaction that makes a call of Collectives for a member, by proxy, or the transaction
 * itself when there is no proxy. The signer pays the fee. Whatever the call takes or reserves
 * comes from the member's account.
 */
export function asMember<T extends Pick<CollectivesTx, "decodedCall">>(
  tx: T,
  proxy: MemberProxy | null,
): T | ReturnType<Api["tx"]["Proxy"]["proxy"]> {
  if (!proxy) return tx
  return collectivesApi().tx.Proxy.proxy({
    real: MultiAddress.Id(proxy.real),
    force_proxy_type: proxy.proxyType,
    call: tx.decodedCall,
  })
}

/** Flatten a dispatch error such as Module(FellowshipCollective(RankTooLow)) to its names. */
export function dispatchErrorName(error: unknown): string {
  const names: string[] = []
  let current = error
  while (typeof current === "object" && current !== null && "type" in current) {
    names.push(String((current as { type: unknown }).type))
    current = (current as { value?: unknown }).value
  }
  return names.filter((n) => n !== "Module").join(".") || "unknown error"
}

/**
 * Why a call made by proxy failed, from the events of its transaction, or null if none did. A
 * transaction with `Proxy.proxy` in it succeeds when the call inside fails, and says so only in
 * the `ProxyExecuted` event.
 */
export function proxyFailure(events: unknown[]): string | null {
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue
    const { type, value } = event as { type?: unknown; value?: { type?: unknown; value?: unknown } }
    if (type !== "Proxy" || value?.type !== "ProxyExecuted") continue
    const { result } = (value.value ?? {}) as { result?: { success?: unknown; value?: unknown } }
    if (result?.success === false) return dispatchErrorName(result.value)
  }
  return null
}

/** The part of an account's status that deciding who acts needs. */
interface Ranked {
  /** The account. */
  address: string
  /** Fellowship rank, or null if not a member. */
  rank: number | null
}

/** Who acts in the Fellowship when the selected wallet account signs. */
export interface Actor<S extends Ranked = Ranked> {
  /** What is known of the account that acts: a member, or the selected account itself. */
  status: S
  /** How the selected account acts for the member. Null when it acts for itself. */
  proxy: MemberProxy | null
}

/**
 * Whom the selected account can act as in the Fellowship: itself first, if it is known, and then
 * each member that it is a proxy for, from the highest rank down. `statuses` are those of the
 * wallet's accounts, and `members` those of the accounts that gave the proxies. An account that
 * has given a proxy and is no member, or is not read yet, is left out.
 */
export function actorsFor<S extends Ranked>(
  selected: string | undefined,
  statuses: S[],
  proxies: MemberProxy[],
  members: S[],
): Actor<S>[] {
  if (selected === undefined) return []
  const own = statuses.find((s) => s.address === selected)
  const proxied = proxies
    .filter((proxy) => sameAccount(proxy.delegate, selected))
    .flatMap((proxy) => {
      const status = members.find((m) => sameAccount(m.address, proxy.real))
      return status && status.rank !== null ? [{ status, proxy }] : []
    })
    .sort((a, b) => (b.status.rank ?? 0) - (a.status.rank ?? 0))
  return [...(own ? [{ status: own, proxy: null }] : []), ...proxied]
}

/** Whether an actor can do anything in the Fellowship, so that it is worth choosing. */
export const canAct = (actor: Actor): boolean => actor.status.rank !== null

/**
 * The actor among `options` that acts: the one that the visitor chose by its address, if it is
 * still there. Otherwise the selected account itself if it is a member, then the member of the
 * highest rank that it is a proxy for, and then itself though it is no member.
 *
 * Nobody acts until the selected account itself is among the options, which is once it has been
 * read. Before that it is not known whether it is a member, and a member acts as itself.
 */
export function pickActor<S extends Ranked>(
  options: Actor<S>[],
  chosen: string | undefined,
): Actor<S> | null {
  if (!options.some((o) => o.proxy === null)) return null
  return (
    options.find((o) => o.status.address === chosen && canAct(o)) ??
    options.find(canAct) ??
    options[0] ??
    null
  )
}
