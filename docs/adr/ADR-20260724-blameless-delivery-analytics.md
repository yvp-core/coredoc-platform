---
id: ADR-20260724-blameless-delivery-analytics
title: Keep every delivery-analytics surface blameless — no per-person aggregates
status: superseded
supersedes: []
superseded_by: [ADR-20260908-per-member-delivery-filter]
---

## Context
Delivery intelligence joins planning, code, review, and agent-session data — enough to rank individuals. Ranked-people dashboards corrupt the data they read (people optimize the metric, stop linking work honestly) and turn a diagnostic tool into a surveillance tool; managers will nonetheless ask for per-person views.

## Decision
No delivery surface aggregates by person. Attribution is by subsystem, work item, or process stage. A work item's title/key is identity enough; actor identity exists in the canonical model for linking, never for ranking. Labels render as confidence-scored leading indicators, not verdicts.

## Consequences
Easier: honest linking (nobody games what isn't scored), classifier data stays trustworthy, adoption inside teams. Harder: "who is slow?" questions get answered with "which stage/subsystem is slow" instead — by design. Commits every future dashboard, export, and API read to subsystem/item grain. (Origin: desktop delivery-insights + view-legibility specs, reaffirmed in the Now/Trends redesign.)
