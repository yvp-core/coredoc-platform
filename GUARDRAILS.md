# Guardrails — Coredoc

Last reviewed: 2026-09-22

Concrete boundaries for building Coredoc. Use [AGENTS.md](AGENTS.md) for working
style and [DoD.md](DoD.md) for proportionate validation. These rules preserve
existing guarantees; they do not require new defensive infrastructure for every task.

## Non-negotiables

1. **Keep secrets out of source, logs, and reports.** Do not commit credentials,
   session tokens, signed URLs, database connection strings, or real `.env` files.
   Use placeholders in examples.
2. **Preserve source-stripping on remote graph paths.** Do not bypass
   `packages/db/src/strip-source.ts` or the server's `NoSourceCodePipe` to make a
   failing push pass. Fix the producer. Local source retention is a separate path.
3. **Preserve stable identity.** Changes to `StableIdGenerator`, its inputs, or
   `{repoHash}:{type}:{path}:{name}` / `{stableId}@{checksum}` need an explicit
   migration or approved cutover. These are persisted graph and relationship keys.
4. **Check shared consumers before editing.** This includes core/profile/output
   contracts, MCP signatures and server routes. Update affected consumers together;
   do not perform a blind codebase-wide rename. See [AGENTS.md](AGENTS.md#scope-and-execution).
5. **Preserve actual access and data boundaries.** Do not introduce cross-workspace
   access, expose credentials, or perform unapproved destructive operations on
   user/production data. “Trusted repository” does not remove cloud tenant boundaries.
6. **Keep the diff honest.** No unrelated edits or hidden check bypasses. A necessary
   narrow suppression needs a concrete reason. `CHANGELOG.md` belongs to releases.

## Trusted repositories and proportionate protection

Parsing/enhanced indexing may run repository build code and use the network.
The supported expectation is trusted repositories and trusted branches; document
that clearly. This is not a promise to safely execute arbitrary hostile code.
A new sandbox, permission model, access tier, approval flow, or cache requires a
current requirement or demonstrated failure, not an imagined enterprise deployment.

Reuse the controls the affected path already has. Do not expand or remove them
incidentally. If a limitation or ordinary retry/rebuild is sufficient for the
accepted use case, prefer it. New requirements for untrusted execution or stronger
isolation need a separate scope decision.

## When to ask

Ask when a consequential product/architecture choice is unresolved, or when an
action would destroy data, publish/deploy, or cross the user's authorized scope.
An authorized change to CI, auth, a schema, or a shared API is not by itself a
reason to ask again. Name the specific unresolved consequence; do not gate work
solely on an impact tool's HIGH/CRITICAL label.

Apply decisions already made, including accepted risks, trusted-input assumptions,
and an approved wipe/reseed. Reopen them only when new evidence changes their premise.
Stop after the relevant validation passes; do not invent additional sign-offs.
