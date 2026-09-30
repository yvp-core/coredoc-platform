# Cross-Repo Analysis Guide

Use `list_service_dependencies` to inventory outbound boundaries and `trace_cross_repo_call` to follow a specific request/response or messaging address.

## Tools

### `list_service_dependencies`

Lists external services and systems called by the current/vantage repo, including protocols, counts, resolution counts, and example patterns. Messaging patterns use `messaging:<system>:<destination>`; legacy systemless rows use `messaging:unknown:<destination>`.

### `trace_cross_repo_call`

Request/response mode accepts one of:

- `targetService` — summarize calls to a service.
- `callPattern` — match an HTTP route or SDK/dynamic method name. Bare tokens also match generic messaging destinations, with legacy Kafka fallback.

Messaging mode accepts:

- `destination` — exact, case-sensitive destination.
- `system` — optional, trimmed and case-insensitive.

`destination` cannot be combined with `targetService` or `callPattern`, and `system` is invalid without `destination`. When the same destination occurs in multiple systems and `system` is omitted, the tool returns an explicit ambiguity with `availableSystems`. The literal `unknown` is reserved for legacy rows whose system was not persisted; an actual system named `unknown` cannot be selected separately.

### `list_entrypoints`

For messaging consumers, query `type: "queue"` or `type: "event"`. The optional `system` filter is case-insensitive and rows expose the system, destination token, and resolved destination value. `system: "unknown"` selects legacy systemless rows.

## Workflows

### Map service architecture

1. `describe_repository` → confirm `availableRepos` and scope.
2. `list_service_dependencies` → inventory outbound boundaries.
3. `trace_cross_repo_call` for important HTTP/SDK patterns or messaging destinations.

### Trace a request

1. `explain(target: "POST /orders")` → inspect outbound calls.
2. `trace_cross_repo_call(callPattern: "POST /api/inventory")` → locate the receiving entrypoint.
3. `explain` the receiving endpoint in its repo.

### Follow an SDK-mediated call

1. `list_service_dependencies` → find SDK method patterns.
2. `trace_cross_repo_call(callPattern: "linkSubscription")` → resolve the target and provenance chain.
3. `explain` the resolved endpoint.

### Trace messaging

1. `list_entrypoints(type: "queue", system: "kafka")` and/or `list_entrypoints(type: "event")` → inspect consumers.
2. `trace_cross_repo_call(destination: "user-events", system: "kafka")` → join producers and consumers.
3. If the system is unknown, omit it and handle any returned ambiguity explicitly.
4. If one side is missing, grep the destination constant in source and report the extraction gap.

## Scope

Explicit scopes, host bindings, and cloud workspace scopes are hard boundaries. Only destination-mode tracing may query the whole graph when the local invocation is genuinely unbound. Cross-scope request/response tracing follows a persisted `resolvedTargetId` when available.

## Tips

- `analyze_change_impact` already includes cross-repo impacts.
- Messaging systems are normalized; destinations remain case-sensitive.
- Producer profiles and consumer queue-system/event-emitter fields must use the same system spelling (for example, both `celery`); otherwise the linker will not invent a broker.
- Re-parse old graphs to populate messaging systems, generic destination fields, and IPC addresses.
