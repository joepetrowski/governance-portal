# Brief: make opengov-cli usable as a library and from the browser

## Why

A static web app (the Polkadot governance portal) needs to build exactly the calls that
`opengov-cli build-upgrade` and `opengov-cli submit-referendum` build today, in the browser, and
have a wallet sign them. Re-implementing that logic in TypeScript would create a second
implementation of security-critical code that could drift. Instead, opengov-cli should expose its
call construction as a pure library that also compiles to WebAssembly. The CLI becomes a thin
shell over that library.

Written against commit `4266ec0`.

## What blocks this today

- The crate is binary-only (`src/main.rs`); everything is `pub(crate)` / `pub(super)`.
- Call construction is mixed with I/O:
  - `build_upgrade.rs` downloads runtimes with `reqwest`, writes them to disk, then reads them
    back to hash them (`download_runtimes`, `generate_authorize_upgrade_calls`, `write_batch`,
    `make_version_directory`).
  - `submit_referendum.rs` writes `*_preimage_to_note.call` files inside the `*_referenda`
    functions and reads the proposal from a path via `get_proposal_bytes`.
  - Results are delivered by `println!`.
- Invalid input panics (`panic!`, `assert!`, `expect`) rather than returning an error. A panic in
  Wasm aborts the module.
- `PossibleCallsToSubmit` bakes a CLI display concern into the result: when a preimage is longer
  than `output_len_limit`, the call is replaced by its hash (`CallOrHash::Hash`). A caller that
  wants to submit the preimage needs the call itself.
- Several functions are `async` without awaiting anything (`construct_batch`,
  `*_fellowship_referenda`, `generate_calls`), which forces an executor on callers.
- Dependencies assume a native target: `tokio` (multi-thread runtime), `reqwest`, `clap`, `subxt`
  with default features, and `sp-core` / `sp-crypto-hashing` from polkadot-sdk `master`.

## Target shape

One crate with a library and a binary:

- `src/lib.rs`: the public API below. No filesystem, network, stdout, clap, or tokio. Must build
  for `wasm32-unknown-unknown`.
- `src/main.rs` plus the CLI modules: argument parsing, downloading, files, printing. Behind a
  default `cli` feature that owns `clap`, `tokio`, `reqwest`.
- A `wasm` feature that adds `wasm-bindgen` exports (below).

`add-invulnerables` is out of scope; leave it CLI-only unless it falls out naturally.

### Library API

Names are suggestions; the properties matter more than the spelling.

```rust
/// Stable string ids, the runtime names used in Fellowship releases:
/// "polkadot", "asset-hub-polkadot", "collectives-polkadot", ... (today's `runtime_name`).
impl Network {
    pub fn runtime_name(&self) -> &'static str;
    pub fn from_runtime_name(s: &str) -> Result<Self, Error>;
}

/// A call together with the chain it must be submitted to or executed on.
pub struct NetworkCall {
    pub network: Network,
    pub encoded: Vec<u8>,   // SCALE-encoded RuntimeCall
    pub hash: [u8; 32],     // blake2_256(encoded)
}

// --- build-upgrade ---

/// File name of a chain's runtime in a release (today's `runtime_file_name`).
pub fn runtime_file_name(network: &Network, version: &str) -> Result<String, Error>;

/// The zstd-prefix and size sanity checks from `download_runtimes`, then blake2_256.
pub fn check_and_hash_runtime(blob: &[u8], skip_checks: bool) -> Result<[u8; 32], Error>;

pub struct UpgradeInput {
    pub relay: Network,                       // Polkadot or Kusama
    pub runtimes: Vec<(Network, [u8; 32])>,   // chain and code hash, in batch order
    pub additional: Option<Vec<u8>>,          // extra Asset Hub call, as today
}

/// The proposal: `authorize_upgrade` per chain, sent by XCM where needed, in a `force_batch`.
/// Same bytes as today's `construct_batch`.
pub fn build_upgrade(input: UpgradeInput) -> Result<NetworkCall, Error>;

// --- submit-referendum ---

pub struct ReferendumInput {
    pub proposal: Vec<u8>,
    pub track: NetworkTrack,
    pub dispatch: DispatchTimeWrapper,
    pub fellowship_on_polkadot: bool,
}

pub struct ReferendumCalls {
    pub fellowship_preimage: Option<NetworkCall>,   // note_preimage, only when not Inline
    pub fellowship_referendum: Option<NetworkCall>, // fellowshipReferenda.submit
    pub public_preimage: NetworkCall,               // preimage.note_preimage, always the call
    pub public_referendum: NetworkCall,             // referenda.submit
    /// Hash and length of the public referendum's preimage (the `Lookup` it refers to).
    pub public_preimage_hash: [u8; 32],
    pub public_preimage_len: u32,
    /// Hash the Fellowship whitelists, when a whitelist is involved.
    pub whitelisted_call_hash: Option<[u8; 32]>,
}

pub fn referendum_calls(input: ReferendumInput) -> Result<ReferendumCalls, Error>;
```

