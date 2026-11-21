import { useState } from "react"
import { CHAINS, NETWORKS, RELAY_BLOCK_MS } from "../chains"
import { applyUpgrade, type ChainUpgrade } from "../gov/apply"
import type { ReleaseHashes } from "../gov/versions"
import { formatDateTime, shortHex } from "./format"
import { Short } from "./Short"
import { choice, useSubmit } from "./tx"
import { TxStatus } from "./TxStatus"
import { errorMessage } from "../util"

/** One chain's upgrade, with the button that applies it when it is waiting for that. */
function UpgradeRow(props: {
  upgrade: ChainUpgrade
  /** Runtime hashes of recent releases, or null while they are not known. */
  releaseHashes: ReleaseHashes | null
  loadedAt: number
  onApplied: () => void
}) {
  const { upgrade } = props
  const { state, busy, follow } = useSubmit(props.onApplied)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { name, network } = CHAINS[upgrade.chain]
  const tag = props.releaseHashes?.[upgrade.codeHash]
  const what = tag ? `version ${tag.slice(1)}` : `runtime ${shortHex(upgrade.codeHash)}`

  const apply = async () => {
    setPreparing(true)
    setError(null)
    try {
      follow(await applyUpgrade(upgrade, props.releaseHashes ?? {}))
    } catch (e) {
      setError(errorMessage(e))
    }
    setPreparing(false)
  }

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm">
          <p className="font-medium">
            {name}{" "}
            <span className="font-normal text-zinc-500 dark:text-zinc-400">
              on {NETWORKS[network].name}
            </span>
          </p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {upgrade.state === "authorized"
              ? `The upgrade to ${what} is approved and waits for someone to apply it.`
              : `The upgrade to ${what} is applied, and the Relay Chain will enact it` +
                (upgrade.enactsAt === null
                  ? "."
                  : ` around ${formatDateTime(
                      props.loadedAt + (upgrade.enactsAt - upgrade.now) * RELAY_BLOCK_MS,
                    )}.`)}
            {upgrade.state === "authorized" &&
              !tag &&
              (props.releaseHashes
                ? " This runtime is not in a recent release, so it cannot be applied from here."
                : " The releases could not be read, so it cannot be applied from here for now.")}
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Code hash <Short value={upgrade.codeHash} />
          </p>
        </div>
        {upgrade.state === "authorized" && tag && (
          <div className="flex flex-col items-end">
            <button
              type="button"
              disabled={busy || preparing}
              className={choice(true)}
              onClick={() => void apply()}
            >
              Apply upgrade
            </button>
            {preparing && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Downloading and checking the runtime…
              </p>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
                {error}
              </p>
            )}
            <TxStatus state={state} />
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * Approved upgrades that are not yet in effect. Shown above the proposals, and only when there is
 * one, because an approved upgrade does nothing until someone applies it.
 */
export function UpgradePanel(props: {
  upgrades: ChainUpgrade[]
  /** Runtime hashes of recent releases, or null while they are not known. */
  releaseHashes: ReleaseHashes | null
  /** Wall-clock time at which the upgrades were read, in milliseconds. */
  loadedAt: number
  onApplied: () => void
}) {
  if (props.upgrades.length === 0) return null
  return (
    <section className="mb-6 rounded-xl border border-sky-300 bg-sky-50 p-5 dark:border-sky-900 dark:bg-sky-950/30">
      <h2 className="text-lg font-semibold">Approved upgrades</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        A referendum authorizes a new runtime by its hash. The runtime itself must then be given to
        each chain, which anyone can do. It needs no wallet and costs nothing, and the chain accepts
        only the runtime that was authorized.
      </p>
      <ul className="mt-3 space-y-3">
        {props.upgrades.map((upgrade) => (
          <UpgradeRow
            key={`${upgrade.chain}-${upgrade.state}`}
            upgrade={upgrade}
            releaseHashes={props.releaseHashes}
            loadedAt={props.loadedAt}
            onApplied={props.onApplied}
          />
        ))}
      </ul>
    </section>
  )
}
