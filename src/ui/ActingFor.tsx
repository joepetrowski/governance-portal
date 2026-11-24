import { useFellowship } from "../actor"
import { canAct } from "../gov/proxy"
import { useName } from "../names"
import { AccountName } from "./AccountName"
import { shortAddress } from "./format"

/** An option of the choice, which can hold only text: the name of the account, or its address. */
function Option({ address, rank, own }: { address: string; rank: number | null; own: boolean }) {
  const identity = useName("polkadot", address)
  return (
    <option value={address}>
      {own ? "This account" : `${identity?.name ?? shortAddress(address)}, by proxy`}
      {rank !== null && ` (rank ${rank})`}
    </option>
  )
}

/**
 * Says for whom the selected account acts in the Fellowship when that is a member that it is a
 * proxy for, and lets the visitor choose when there is more than one to act as. Renders nothing
 * for a wallet that is no proxy of a member.
 */
export function ActingFor() {
  const { actor, options, choose, delayed } = useFellowship()
  const able = options.filter(canAct)
  // Proxies of the wallet that cannot be used, said once for each member.
  const waiting = [...new Set(delayed.map((d) => d.real))]
  return (
    <>
      {actor?.proxy && able.length === 1 && (
        <p className="text-right text-xs text-zinc-600 dark:text-zinc-400">
          Acts in the Fellowship for{" "}
          <AccountName address={actor.status.address} network="polkadot" /> (rank{" "}
          {actor.status.rank}), by proxy
        </p>
      )}
      {actor && able.length > 1 && (
        <label className="text-xs text-zinc-600 dark:text-zinc-400">
          Acts in the Fellowship as{" "}
          <select
            className="max-w-56 rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
            value={actor.status.address}
            onChange={(e) => choose(e.target.value)}
          >
            {able.map((option) => (
              <Option
                key={option.status.address}
                address={option.status.address}
                rank={option.status.rank}
                own={option.proxy === null}
              />
            ))}
          </select>
        </label>
      )}
      {waiting.map((real) => (
        <p key={real} className="text-right text-xs text-zinc-500 dark:text-zinc-400">
          A proxy for <AccountName address={real} network="polkadot" /> has a delay, which the
          portal does not support
        </p>
      ))}
    </>
  )
}
