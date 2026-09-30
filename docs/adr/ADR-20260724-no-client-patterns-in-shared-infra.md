---
id: ADR-20260724-no-client-patterns-in-shared-infra
title: Never inline a specific client's patterns into shared infrastructure
status: accepted
supersedes: []
---

## Context
Coredoc is a SaaS product whose engine, plugins, and docs ship to arbitrary customers, but features get built and validated against specific pilot repos. Client names, orgs, domains, and domain vocabulary leak naturally into examples, fixtures, CI templates, and heuristics — a confidentiality violation and a portability bug at once.

## Decision
Shared infrastructure (engine, plugins, templates, docs, test fixtures) carries no client-identifying material: no client org/repo names, product domains, or domain vocabulary, and no behavior gated on a detected client/framework identity. Examples use neutral placeholders; anything client-specific is config-driven or lives in the client's own (gitignored) artifacts.

## Consequences
Easier: shipping any artifact to any customer without a scrub pass; examples stay meaningful to every reader. Harder: writing examples takes deliberate neutralization, and real-client validation results must be recorded with placeholders. Commits reviews to treating a client identifier in shared code as a defect, not a style issue. (Origin: standing shared-infra rule; reaffirmed by the 2026-07-24 confidentiality scrub.)
