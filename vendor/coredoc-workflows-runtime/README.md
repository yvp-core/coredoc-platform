# Vendored coredoc-workflows runtime subset

Pinned snapshot of the **product-required** runtime subset of the
`coredoc-workflows` plugin, whose canonical home is the external OSS repo
<https://github.com/yvp-core/coredoc-workflows>. The in-repo plugin copy was
removed (see AGENTS.md "Standing facts"); this directory retains only what the
product itself tests:

- `runtime/capture/` — the capture contract modules and `contract-corpus.json`,
  the cross-repo contract fixture consumed by
  `apps/server/src/modules/capture/capture-contract.test.ts`.

The relay/attribution `scripts/` are gone: the capture relay is a
plugin-managed agent now, so the desktop no longer provisions, supervises, or
packages it.

Pinned at fork plugin version `0.11.1`, fork build `5` (internal fork's
`plugins/coredoc-workflows`, commit `19ca2f2`, 2026-09-08), which introduced
the schema-4 `workflow.question.answered` event. Earlier pin: the last in-repo
plugin version (0.10.2). The OSS repo may be ahead; syncing this subset is a
deliberate, reviewed bump — update the files here from the OSS release, re-run
the server capture-contract test, and record the new version in this README. Do not edit these files in place for
product changes; product-side divergence belongs upstream first.
