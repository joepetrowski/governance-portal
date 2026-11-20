import type { Proposal } from "../gov/load"
import type { AccountStatus } from "../gov/votes"
import { CallTree } from "./CallTree"
import { DepositButton } from "./DepositButton"
import { formatList, shortHex } from "./format"
import { StageNote, StagePanel } from "./StagePanel"
import { VotePanel } from "./VotePanel"

interface Props {
  proposal: Proposal
  statuses: AccountStatus[]
  onVoted: () => void
}

function FellowshipStage({ proposal, statuses, onVoted }: Props) {
  if (proposal.fellowship)
    return (
      <StagePanel
        stage={proposal.fellowship}
        depositAction={<DepositButton stage={proposal.fellowship} statuses={statuses} onPlaced={onVoted} />}
      >
        <VotePanel stage={proposal.fellowship} statuses={statuses} onVoted={onVoted} />
      </StagePanel>
    )
  if (!proposal.whitelist) return null
  return proposal.whitelist.whitelisted ? (
    <StageNote title="Fellowship">The Fellowship has whitelisted this call.</StageNote>
  ) : (
    <StageNote title="Fellowship">
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
        depositAction={<DepositButton stage={proposal.open} statuses={statuses} onPlaced={onVoted} />}
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

export function ProposalCard(props: Props) {
  const { proposal } = props
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold">{proposal.title}</h2>
      {proposal.upgrades.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {proposal.upgrades.map((u) => (
            <li
              key={u.chain}
              title={`Code hash ${u.codeHash}`}
              className="rounded-full bg-pink-100 px-2.5 py-0.5 text-xs font-medium text-pink-900 dark:bg-pink-950 dark:text-pink-200"
            >
              {u.chain}
            </li>
          ))}
          {proposal.undecoded.map((chain) => (
            <li
              key={`undecoded-${chain}`}
              className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              {chain} (not decoded)
            </li>
          ))}
        </ul>
      )}
      {proposal.undecoded.length > 0 && (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
          Unable to decode the {proposal.undecoded.length === 1 ? "call" : "calls"} on{" "}
          {formatList(proposal.undecoded)}, so what {proposal.undecoded.length === 1 ? "it does" : "they do"}{" "}
          there is unverified.
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
          {proposal.whitelist && (
            <p className="mt-2 text-xs text-zinc-500">
              Whitelisted call hash{" "}
              <span className="font-mono" title={proposal.whitelist.hash}>
                {shortHex(proposal.whitelist.hash)}
              </span>
            </p>
          )}
        </details>
      )}
    </article>
  )
}
