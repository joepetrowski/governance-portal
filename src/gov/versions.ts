// Which Fellowship release an upgrade installs. The release notes list the Blake2-256 hash of every
// runtime in the release, and that hash is what `System.authorize_upgrade` carries, so a match
// identifies the release with certainty. Nothing is inferred when a hash is not found.

import { chainsOf } from "../chains"
import type { Proposal } from "./load"

const RELEASES_URL = "https://api.github.com/repos/polkadot-fellows/runtimes/releases?per_page=10"
const STORAGE_KEY = "release-hashes"
/** How long a stored answer is reused. GitHub allows few requests per hour without an account. */
const MAX_AGE_MS = 10 * 60_000

/** Release tag, such as "v2.6.0", by the code hash of each runtime the release contains. */
export type ReleaseHashes = Record<string, string>

let cached: Promise<ReleaseHashes> | undefined

/**
 * The runtime hashes of the ten most recent releases, from their notes on GitHub. The answer is
 * kept for the page's lifetime and, for ten minutes, across reloads. Rejects if GitHub cannot be
 * read.
 */
export function loadReleaseHashes(): Promise<ReleaseHashes> {
  cached ??= readReleaseHashes().catch((e) => {
    cached = undefined
    throw e
  })
  return cached
}

async function readReleaseHashes(): Promise<ReleaseHashes> {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null")
    if (stored && Date.now() - stored.at < MAX_AGE_MS) return stored.hashes
  } catch {
    // No usable storage; read from GitHub.
  }
  const response = await fetch(RELEASES_URL)
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the releases.`)
  const releases = (await response.json()) as { tag_name: string; body: string | null }[]
  const hashes: ReleaseHashes = {}
  for (const release of releases) {
    if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) continue
    for (const [, hash] of (release.body ?? "").matchAll(/Blake2-256 hash:\s*(0x[0-9a-f]{64})/g))
      hashes[hash] = release.tag_name
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), hashes }))
  } catch {
    // Not stored; the next page load reads GitHub again.
  }
  return hashes
}

/**
 * The release a proposal upgrades to, as a version such as "2.6.0", with whether it covers every
 * chain of its network. Null unless every runtime it authorizes is in one and the same release and
 * every call in it was decoded.
 */
export function upgradeVersion(
  proposal: Proposal,
  hashes: ReleaseHashes,
): { version: string; whole: boolean } | null {
  if (proposal.upgrades.length === 0 || proposal.undecoded.length > 0) return null
  const tags = new Set(proposal.upgrades.map((u) => hashes[u.codeHash]))
  const [tag] = tags
  if (tags.size !== 1 || tag === undefined) return null
  const chains = new Set(proposal.upgrades.map((u) => u.chain))
  return { version: tag.slice(1), whole: chains.size === chainsOf(proposal.network).length }
}
