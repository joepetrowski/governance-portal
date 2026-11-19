# Polkadot governance portal

Static site for creating and following Polkadot runtime upgrade referenda. It reads chain state
directly and presents the Fellowship and public referenda as one system.

- `npm run dev`: local development.
- `npm run build`: production build in `dist/` (what Netlify runs).
- `npm run snapshot`: print the proposals the page would show, read from live chains.
- `npx papi update`: refresh the bundled chain metadata in `.papi/`, then `npx papi`.

`docs/opengov-cli-library-brief.md` describes the opengov-cli change the release wizard needs.