Requirements:

- Functions are synchronous and pure: same input, same bytes.
- Every failure that is a panic today on user input (unknown network or track, non-semver
  version, bad hex, Inline limit exceeded on Kusama, both `at` and `after`, runtime check
  failures, undecodable proposal) becomes an `Err`. The CLI turns errors into the messages it
  prints today.
- The `output_len_limit` substitution moves to the CLI's printing code. The library always
  returns full calls.
- Track parsing from strings (today inside `submit_referendum::parse_inputs`) is available to the
  library, since the Wasm wrapper needs it too.

### Wasm exports (`wasm` feature)

Two functions, taking and returning JSON strings (or `JsValue` via `serde-wasm-bindgen`). Bytes
are `0x`-prefixed hex. Errors are thrown as JS errors carrying the message.

```ts
build_upgrade({
  relay: "polkadot",
  runtimes: [{ network: "asset-hub-polkadot", code_hash: "0x…" }, …],
  additional?: "0x…",
}) => { network: "asset-hub-polkadot", encoded: "0x…", hash: "0x…" }

referendum_calls({
  proposal: "0x…",
  network: "polkadot",
  track: "whitelistedcaller",
  dispatch: { after: 10 } | { at: 34030500 },
  fellowship_on_polkadot?: boolean,
}) => {
  fellowship_preimage: NetworkCall | null,
  fellowship_referendum: NetworkCall | null,
  public_preimage: NetworkCall,
  public_referendum: NetworkCall,
  public_preimage_hash: "0x…",
  public_preimage_len: number,
  whitelisted_call_hash: "0x…" | null,
}
```

Also export `runtime_file_name(network, version)` and `check_and_hash_runtime(bytes, skip_checks)`
so the browser uses the same naming and checks as the CLI. The browser fetches the blobs itself.

Build with `wasm-pack build --target web --no-default-features --features wasm`.

## Dependencies

The library needs only: the `subxt` codegen macro and the types it generates, `H256`,
`parity-scale-codec`, a blake2-256 implementation, and `hex`.

- Check the subxt documentation for the feature set that compiles the generated types for
  `wasm32-unknown-unknown` without the native RPC stack, rather than assuming one. If nothing
  suitable exists, the fallback is `subxt-core` plus the macro crate.
- `sp-core` and `sp-crypto-hashing` from polkadot-sdk `master` are a heavy, unpinned dependency
  for one hash function. Prefer a pinned crates.io release of `sp-crypto-hashing`, or a small
  blake2 crate, if the result is byte-identical.

## Acceptance

1. `cargo test` passes, including the existing encoding tests in `src/tests.rs`, unchanged in
   what they assert.
2. CLI behavior is unchanged: same flags, same output, same files written. For a fixed input,
   `build-upgrade --local` and `submit-referendum --output calldata` produce byte-identical
   output before and after.
3. New tests assert that the library functions return the same bytes as the CLI path for at
   least: a full Polkadot upgrade, an `--only` single-chain upgrade, a Polkadot
   `whitelistedcaller` referendum (Inline and Lookup Fellowship proposals), and a Polkadot `root`
   referendum.
4. CI builds the library for `wasm32-unknown-unknown` with the `wasm` feature.
5. CI publishes the `wasm-pack` output somewhere the portal can pin by version: an npm package or
   a release asset. State which in the PR.

## Out of scope

- Any change to which calls are built or how they are encoded.
- Kusama-specific work beyond keeping it working; the portal starts with Polkadot only.
