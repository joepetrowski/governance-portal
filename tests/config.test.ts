import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CHAIN_IDS, CHAINS, chainByParaId, chainsOf, NETWORK_IDS, NETWORKS } from "../src/chains"

describe("chain registry", () => {
  it("lists each network's Relay Chain first and its parachains by ID", () => {
    for (const network of NETWORK_IDS) {
      const ids = chainsOf(network).map((chain) => CHAINS[chain].paraId)
      expect(ids[0]).toBeNull()
      const paras = ids.slice(1) as number[]
      expect(paras).toEqual([...paras].sort((a, b) => a - b))
    }
  })

  it("finds chains by parachain ID within a network", () => {
    expect(chainByParaId("polkadot", 1001)).toBe("collectives")
    expect(chainByParaId("kusama", 1001)).toBe("kusamaEncointer")
    expect(chainByParaId("polkadot", 9999)).toBeUndefined()
    for (const network of NETWORK_IDS)
      expect(chainByParaId(network, 1000)).toBe(NETWORKS[network].assetHub)
  })

  it("has an endpoint for every chain", () => {
    for (const chain of CHAIN_IDS) expect(CHAINS[chain].rpcs.length).toBeGreaterThan(0)
  })
})

describe("content security policy", () => {
  it("allows every RPC endpoint in the registry", () => {
    const toml = readFileSync("netlify.toml", "utf8")
    const allowed = [...toml.matchAll(/wss:\/\/([^\s;"\\]+)/g)].map(([, host]) => host)
    expect(allowed.length).toBeGreaterThan(0)
    const permits = (host: string) =>
      allowed.some((pattern) =>
        pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern,
      )
    for (const chain of CHAIN_IDS)
      for (const rpc of CHAINS[chain].rpcs) {
        const { protocol, hostname } = new URL(rpc)
        expect(protocol, rpc).toBe("wss:")
        expect(permits(hostname), `${rpc} is not allowed by netlify.toml`).toBe(true)
      }
  })
})
