// Closing the connections while the page is in the background.

import { afterEach, describe, expect, it } from "vitest"
import { closeClients, getClient, holdClients, resumeClients } from "../src/chains"

afterEach(resumeClients)

describe("closeClients", () => {
  it("refuses new connections until they are resumed", () => {
    expect(closeClients()).toBe(true)
    // A read that is still under way would otherwise connect again.
    expect(() => getClient("relay")).toThrow("Disconnected")
  })

  it("leaves the connections alone while something holds them", () => {
    const release = holdClients()
    expect(closeClients()).toBe(false)
    release()
    // Releasing twice does not release someone else's hold.
    const other = holdClients()
    release()
    expect(closeClients()).toBe(false)
    other()
    expect(closeClients()).toBe(true)
  })
})
