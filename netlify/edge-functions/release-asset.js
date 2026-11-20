// Stateless proxy for runtime blobs attached to Fellowship releases. GitHub serves release assets
// without CORS headers, so a browser cannot read them directly. This fetches one asset and streams
// it back; it stores nothing. The browser checks the bytes it receives against the SHA-256 digest
// that the GitHub API reports for the asset, so the proxy is not trusted for integrity.
//
// Only runtime blobs of polkadot-fellows/runtimes releases can be requested.

const TAG = /^v\d+\.\d+\.\d+$/
const FILE = /^[a-z0-9-]+_runtime-v\d+\.compact\.compressed\.wasm$/

export default async (_request, context) => {
  const { tag, file } = context.params
  if (!TAG.test(tag) || !FILE.test(file))
    return new Response("Not a runtime release asset", { status: 400 })

  const upstream = await fetch(
    `https://github.com/polkadot-fellows/runtimes/releases/download/${tag}/${file}`,
  )
  // Always 502, also for a missing asset: On a 404, Netlify would retry the path as a page.
  if (!upstream.ok) return new Response(`GitHub answered ${upstream.status}`, { status: 502 })

  return new Response(upstream.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  })
}

/** Route of this edge function, as Netlify reads it. */
export const config = { path: "/release-asset/:tag/:file" }
