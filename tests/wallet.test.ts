// How the wallets found in the page are named and offered.

import { describe, expect, it } from "vitest"
import { walletChoices, walletLabel, walletToRejoin } from "../src/wallet"

describe("walletLabel", () => {
  it("calls the known wallets by their names", () => {
    expect(walletLabel("talisman", false)).toBe("Talisman")
    expect(walletLabel("polkadot-js", false)).toBe("Polkadot.js")
    expect(walletLabel("subwallet-js", false)).toBe("SubWallet")
  })

  it("calls what injects itself as Polkadot.js in the browser of Nova by Nova's name", () => {
    expect(walletLabel("polkadot-js", true)).toBe("Nova Wallet")
    expect(walletLabel("talisman", true)).toBe("Talisman")
  })

  it("shows a wallet that it does not know by the name it gave", () => {
    expect(walletLabel("enkrypt", false)).toBe("Enkrypt")
    expect(walletLabel("fearless-wallet", false)).toBe("Fearless-wallet")
    expect(walletLabel("example-js", false)).toBe("Example")
  })

  it("gives text for a name that an object would answer to by itself", () => {
    expect(walletLabel("constructor", false)).toBe("Constructor")
    expect(walletLabel("toString", false)).toBe("ToString")
    expect(walletLabel("__proto__", false)).toBe("__proto__")
  })

  it("drops characters that would reorder or hide what is around the name", () => {
    expect(walletLabel("evil\u202Enamsilat\u0000", false)).toBe("Evilnamsilat")
  })
})

describe("walletChoices", () => {
  it("puts Talisman first and keeps the rest in order", () => {
    expect(walletChoices(["polkadot-js", "subwallet-js", "talisman"], false)).toEqual([
      "talisman",
      "polkadot-js",
      "subwallet-js",
    ])
  })

  it("offers Nova once, though it injects itself under two names", () => {
    expect(walletChoices(["polkadot-js", "nova-wallet"], true)).toEqual(["polkadot-js"])
    // Outside Nova, the two names are two wallets.
    expect(walletChoices(["polkadot-js", "nova-wallet"], false)).toEqual([
      "polkadot-js",
      "nova-wallet",
    ])
    expect(walletChoices(["nova-wallet"], true)).toEqual(["nova-wallet"])
    expect(walletChoices(["polkadot-js", "nova-wallet", "talisman"], true)).toEqual([
      "talisman",
      "polkadot-js",
    ])
  })
})

describe("walletToRejoin", () => {
  it("is the wallet of the last visit, if it is offered", () => {
    expect(walletToRejoin("talisman", ["talisman", "polkadot-js"], false)).toBe("talisman")
    expect(walletToRejoin("talisman", ["polkadot-js"], false)).toBeNull()
    expect(walletToRejoin(undefined, ["talisman"], false)).toBeNull()
  })

  it("finds Nova again when the last visit knew it by its other name", () => {
    const offered = walletChoices(["polkadot-js", "nova-wallet"], true)
    expect(walletToRejoin("nova-wallet", offered, true)).toBe("polkadot-js")
    expect(walletToRejoin("polkadot-js", offered, true)).toBe("polkadot-js")
    // Outside Nova, a wallet of that name is its own wallet.
    expect(walletToRejoin("nova-wallet", ["polkadot-js", "nova-wallet"], false)).toBe("nova-wallet")
    expect(walletToRejoin("nova-wallet", ["polkadot-js"], false)).toBeNull()
  })
})
