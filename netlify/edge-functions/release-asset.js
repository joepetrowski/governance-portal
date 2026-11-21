// Stateless proxy for runtime blobs attached to Fellowship releases. GitHub serves release assets
// without CORS headers, so a browser cannot read them directly. This fetches one asset and streams
// it back; it stores nothing. The browser checks the bytes it receives against the SHA-256 digest
// that the GitHub API reports for the asset, so the proxy is not trusted for integrity.
//
// Only runtime blobs of polkadot-fellows/runtimes releases can be requested.

const TAG = /^v\d+\.\d+\.\d+$/
const FILE = /^[a-z0-9-]+_runtime-v\d+\.compact\.compressed\.wasm$/

const UPSTREAM_TIMEOUT_MS = 30_000

export default async (request, context) => {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } })
  const { tag, file } = context.params
  if (!TAG.test(tag) || !FILE.test(file))
    return new Response("Not a runtime release asset", { status: 400 })

  let upstream
  try {
    upstream = await fetch(
      `https://github.com/polkadot-fellows/runtimes/releases/download/${tag}/${file}`,
      { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    )
  } catch {
    return new Response("GitHub did not answer", { status: 502 })
  }
  // Always 502, also for a missing asset: On a 404, Netlify would retry the path as a page.
  if (!upstream.ok) return new Response(`GitHub answered ${upstream.status}`, { status: 502 })

  const headers = {
    "content-type": "application/octet-stream",
    // A release asset rarely changes, and the browser checks what it receives, so the CDN may
    // keep it for a day. That also keeps repeated requests from reaching GitHub. If a maintainer
    // replaces an asset, the old bytes fail the browser's check until the copy expires.
    "cache-control": "public, max-age=3600, s-maxage=86400",
    "x-content-type-options": "nosniff",
  }
  const length = upstream.headers.get("content-length")
  if (length) headers["content-length"] = length
  return new Response(upstream.body, { headers })
}

/**
 * Route of this edge function, as Netlify reads it. `cache: "manual"` lets the CDN cache the
 * responses by their `cache-control` header, which it does not do for edge functions otherwise.
 */
export const config = { path: "/release-asset/:tag/:file", cache: "manual" }
