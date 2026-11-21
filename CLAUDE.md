# Governance Portal

## Reading chain state

Prefer a runtime API (`api.apis.*`) or a pallet view function (`api.view.*`) to a storage item
(`api.query.*`). Runtime APIs and view functions are maintained interfaces, while storage items are
renamed, moved, and migrated in runtime upgrades.

Before adding a storage read, check the metadata of every chain it will run against for a runtime
API or view function that gives the same information. Read storage directly only when there is
none, and say so in a comment. This applies to the scripts and tests as well as the site.

As of November 2026 nothing that the portal reads has such an interface: referenda, votes,
preimages, the whitelist, the Fellowship, balances, pending upgrades, and identities are all
storage reads. Check again when the bundled metadata in `.papi/` is refreshed.
