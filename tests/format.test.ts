import { describe, expect, it } from "vitest"
import {
  duration,
  formatBalance,
  formatExact,
  formatList,
  parseBalance,
  percent,
  shortHex,
} from "../src/ui/format"

describe("parseBalance", () => {
  it("reads whole and decimal amounts in the network's decimals", () => {
    expect(parseBalance("1.5", "polkadot")).toBe(15_000_000_000n)
    expect(parseBalance("1000", "polkadot")).toBe(10_000_000_000_000n)
    expect(parseBalance("1.5", "kusama")).toBe(1_500_000_000_000n)
    expect(parseBalance(" 2. ", "polkadot")).toBe(20_000_000_000n)
  })

  it("refuses commas, whose meaning it would have to guess", () => {
    expect(parseBalance("1,5", "polkadot")).toBeNull()
    expect(parseBalance("1,000", "polkadot")).toBeNull()
  })

  it("refuses more decimal places than the token has", () => {
    expect(parseBalance("0.0000000001", "polkadot")).toBe(1n)
    expect(parseBalance("0.00000000001", "polkadot")).toBeNull()
    expect(parseBalance("0.000000000001", "kusama")).toBe(1n)
  })

  it("refuses anything that is not a number", () => {
    for (const input of ["", "abc", "-1", "1e3", ".5", "1.2.3"])
      expect(parseBalance(input, "polkadot")).toBeNull()
  })
})

describe("formatExact", () => {
  it("shows the full amount without rounding", () => {
    expect(formatExact(15_000_000_000n, "polkadot")).toBe("1.5 DOT")
    expect(formatExact(12_345_678_912_345n, "polkadot")).toBe("1,234.5678912345 DOT")
    expect(formatExact(33_333_333_333n, "kusama")).toBe("0.033333333333 KSM")
    expect(formatExact(0n, "polkadot")).toBe("0 DOT")
  })

  it("round-trips with parseBalance", () => {
    for (const planck of [1n, 15_000_000_000n, 987_654_321_012n]) {
      const shown = formatExact(planck, "polkadot").replace(" DOT", "").replaceAll(",", "")
      expect(parseBalance(shown, "polkadot")).toBe(planck)
    }
  })
})

describe("formatBalance", () => {
  it("is compact for large amounts", () => {
    expect(formatBalance(264_000_000_000_000n, "polkadot")).toBe("26.4K DOT")
    expect(formatBalance(4_600_000n * 10n ** 10n, "polkadot")).toBe("4.6M DOT")
  })

  it("does not show a small amount as zero", () => {
    expect(formatBalance(33_333_333_333n, "kusama")).toBe("0.033 KSM")
    expect(formatBalance(0n, "kusama")).toBe("0 KSM")
  })
})

describe("other formatting", () => {
  it("gives small percentages more digits", () => {
    expect(percent(0.923)).toBe("92.3%")
    expect(percent(0.0085)).toBe("0.85%")
    expect(percent(0.000085)).toBe("0.0085%")
    expect(percent(0)).toBe("0.0%")
  })

  it("turns blocks into a duration", () => {
    expect(duration(14_400, 6_000)).toBe("1d")
    expect(duration(15_000, 6_000)).toBe("1d 1h")
    expect(duration(610, 6_000)).toBe("1h 1m")
    expect(duration(4, 6_000)).toBe("under a minute")
    expect(duration(-10, 6_000)).toBe("under a minute")
  })

  it("lists with the serial comma", () => {
    expect(formatList(["A", "B", "C"])).toBe("A, B, and C")
    expect(formatList(["A", "B"])).toBe("A and B")
  })

  it("shortens long hex only", () => {
    expect(shortHex("0x1234")).toBe("0x1234")
    expect(shortHex("0x" + "ab".repeat(32))).toBe("0xabababab…abababab")
  })
})
