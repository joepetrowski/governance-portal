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

const { checkPublicCalls, ENACT_AFTER, fellowshipCallsFor, parseTag } =
  await import("../src/gov/release")
const { blake2Hex } = await import("../src/gov/decode")
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
      expect(calls.whitelisted_call_hash).toBe(blake2Hex(dispatched(open)))
    },
  )

  // A library that answers every request with the calls for something else.
  const answering = (calls: (asked: lib.ReferendumInput) => lib.ReferendumCalls) =>
    ({ ...lib, referendum_calls: calls }) as typeof lib
  const upgrade = dispatched(fixtures.polkadotOpen1973)
  const parameters = dispatched(fixtures.polkadotOpen1972)

  it("refuses a Fellowship referendum that whitelists another call", async () => {
    const other = answering((asked) =>
      lib.referendum_calls({ ...asked, proposal: toHex(parameters) }),
    )
    await expect(fellowshipCallsFor(other, "polkadot", upgrade)).rejects.toThrow(
      "does not whitelist the proposal",
    )
    // The same, when the library also claims the hash that was asked for.
    const lying = answering((asked) => ({
      ...lib.referendum_calls({ ...asked, proposal: toHex(parameters) }),
      whitelisted_call_hash: blake2Hex(upgrade),
    }))
    await expect(fellowshipCallsFor(lying, "polkadot", upgrade)).rejects.toThrow(
      "does not decode as expected",
    )
  })

  it("refuses a Fellowship referendum that whitelists on the other network", async () => {
    const kusama = answering((asked) =>
      lib.referendum_calls({ ...asked, network: "kusama", fellowship_on_polkadot: true }),
    )
    await expect(fellowshipCallsFor(kusama, "polkadot", upgrade)).rejects.toThrow(
      "does not decode as expected",
    )
  })

  it("refuses a Fellowship referendum on a track that cannot whitelist", async () => {
    const root = answering((asked) => {
      const calls = lib.referendum_calls(asked)
      // The origin follows the two index bytes of `submit`: `FellowshipOrigins` is 0x3e, and the
      // byte after it names the origin within it.
      const encoded = calls.fellowship_referendum!.encoded
      expect(encoded.slice(6, 8)).toBe("3e")
      const tampered = `${encoded.slice(0, 8)}00${encoded.slice(10)}`
      return {
        ...calls,
        fellowship_referendum: { ...calls.fellowship_referendum!, encoded: tampered },
      }
    })
    await expect(fellowshipCallsFor(root, "polkadot", upgrade)).rejects.toThrow(
      "does not decode as expected",
    )
  })

  it("refuses a preimage that the Fellowship referendum does not use", async () => {
    const extra = answering((asked) => {
      const calls = lib.referendum_calls(asked)
      return { ...calls, fellowship_preimage: calls.public_preimage }
    })
    await expect(fellowshipCallsFor(extra, "polkadot", upgrade)).rejects.toThrow(
      "notes a preimage that it does not use",
    )
  })
})

describe("checkPublicCalls", () => {
  const call = (hex: string) => {
    const encoded = toHex(fromHex(hex).subarray(2))
    return { network: "asset-hub-polkadot", encoded, hash: blake2Hex(fromHex(encoded)) }
  }
  const proposal = call(fixtures.polkadotOpen1973)
  const callsFor = (changes: Partial<lib.ReferendumInput> = {}) =>
    lib.referendum_calls({
      proposal: proposal.encoded,
      network: "polkadot",
      track: "whitelistedcaller",
      dispatch: { after: ENACT_AFTER },
      ...changes,
    })

  it("accepts the public referendum that the library builds", async () => {
    await expect(checkPublicCalls(callsFor(), proposal, "polkadot")).resolves.toBeUndefined()
  })

  it("refuses a referendum for another proposal", async () => {
    const other = callsFor({ proposal: call(fixtures.polkadotOpen1972).encoded })
    await expect(checkPublicCalls(other, proposal, "polkadot")).rejects.toThrow("does not decode")
  })

  it("refuses another track or enactment delay", async () => {
    await expect(
      checkPublicCalls(callsFor({ track: "root" }), proposal, "polkadot"),
    ).rejects.toThrow("does not decode")
    const later = callsFor({ dispatch: { after: ENACT_AFTER + 1 } })
    await expect(checkPublicCalls(later, proposal, "polkadot")).rejects.toThrow("does not decode")
  })

  it("refuses a noted preimage that is not the one the referendum names", async () => {
    const good = callsFor()
    const swapped = { ...good, public_preimage: callsFor({ track: "root" }).public_preimage }
    await expect(checkPublicCalls(swapped, proposal, "polkadot")).rejects.toThrow("does not decode")
    // And a proposal whose stated hash is not the hash of its bytes.
    const mislabeled = { ...proposal, hash: `0x${"00".repeat(32)}` }
    await expect(checkPublicCalls(good, mislabeled, "polkadot")).rejects.toThrow("does not decode")
  })
})
