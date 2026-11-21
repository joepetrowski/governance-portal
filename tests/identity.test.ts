// How identity fields become the names shown for accounts.

import { toHex } from "polkadot-api/utils"
import { describe, expect, it } from "vitest"
import { dataText, identityName, standing } from "../src/gov/identity"

const raw = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  // The chain decodes a single raw byte as a number, and longer fields as hex.
  return { type: `Raw${bytes.length}`, value: bytes.length === 1 ? bytes[0] : toHex(bytes) }
}

describe("dataText", () => {
  it("reads raw fields of any length", () => {
    expect(dataText(raw("dotID"))).toBe("dotID")
    expect(dataText(raw("1"))).toBe("1")
    expect(dataText({ type: "Raw4", value: new TextEncoder().encode("Joe ") })).toBe("Joe")
    expect(dataText(raw("Zoë ♥"))).toBe("Zoë ♥")
  })

  it("has no text for empty fields, hashes, and bytes that are not text", () => {
    expect(dataText(undefined)).toBeNull()
    expect(dataText({ type: "None" })).toBeNull()
    expect(dataText({ type: "Raw0" })).toBeNull()
    expect(dataText(raw("   "))).toBeNull()
    expect(dataText({ type: "BlakeTwo256", value: `0x${"ab".repeat(32)}` })).toBeNull()
    expect(dataText({ type: "Raw2", value: "0xc328" })).toBeNull()
  })

  it("drops characters that could hide or reorder the text around a name", () => {
    // A right-to-left override, a zero-width space, and a line break.
    expect(dataText(raw("Par‮ity​\nLtd"))).toBe("Parity Ltd")
    expect(dataText(raw("\u0000\u0007"))).toBeNull()
  })

  it("drops check marks, which would imitate the mark of a confirmed identity", () => {
    expect(dataText(raw("Alice ✓"))).toBe("Alice")
    expect(dataText(raw("✅ Alice ✔️"))).toBe("Alice")
  })
})

describe("identityName", () => {
  it("is the display name of an account with an identity", () => {
    expect(identityName(raw("Alice"))).toBe("Alice")
    expect(identityName(undefined)).toBeNull()
    expect(identityName({ type: "None" })).toBeNull()
  })

  it("joins the name of the parent and the sub-name for a sub-identity", () => {
    const parent = { display: raw("Polkadot"), subName: raw("TECH-FELLOWSHIP") }
    expect(identityName(undefined, parent)).toBe("Polkadot/TECH-FELLOWSHIP")
  })

  it("is nothing for a sub-identity without both parts", () => {
    expect(identityName(undefined, { display: undefined, subName: raw("ops") })).toBeNull()
    expect(identityName(undefined, { display: raw("Alice"), subName: { type: "None" } })).toBeNull()
    // The account's own name does not stand in: It is named as part of its parent or not at all.
    expect(identityName(raw("Own"), { display: undefined, subName: raw("ops") })).toBeNull()
  })
})

describe("standing", () => {
  it("is confirmed if a registrar judged the identity reasonable or known good", () => {
    expect(standing([[0, { type: "Reasonable" }]])).toBe("confirmed")
    expect(standing([[1, { type: "KnownGood" }]])).toBe("confirmed")
  })

  it("is none without a judgement that says the identity is right or wrong", () => {
    expect(standing(undefined)).toBe("none")
    expect(standing([])).toBe("none")
    expect(standing([[0, { type: "FeePaid" }]])).toBe("none")
    expect(standing([[0, { type: "Unknown" }]])).toBe("none")
    expect(standing([[0, { type: "OutOfDate" }]])).toBe("none")
  })

  it("is negative if any registrar judged the identity low quality or erroneous", () => {
    expect(standing([[0, { type: "LowQuality" }]])).toBe("negative")
    expect(
      standing([
        [0, { type: "Reasonable" }],
        [1, { type: "Erroneous" }],
      ]),
    ).toBe("negative")
  })
})
