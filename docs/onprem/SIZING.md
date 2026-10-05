# Coredoc On-Prem — Sizing Guide

Starting points for a single-organization deployment. These match the chart
defaults (`charts/coredoc/values.yaml`) — start here, then adjust from
observed usage.

## Starting-point table

| Component | CPU | Memory | Storage | Notes |
|---|---|---|---|---|
| **coredoc-server** | 100m request / 400m limit | 256Mi request / 512Mi limit | — (stateless) | Single replica is fine to start; the server is stateless apart from its backends, so scale replicas horizontally behind the ingress if needed. |
| **Neo4j** (in-cluster subchart) | 2 CPU | 6Gi container / 2–4G JVM heap | PV via `defaultStorageClass`; grows with graph size | Chart defaults: `NEO4J_server_memory_heap_initial__size: 2G`, `..._max__size: 4G`. |
| **Postgres** (external) | small | small | small | Control plane only (workspaces, members, tokens, push jobs) — no graph data. Any modest managed instance works; prioritize backups/PITR over size. |

## Neo4j scales with the graph

Neo4j memory is the number that moves. A push applies its changeset in
**chunks**: each batch of `COREDOC_NEO4J_APPLY_BATCH_SIZE` rows (default 5000,
set on the server) commits in its own transaction, so transaction memory is
bounded by the batch, not by the repository. Lower the batch size if pushes
fail with `graph_apply_resource_limit`; raise it to cut round trips on a
well-provisioned instance. The 4G heap default is a sane start for typical
monorepos.

While a push is applying, readers can see a partly updated repository. If an
apply stops part-way, the repository stays marked in Neo4j and the next push
of that repository replaces its graph in full rather than diffing.

A large repository can take longer to apply than a CI step should block:
`coredoc ci run --no-wait` returns once the push job is queued (the server
finishes it in the background), or raise `--push-timeout` to keep watching.

When raising the heap, raise the container memory with it (keep container
memory comfortably above max heap — the default pairing is 6Gi container /
4G heap — Neo4j also uses off-heap page cache):

```yaml
neo4j:
  neo4j:
    resources:
      cpu: "2000m"
      memory: "8Gi"
  env:
    NEO4J_server_memory_heap_initial__size: "4G"
    NEO4J_server_memory_heap_max__size: "6G"
```

The Neo4j data volume grows with the total graph size (all repos × history of
pushes is not kept — the graph reflects current state, so growth tracks
codebase size and repo count). Start at 10–20Gi with a storage class that
supports volume expansion.

## When to scale what

| Symptom | Scale |
|---|---|
| Slow/failed pushes on the largest repo | Neo4j heap (+ container memory) |
| Slow MCP/graph queries across many repos | Neo4j CPU, then memory (page cache) |
| API latency under many concurrent MCP clients | `server.replicas` |
| Neo4j pod evicted / PV full | Neo4j volume size |
