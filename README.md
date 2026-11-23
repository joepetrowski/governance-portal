# Polkadot Governance Portal

The [Polkadot Governance Portal](https://polkadot.petrow.ski/) is a tool for creating and following
active referenda. Its focus is Polkadot, specifically the Root, Whitelisted Caller, and Staking
Admin tracks. It also supports Kusama, including upgrade referenda that use the Polkadot Fellowship
to whitelist a proposal.

## Features

The portal:

- Lists active referenda and lets connected accounts vote on them.
- Links related referenda, such as a Whitelisted Caller referendum and the Fellowship referendum
  that whitelists it.
- Gives every card a link, such as `#polkadot-1973`, that opens the page on that referendum.
- Keeps showing a Fellowship referendum after it has passed, with its final tally, while the public
  referendum that it whitelisted is open.
- Builds system upgrade proposals from a Fellowship release in a release wizard, using
  [`opengov`](https://github.com/joepetrowski/opengov-cli).
- Creates referenda, and gives a link to share for those that a user cannot create (e.g., if they
  are not a Fellow of sufficient rank).
- Decodes proposals across all chains to show what each one does.
- Prompts to apply an authorized upgrade when one is pending.
- Prompts to clear votes and locks on a connected account.

## Design

The portal presents a unified view of the network, exposing details like specific parachains only
when pertinent to evaluating a proposal.

When possible, the portal presents information semantically. For example, instead of a generic
"Proposal to `System.authorize_upgrade`", the portal matches the inner code hash with a Fellowship
release and displays "System upgrade to version 2.6.0". When it cannot confidently express this, it
defaults to plainly stating a proposal's calls.

The portal is a static site and does not store any information specific to users. It reads only
live chain state and does not index data itself or rely on API calls to third-party indexers. It
uses GitHub's API to download runtime build artifacts. It hashes each Wasm blob and compares the
hash to the release notes, but it does not build the blob from source.

The portal is not a discussion forum and does not display referenda once they are no longer active.

## Development

You need Node.js 22 or later. `npm install` fetches the dependencies, including the prebuilt
`opengov` WebAssembly package, and generates the chain descriptors from the metadata in `.papi/`.

Everyday commands:

- `npm run dev`: local development server.
- `npm run build`: type check and production build in `dist/` (what Netlify runs).
- `npm test`: run the tests. They decode recorded calls against the bundled metadata and need no
  network.
- `npm run lint`: lint with oxlint.
- `npm run format`: format with Prettier.

Maintenance commands:

- `npm run snapshot`: print the proposals the page would show, read from live chains.
- `npx tsx scripts/fixtures.ts`: record the test fixtures again from live chains.
- `npx papi update`: refresh the bundled chain metadata in `.papi/`, then `npx papi`.

## Deployment

The portal is hosted on Netlify, which builds and publishes every push to `main`. The configuration
is in `netlify.toml`. Two parts of it are needed by the portal, so a copy hosted elsewhere must
provide them too:

- **A proxy for runtime files.** GitHub serves release assets without CORS headers, so a browser
  cannot read them directly. The edge function in `netlify/edge-functions/release-asset.js` serves
  them at `/release-asset/:tag/:file`. It fetches only runtime files of `polkadot-fellows/runtimes`
  releases, and stores nothing.
- **Security headers.** The content security policy lists every host that the portal may connect to.
  An RPC endpoint added to `src/chains.ts` must also be added there, which a test checks.

`npm run dev` does not apply the headers, and it replaces the edge function with a proxy of its
own. To test both as Netlify serves them, build the portal and run
`npx netlify dev --offline --dir dist`.

## Contributing

The portal is open source and contributions are welcome. Open an issue or a pull request. Automated
checks cover formatting, lint, tests, and the build on every pull request.

## License

The portal is licensed under the [Apache License, Version 2.0](LICENSE).
