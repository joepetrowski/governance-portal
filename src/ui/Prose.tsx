/**
 * Text in which code is marked with backticks, as in "`System.remark` on Asset Hub". The marked
 * parts are shown preformatted.
 */
export function Prose({ children }: { children: string }) {
  return children.split("`").map((part, i) =>
    i % 2 === 0 ? (
      part
    ) : (
      <code
        key={i}
        className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.9em] font-medium dark:bg-zinc-800"
      >
        {part}
      </code>
    ),
  )
}
