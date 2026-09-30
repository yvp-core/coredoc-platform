---
id: ADR-20260724-machine-derived-rederivable-human-ground-truth
title: Machine-derived rows are re-derivable and prunable; human labels are ground truth and never auto-deleted
status: accepted
supersedes: []
---

## Context
The delivery pipeline derives rows from canonical data (links, rework episodes, journeys) and lets humans correct machine labels. Derived rows go stale when detectors/resolvers improve; without a deletion rule they become permanent ghosts, but deleting human input would destroy the only data that cannot be recomputed.

## Decision
Two classes with opposite lifecycles. Machine-derived rows are deterministic functions of canonical data: safe to prune when their producer no longer emits them and safe to re-derive at any time. Human-entered corrections/labels are ground truth: never auto-deleted, never reselected for reclassification, and they win over machine output wherever both exist.

## Consequences
Easier: detector/classifier improvements converge the data automatically (re-derive + prune); reverts are safe by construction. Harder: any new derived table must declare its natural key and its producer so pruning is possible; human-labeled rows can outlive the conditions that created them and need occasional human curation. (Origin: rework detectors/classifier design; the spec-churn D7@2 fix added the pruning half.)
