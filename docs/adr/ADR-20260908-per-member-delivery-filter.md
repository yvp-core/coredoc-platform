---
id: ADR-20260908-per-member-delivery-filter
title: Delivery reads may be filtered by workspace member
status: accepted
supersedes: [ADR-20260724-blameless-delivery-analytics]
---

## Context
ADR-20260724 forbade every per-person delivery figure to keep the surfaces blameless. In practice the ban also removed the question a lead actually asks before a 1:1 or a handover — "what is this person's work sitting on?" — and members could not even see their own tasks without scanning the whole workspace. The filter that answers it is an intersection over the population the existing task/stage-grain figures already fold; it is not a ranking surface, and it does not add one.

## Decision
Delivery reads (`delivery/v2/summary`, `delivery/v2/task-summaries`) accept a `userId` naming a workspace member. Admins and owners may pass any member id; a `member`-role caller may pass only their own (anything else is a 403), and `mine=true` stays as sugar for the caller's own id. The filter intersects the population — the task is associated with a workflow run belonging to that member's agent sessions — and every figure keeps its existing task/stage grain. No ranking, no leaderboard, no cross-member comparison surface: the client renders one member at a time, chosen deliberately.

## Consequences
Easier: self-scoped views for members, and the "what is this person blocked on" question answered on the same figures instead of a new export. Harder: the blameless guarantee is now a product-and-review discipline rather than an absence of capability — any surface that puts two members' figures side by side, ranks them, or exports them per person is still out of bounds and must be rejected in review. The cursor identity binds the member id so a page cannot be replayed under another filter.
