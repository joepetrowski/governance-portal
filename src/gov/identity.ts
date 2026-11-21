// Names that accounts have given themselves with the Identity pallet on a network's People chain.
//
// These are storage reads. No runtime API or view function of the People chains offers
// identities.

import { fromHex } from "polkadot-api/utils"
import { type Network, peopleApi } from "../chains"

/** Longest name shown. A field of an identity holds at most 32 bytes. */
const MAX_LENGTH = 32

/** A field of an identity as the chain stores it: nothing, raw bytes, or a hash. */
export interface IdentityData {
  /** "None", "Raw0" to "Raw32", or the name of a hash such as "BlakeTwo256". */
  type: string
  /** The bytes: a number for a single byte, and hex or bytes otherwise. */
  value?: unknown
}

/**
 * What registrars make of an identity: "confirmed" if one stands behind it, "negative" if one
 * rejected it, and "none" otherwise.
 */
export type Standing = "confirmed" | "none" | "negative"

/** How an account is shown: its identity name, and what registrars make of it. */
export interface AccountIdentity {
  /** The display name, or "{name}/{sub-name}" for a sub-identity. */
  name: string
  /** The standing of the identity with registrars. See `standing`. */
  standing: Standing
}

/**
 * Characters that look like the mark of a confirmed identity. They are dropped from names so that
 * a name cannot award itself the mark.
 */
const MARKS = /[\u2713\u2714\u2611\u2705\u{1F5F8}]\uFE0F?/gu

/**
 * The standing of an identity, from the judgements of registrars. It is "negative" if any judged
 * it "Low quality" or "Erroneous", "confirmed" if none did and at least one judged it "Reasonable"
 * or "Known good", and "none" otherwise, which includes "Fee paid" and "Out of date". Each
 * judgement is a registrar's index and its verdict. For a sub-identity, pass the judgements of the
 * account it belongs to, which is the account that named it.
 */
export function standing(judgements: [number, { type: string }][] | undefined): Standing {
  const verdicts = (judgements ?? []).map(([, verdict]) => verdict.type)
  if (verdicts.some((v) => v === "LowQuality" || v === "Erroneous")) return "negative"
  if (verdicts.some((v) => v === "Reasonable" || v === "KnownGood")) return "confirmed"
  return "none"
}

/**
 * The text of an identity field, or null if it has none. Only raw fields are text. Control and
 * formatting characters are dropped, so that a name cannot reorder or hide what is around it, and
 * so are check marks.
 */
export function dataText(data: IdentityData | undefined): string | null {
  if (!data || !/^Raw\d+$/.test(data.type)) return null
  const { value } = data
  const bytes =
    typeof value === "number"
      ? Uint8Array.of(value)
      : typeof value === "string"
        ? fromHex(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array()
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  const clean = text
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(MARKS, "")
    .replace(/ +/g, " ")
    .trim()
  return clean === "" ? null : [...clean].slice(0, MAX_LENGTH).join("")
}

/**
 * How an account is named: by its own display name, or as "{name}/{sub-name}" if it is a
 * sub-identity of another account. Null if the account, or the account it belongs to, has no
 * display name.
 */
export function identityName(
  own: IdentityData | undefined,
  parent?: { display: IdentityData | undefined; subName: IdentityData },
): string | null {
  if (!parent) return dataText(own)
  const name = dataText(parent.display)
  const subName = dataText(parent.subName)
  return name && subName ? `${name}/${subName}` : null
}

/**
 * The identities of the given accounts on a network, by address. Accounts without an identity are
 * left out. Names are what their owners chose, so each comes with its standing with
 * registrars.
 */
export async function loadNames(
  network: Network,
  addresses: string[],
): Promise<Record<string, AccountIdentity>> {
  if (addresses.length === 0) return {}
  const identity = peopleApi(network).query.Identity
  const supers = await identity.SuperOf.getValues(addresses.map((a) => [a] as [string]))
  // The display name of a sub-identity is that of the account it belongs to.
  const holders = addresses.map((address, i) => supers[i]?.[0] ?? address)
  const unique = [...new Set(holders)]
  const registrations = await identity.IdentityOf.getValues(unique.map((a) => [a] as [string]))
  const registered = new Map(unique.map((a, i) => [a, registrations[i]]))

  const names: Record<string, AccountIdentity> = {}
  addresses.forEach((address, i) => {
    const sub = supers[i]
    const registration = registered.get(sub ? sub[0] : address)
    const display = registration?.info.display
    const name = sub ? identityName(undefined, { display, subName: sub[1] }) : identityName(display)
    if (name) names[address] = { name, standing: standing(registration?.judgements) }
  })
  return names
}
