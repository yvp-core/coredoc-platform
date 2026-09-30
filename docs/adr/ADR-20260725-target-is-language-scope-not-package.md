---
id: ADR-20260725-target-is-language-scope-not-package
title: A profile target is a language scope, never a workspace package
status: accepted
supersedes: []
---

## Context
A multi-language repository is described by a composite profile made of targets, each parsed independently and merged into one result. The obvious decomposition for a monorepo is one target per workspace package: it matches how the repository is laid out on disk and how people talk about it. Cross-package call resolution, however, depends on indexing a whole language's sources together — the joins that connect a caller in one package to a definition in another only exist inside a single index over all of them. Splitting a language across several targets fragments that index and silently loses those edges.

## Decision
A target is a language scope — one language plus the patterns that include and exclude its files — and never a workspace package. Several packages of the same language share one target and therefore one index. Package topology stays internal to the engine and never sets target boundaries. Overlap between targets is guarded rather than tolerated: when two targets claim the same file the merge fails and names both, instead of duplicating every node in that file.

## Consequences
Easier: cross-package calls within a language resolve without extra work, and a monorepo of many same-language packages needs one target rather than one per package. Harder: a per-package target is not available as a scoping device, so narrowing extraction to a single package is expressed with include patterns inside the target instead. Files of a known language that no target claims are reported as unclaimed scope, so a coverage gap surfaces explicitly rather than vanishing. Reversing this would fragment the per-language index and lose cross-package resolution — the reason it is recorded here rather than left to the architecture prose.
