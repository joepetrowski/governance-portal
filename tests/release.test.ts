import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as lib from "opengov"
import { fromHex, toHex } from "polkadot-api/utils"
import { beforeAll, describe, expect, it, vi } from "vitest"
import fixtures from "./fixtures.json"

vi.mock("../src/chains", async (original) => ({
  ...(await original<typeof import("../src/chains")>()),
  ...(await import("./offline")),
}))

const { fellowshipCallsFor, parseTag } = await import("../src/gov/release")
const { runtimeFileName } = await import("../src/gov/apply")

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  await lib.default({ module_or_path: readFileSync(require.resolve("opengov/opengov_bg.wasm")) })
})

describe("parseTag", () => {
  it("accepts a tag, a bare version, or a release URL", () => {
    expect(parseTag("v2.6.0")).toBe("v2.6.0")
    expect(parseTag("2.6.0")).toBe("v2.6.0")
    expect(parseTag("https://github.com/polkadot-fellows/runtimes/releases/tag/v2.6.0")).toBe(
      "v2.6.0",
    )
    expect(parseTag(" v2.6.0/ ")).toBe("v2.6.0")
  })

  it("refuses anything else", () => {
    for (const input of ["", "latest", "v2.6", "v2.6.0-rc1", "x2.6.0", "v2.6.0?x=1"])
      expect(parseTag(input)).toBeNull()
  })
})

describe("runtimeFileName", () => {
  it("agrees with the opengov library for every chain", async () => {
    const { CHAIN_IDS, CHAINS } = await import("../src/chains")
    for (const chain of CHAIN_IDS)
      expect(runtimeFileName(chain, "v2.6.0")).toBe(
        lib.runtime_file_name(CHAINS[chain].runtime, "v2.6.0"),
      )
    expect(runtimeFileName("bulletin", "v2.6.0")).toBe(
      "bulletin-polkadot_runtime-v2006000.compact.compressed.wasm",
    )
  })
})

describe("fellowshipCallsFor", () => {
  // The call a public referendum dispatches is its preimage without the two index bytes of
  // `dispatch_whitelisted_call_with_preimage`.
  const dispatched = (hex: string) => fromHex(hex).subarray(2)
  const cases = [
    ["Polkadot upgrade", "polkadot", fixtures.polkadotOpen1973, fixtures.fellowship681],
    ["Polkadot parameters", "polkadot", fixtures.polkadotOpen1972, fixtures.fellowship680],
    ["Kusama upgrade, over the bridge", "kusama", fixtures.kusamaOpen679, fixtures.fellowship679],
  ] as const

  it.each(cases)(
    "rebuilds the Fellowship referendum on chain: %s",
    async (_, network, open, fel) => {
      const { calls } = await fellowshipCallsFor(lib, network, dispatched(open))
      expect(calls.fellowship_preimage).toBeFalsy()
      // The submission carries the proposal inline, exactly as the referendum on chain has it.
      expect(calls.fellowship_referendum?.encoded).toContain(fel.slice(2))
      expect(calls.whitelisted_call_hash).toBeTruthy()
      expect(toHex(dispatched(open))).toBe(`0x${open.slice(6)}`)
    },
  )
})
