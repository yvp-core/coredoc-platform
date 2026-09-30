---
id: ADR-20260724-explicit-degrade-no-silent-zeros
title: Every aggregate degrades explicitly — a missing source is never a silent zero
status: accepted
supersedes: []
---

## Context
Analytics surfaces read from sources that can be absent, stale, truncated, or gated (no code graph pushed, feature disabled, list limits, unclassified rows). A dashboard that renders 0 for "unavailable" teaches users that its numbers lie, and one such cell poisons trust in every other cell.

## Decision
Absence, truncation, and gating are first-class rendered states, never zeros: availability flags on graph-fused reads, a distinct disabled sentinel for feature-off, "based on N of M" captions on any limit-bounded roll-up, null metrics rendered as explicit empty states, small samples flagged as directional.

## Consequences
Easier: users can trust a rendered number is a measured number; debugging ("why is this empty?") is self-serve. Harder: every new read must design its degrade states up front — an unavailable-source path is part of the feature, not an edge case. Commits new endpoints to carrying provenance (availability/sample-size) alongside values. (Origin: L4 delivery-intelligence design; enforced across all delivery specs.)
