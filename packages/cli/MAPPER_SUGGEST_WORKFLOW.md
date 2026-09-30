# Resolving "no SDK mapping" cross-repo gaps

When a service calls an SDK method whose source code we can't parse (vendor SDK
distributed only as a built artefact, dev-branch additions not yet committed,
private wrapper, etc.), the cross-repo resolver knows **which service to route
to** but not **which HTTP route** the method actually calls. Those calls bucket
as `no-sdk-mapping`.

This guide explains the `mapper suggest` + `mapper apply-suggestions` workflow
to close those gaps **with reviewable, auditable mapper.json entries** — never
auto-applied, never heuristic-guessed without your confirmation.

## When to use it

After `coredoc push` reports unresolved calls, check whether they're real cross-
repo gaps or expected infrastructure (kafka/redis/etc.):

```bash
coredoc mapper status --project <id>
# baseline rate: 75.3%   (1287/1709 resolved)
```

If the rate plateaus and `cross-service-report` shows many calls with target
service known but no path template, this workflow is the next step.

## Three-step workflow

### Step 1 — Generate proposals

```bash
coredoc mapper suggest --project <id> --mode prompt
```

Writes two files:
- `<project>/mapper-suggestions.json` — structured data: per-method group
  with sdkPackage, sdkClass, sdkMethod, target service/repo, call count,
  and the ranked candidate routes that exist on the target service.
- `<project>/mapper-suggestions.prompt.md` — a self-contained LLM prompt
  with each (sdk_method, candidate_routes) tuple in JSON. Paste the whole
  thing into Claude / GPT / Gemini.

The CLI prints a summary like:

```
  Unresolved calls : 107
  Unique methods   : 39
    with ≥1 candidate route : 38
    with 0 candidate routes : 1

Top unresolved methods (by call count):
    14 × bulkUpsertTasks   → sample-projects   (20 candidate routes)
    11 × getUserProfileByUuid → demo-core         (20 candidate routes)
    ...
```

`(N candidate routes)` is shown when there's no obvious single match — that's
where the LLM (or you) decide. When there's a clear single match, the route
is printed inline as a hint.

### Step 2 — Review with an LLM (or by hand)

**With LLM**: Paste the `.prompt.md` content into your assistant. The prompt
asks for a JSON reply with `{ id, match, confidence }` per item. The LLM
replies with the route it thinks each SDK method calls (`match: null` if
unsure — it's instructed to NOT guess).

Convert the LLM reply to the merge format. For each non-null match, build:

```json
{
  "sdkPackage": "<from suggestions.json>",
  "sdkClass": "<canonical service from suggestions.json>",
  "sdkMethod": "<from suggestions.json>",
  "targetService": "<canonical service from suggestions.json>",
  "http": { "method": "POST", "pathTemplate": "<the matched route>" }
}
```

Save the array as `mapper-suggestions.review.json` next to the prompt file.

**By hand**: Open `mapper-suggestions.json`, pick a candidate per group, build
the same array. Skip groups you're unsure about — they stay as
`no-sdk-mapping` until you address them later.

### Step 3 — Apply with validation

```bash
# Always preview first
coredoc mapper apply-suggestions --project <id> --dry-run

# When the diff looks right
coredoc mapper apply-suggestions --project <id>
```

This:
1. Validates each entry against the v1 SdkMapping schema (fields required,
   types correct).
2. Skips entries whose `(sdkPackage, sdkClass, sdkMethod)` triple already
   exists in `mapper.json` — pass `--overwrite` to replace.
3. Backs up the prior `mapper.json` to `mapper.json.bak`.
4. Re-validates the merged mapper before writing.
5. Reports added / replaced / skipped / rejected counts.

After applying, re-run `coredoc push` so the new mappings are baked into
RESOLVES_TO edges in the graph:

```bash
coredoc push <repo> --project <id> --rebuild
# repeat for every repo whose calls were affected
```

## Safety properties

- **No auto-apply.** Every change is reviewable and requires explicit
  `apply-suggestions` invocation.
- **No project-specific heuristics.** The candidate ranking is pure
  token-overlap on the method name vs. the path. The only domain knowledge
  is the universal REST verb table (`get*` → GET, `delete*` → DELETE, etc.).
- **Schema validation on both ends.** Suggestion files are validated by
  `apply-suggestions` against the v1 SdkMapping zod schema, and the merged
  mapper is re-validated before write.
- **Backup on every write.** `mapper.json.bak` always reflects the state
  before the most recent apply.
- **Top-N capping.** Prompt mode emits at most 20 ranked candidates per
  method to keep LLM context manageable. Heuristic mode filters more
  aggressively via `--min-overlap`.

## Modes

| `--mode` | What you get | When to use |
|---|---|---|
| `prompt` (default) | LLM-ready prompt + structured JSON | You have access to an LLM. Recommended — leverages model judgement. |
| `heuristic` | JSON only; candidates filtered by token-overlap ≥ `--min-overlap` (default 2) | No LLM. Conservative; many groups will need manual review. |
| `both` | Both files | Compare LLM output against heuristic ranking before applying. |

## What this command **doesn't** solve

- Calls with `serviceName='sampleApiClient'` (or similar receiver names) that
  the resolver can't even canonicalise to a target service. Those bucket as
  `service-alias-unknown` — fix by adding aliases to `mapper.services[].aliases`
  in `mapper.json`.
- Genuinely unresolvable calls (infrastructure like kafka/redis, outbound
  customer webhooks, in-process temporal activities). Those belong in
  `mapper.unresolvableServices`.
- Path matches that almost-match-but-differ (e.g., entrypoint has `:id`
  where caller has literal `inconsistency`). The resolver's segment-wise
  matching already handles those — no manual sdkMapping needed.

## Reference

- Schema: `packages/core/src/cross-repo/mapper-schema.ts` (search for
  `SdkMappingSchema`).
- Engine: `packages/core/src/cross-repo/mapper-engine.ts` (`lookupSdkMapping`
  is where these entries get consulted).
- Tests: `packages/core/src/cross-repo/mapper-engine.test.ts`.
