---
id: ADR-20260724-precision-first-verification
title: A precision-first extractor is verified by anti-scenarios + graph-wide invariants, never coverage bars
status: accepted
supersedes: []
---

## Context
An extractor whose contract is "false output is worse than missing output" (a code-graph substrate: a wrong CALL edge misleads `find_callers` more than an absent one) cannot be validated by the instruments that measure coverage. SF-20260724 (the Python substrate) proved this at cost: its 11 Given/When/Then Scenarios were all positive ("emits X for Y"), its precision bar was a 20-edge uniform random sample, and its empirical validation was recall percentages + node/edge counts + a PASS scorecard. Everything passed. A separate adversarial `/review` then found **14 systematic wrong-output bugs** (cross-file same-name self-edges, host-only egress, un-joinable route templates, dropped chained-queryset writes). None were visible to the pipeline: a plausible-but-wrong edge *increments* every coverage counter, and a systematic defect that hits a small fraction of a 78k-edge graph passes a uniform sample with ~98% probability. Precision-first was **claimed** in prose and **verified** coverage-first.

## Decision
For any extractor whose contract is precision-first, verification must carry three things beyond coverage:
1. **Anti-scenarios.** Every emitting Scenario (a Then that adds to an output set) pairs with a "must NOT emit wrong-X for adversarial input Z" twin, with a named failure hypothesis (collision / shadow / alias / empty / dedup / chained-call).
2. **Graph-wide property assertions** over the *whole* output, not a sample — e.g. no cross-file same-name self-edge unless import-linked; no `pathTemplate == '/'` or raw-regex/unrendered-`{}` template; a shared symbol's performer id equals its call-graph node id. Cheap (O(edges)) and immune to sampling luck.
3. **A blind adversarial review as a gating phase**, run by fresh context with the diff but not the implementer's tests or rationale, prompted "find where this emits plausible-but-wrong output" — its confirmed correctness findings block "done," they are not advisory.

Coverage counts, recall rates, and random samples may inform the retro but may never stand as the precision bar.

## Consequences
Easier: systematic wrong-output is caught at authoring/build time instead of by the luck of someone running a review; the "precision-first" claim becomes falsifiable; the adversary catches whole bug classes the author is blind to (an implementer who never imagined cross-file class collisions writes neither the bug's fix nor its twin test). Harder: every emitting scenario carries a negative twin, every category carries a standing invariant test, and the definition-of-done gains a blind-review gate. (Origin: SF-20260724 Python substrate + its `/review` remediation and `/advisor` retro — the spec built the right thing correctly and graded itself on the one axis that could not see the defects.)
