// Small helpers shared by the chain reads and the interface.

/** The message of a thrown value, whatever was thrown. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The promise, or a rejection with `message` if it has not settled after `ms` milliseconds. */
export function orReject<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * The promise, or `undefined` if it fails or has not settled after `ms` milliseconds. For reads
 * that the page can do without.
 */
export const orNothing = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  orReject(promise, ms, "Timed out").catch(() => undefined)
