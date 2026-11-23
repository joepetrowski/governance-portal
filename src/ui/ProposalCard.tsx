import { NETWORKS } from "../chains"
import type { Proposal } from "../gov/load"
import { type ReleaseHashes, upgradeVersion } from "../gov/versions"
import type { AccountStatus } from "../gov/votes"
import { CallTree } from "./CallTree"
import { DepositButton } from "./DepositButton"
import { formatList } from "./format"
import { Short } from "./Short"
import { Prose } from "./Prose"
import { StageNote, StagePanel } from "./StagePanel"
import { VotePanel } from "./VotePanel"
import { WhitelistButton } from "./WhitelistButton"

interface Props {
  proposal: Proposal
  /** Whether some open Fellowship referendum could not be read, so that pairing is uncertain. */
  fellowshipUncertain: boolean
  /** Runtime hashes of recent releases, by which an upgrade's version is recognized. */
  releaseHashes: ReleaseHashes
  statuses: AccountStatus[]
  onVoted: () => void
}

function FellowshipStage({ proposal, fellowshipUncertain, statuses, onVoted }: Props) {
  if (proposal.fellowship)
    return (
      <StagePanel
        stage={proposal.fellowship}
        depositAction={
          <DepositButton stage={proposal.fellowship} statuses={statuses} onPlaced={onVoted} />
        }
      >
        <VotePanel stage={proposal.fellowship} statuses={statuses} onVoted={onVoted} />
      </StagePanel>
    )
  if (!proposal.whitelist) return null
  if (proposal.passedFellowship)
    return <StagePanel stage={proposal.passedFellowship} statusNote="The call is whitelisted" />
  // The referendum that whitelisted the call could not be found or read. Only that the call is
  // whitelisted is known, so the note claims no more than that.
  if (proposal.whitelist.whitelisted)
    return (
      <StageNote title="Fellowship" badge="Whitelisted">
        The call is on the whitelist. The Fellowship referendum that whitelisted it could not be
        found.
      </StageNote>
    )
  if (proposal.whitelist.whitelisted === null)
    return (
      <StageNote title="Fellowship">
        Whether the Fellowship has whitelisted this call could not be read.
      </StageNote>
    )
  // An open Fellowship referendum that could not be read may be the one for this call, so
  // neither claim that there is none nor offer to open another.
  if (fellowshipUncertain)
    return (
      <StageNote title="Fellowship">
        Not whitelisted. Whether a Fellowship referendum to whitelist it is open could not be
        determined, because an open Fellowship referendum could not be read in full.
      </StageNote>
    )
  return (
    <StageNote
      title="Fellowship"
      action={<WhitelistButton proposal={proposal} statuses={statuses} onSubmitted={onVoted} />}
    >
      Not whitelisted, and no Fellowship referendum to whitelist it is open. The public referendum
      cannot enact without it.
    </StageNote>
  )
}

function OpenStage({ proposal, statuses, onVoted }: Props) {
  if (proposal.open)
    return (
      <StagePanel
        stage={proposal.open}
        depositAction={
          <DepositButton stage={proposal.open} statuses={statuses} onPlaced={onVoted} />
        }
      >
        <VotePanel stage={proposal.open} statuses={statuses} onVoted={onVoted} />
      </StagePanel>
    )
  if (!proposal.whitelist) return null
  return (
    <StageNote title="Public referendum">
      No public referendum that dispatches this call is open.
    </StageNote>
  )
}

/**
 * One proposal: its title, the chains it upgrades, its Fellowship and public stages side by side,
 * and its decoded call.
 */
export function ProposalCard(props: Props) {
  const { proposal } = props
  // The badge names the network, so the chain labels on the card leave it out.
  const short = (chain: string) =>
    proposal.network === "kusama" ? chain.replace(/^Kusama /, "") : chain
  // An upgrade is named by its release when its runtimes are found in one, and otherwise keeps
  // the title that says only what is on chain.
  const release = upgradeVersion(proposal, props.releaseHashes)
  const count = new Set(proposal.upgrades.map((u) => u.chain)).size
  const subject = count === 1 ? short(proposal.upgrades[0]?.chain ?? "") : `${count} chains`
  const title = !release
    ? proposal.title
    : release.whole
      ? `System upgrade to version ${release.version}`
      : `Runtime upgrade of ${subject} to version ${release.version}`
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">
          <Prose>{title}</Prose>
        </h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            proposal.network === "kusama"
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "bg-pink-600 text-white"
          }`}
        >
          {NETWORKS[proposal.network].name}
        </span>
      </div>
      {proposal.upgrades.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {proposal.upgrades.map((u) => (
            <li
              key={`${u.chain}-${u.codeHash}`}
              className="rounded-full bg-pink-100 px-2.5 py-0.5 text-xs font-medium text-pink-900 dark:bg-pink-950 dark:text-pink-200"
            >
              {short(u.chain)}
              {u.unchecked && " (no version checks)"}
            </li>
          ))}
          {proposal.undecoded.map((chain) => (
            <li
              key={`undecoded-${chain}`}
              className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              {short(chain)} (not decoded)
            </li>
          ))}
        </ul>
      )}
      {proposal.otherEffects > 0 && (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
          This proposal does more than upgrade runtimes. See "What it does" for the{" "}
          {proposal.otherEffects === 1 ? "other call" : `${proposal.otherEffects} other calls`}.
        </p>
      )}
      {proposal.fellowshipExtra > 0 && (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
          The Fellowship referendum does more than whitelist this call. See "What the Fellowship
          referendum does" for the{" "}
          {proposal.fellowshipExtra === 1
            ? "other call"
            : `${proposal.fellowshipExtra} other calls`}
          .
        </p>
      )}
      {proposal.upgrades.some((u) => u.unchecked) && (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
          At least one runtime is authorized without version checks, so the chain would not verify
          that it is a newer version of the same runtime.
        </p>
      )}
      {proposal.undecoded.length > 0 && (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
          Unable to decode the {proposal.undecoded.length === 1 ? "call" : "calls"} on{" "}
          {formatList(proposal.undecoded.map(short))}, so what{" "}
          {proposal.undecoded.length === 1 ? "it does" : "they do"} there is unverified.
        </p>
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <FellowshipStage {...props} />
        <OpenStage {...props} />
      </div>

      {proposal.call && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
            What it does
          </summary>
          <div className="mt-2 overflow-x-auto">
            <CallTree call={proposal.call} />
          </div>
          {proposal.upgrades.map((u) => (
            <p
              key={`${u.chain}-${u.codeHash}`}
              className="mt-2 text-xs text-zinc-500 dark:text-zinc-400"
            >
              {u.chain} code hash <Short value={u.codeHash} />
            </p>
          ))}
          {proposal.whitelist && (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Whitelisted call hash <Short value={proposal.whitelist.hash} />
            </p>
          )}
        </details>
      )}
      {proposal.fellowshipExtra > 0 && proposal.fellowship?.call && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
            What the Fellowship referendum does
          </summary>
          <div className="mt-2 overflow-x-auto">
            <CallTree call={proposal.fellowship.call} />
          </div>
        </details>
      )}
    </article>
  )
}
