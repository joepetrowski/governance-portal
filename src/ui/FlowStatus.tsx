import { dismissFlow, type Flow, useOrphanFlows } from "./flows"
import { TxStatus } from "./TxStatus"

/** Where a flow is: the submission, what the second transaction does, and how that one fares. */
export function FlowStatus({ flow }: { flow: Flow }) {
  const many = flow.opened.length > 1
  return (
    <div>
      {flow.building && (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Building the transaction…</p>
      )}
      <TxStatus state={flow.first} />
      {flow.next && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Second transaction: {flow.next}
        </p>
      )}
      <TxStatus state={flow.second} />
      {flow.error && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {flow.error}
        </p>
      )}
      {flow.second.step === "failed" && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          The {many ? "referenda are" : "referendum is"} open. The deposit and the vote can also be
          made from {many ? "their cards" : "its card"} in the list.
        </p>
      )}
    </div>
  )
}

/**
 * The submissions whose control is no longer on the page, so that a transaction that is under way
 * or waits for a signature is always described somewhere. Renders nothing when there are none.
 */
export function FlowPanel() {
  const flows = useOrphanFlows()
  if (flows.length === 0) return null
  return (
    <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold">Your submissions</h2>
      <ul className="mt-2 space-y-3">
        {flows.map((flow) => (
          <li key={flow.key}>
            <p className="text-sm font-medium">{flow.title}</p>
            <FlowStatus flow={flow} />
            {flow.over && (
              <button
                type="button"
                className="mt-2 text-xs font-medium underline"
                onClick={() => dismissFlow(flow.key)}
              >
                Dismiss
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
