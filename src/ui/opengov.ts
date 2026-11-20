import init, * as lib from "opengov"
import wasmUrl from "opengov/opengov_bg.wasm?url"

let ready: Promise<typeof lib> | undefined

/**
 * The `opengov` library, which builds referendum calls. Its WebAssembly is fetched the first time
 * this is called, so that pages which build nothing do not pay for it.
 */
export const loadOpengov = () => (ready ??= init({ module_or_path: wasmUrl }).then(() => lib))
