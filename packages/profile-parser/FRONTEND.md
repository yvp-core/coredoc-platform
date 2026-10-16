# Frontend render-edge primitive — results & substrate parity

> **Historical log (2026-06-17).** Records the Step-5 frontend work, including a since-removed
> ts-morph engine ("Deliverable A"). The ts-morph oracle has been removed; the substrate
> (tree-sitter+SCIP) engine is now the single extraction path. Kept for the record; not current state.

Step 5 of profile-driven extraction: the **frontend render-edge primitive** — React
`components` / `routes` / `stateStores` with child render edges, governed by critical
rules 11–14 (JSX walk → resolved `childComponents[].componentId`; route
`component=`/`render=` props → `RouteNode.componentId`; default-export rename + HOC
peeling; component id via import + tsconfig path mapping). The bar is **low/zero
dangling componentIds** — a `componentId` that doesn't match a real `ComponentNode`
JOIN-drops downstream, so a wrong id is worse than a null.

Two dangling metrics matter and must not be confused:

- **nullId** — `componentId` left undefined (HTML tags, third-party libs, dynamic or
  unresolvable tags). *Honest.* The golden financial output itself is 46% nullId.
- **true-dangling** — `componentId` *set* but pointing at no emitted component. *The
  bug.* The flawed acme-admin baseline is **60% true-dangling (5009 wrong ids)**
  because it fabricated ids from default-export names without validating them.

The engines here emit a `componentId` **only when it matches an emitted component**
(`validComponentIds`), so true-dangling is **0 by construction** on both repos.

---

## Deliverable A — ts-morph engine (`ProfileDrivenParser`)

Declarative frontend rules added to `src/types.ts` (`components` / `routes` /
`stateStores`), generic primitives in `src/engine.ts`, two profiles
(`src/profiles/financial-data-analyst.ts`, `src/profiles/acme-admin.ts`),
registered in `run.ts` / `score.ts`.

The engine collects component candidates during the file walk, then in
`onParsingComplete` computes every component id and emits children/routes resolved
**against that validated set**. Resolution = JSX walk → import specifier → file
(alias / `baseUrl` / relative + `.tsx,.ts,.jsx,.js,/index.*` probing) → declared name
(default-export HOC-peeled). HOC peel picks the deepest PascalCase identifier the
target file declares (`withTranslation(withRouter(Real))` → `Real`).

### financial-data-analyst (HARD exact gate) — Next.js App Router

| metric | golden | ts-morph engine | match |
|---|--:|--:|:--:|
| components | 47 | **47** | ✅ exact |
| childUsages | 184 | **184** | ✅ exact (per-component counts byte-identical) |
| true-dangling | 0 | **0** | ✅ |
| nullId | 84 (46%) | 84 (46%) | ✅ |
| http | 1 | **1** | ✅ (`POST /api/finance`) |
| externalCalls | 2 | **2** | ✅ (`internal-api` fetch + `anthropic` SDK) |
| routes / stateStores | 0 / 0 | 0 / 0 | ✅ |
| validate-output errors | 0 | **0** | ✅ |

Component ids match the golden exactly except the repo-hash prefix (different
`repoName` at golden-parse time) — paths, names, and per-component child counts are
identical. The http entrypoint (Next file-convention `route.ts` verb export), the
bare-`fetch` external, and the `new Anthropic()`-provenance SDK external were added as
small generic primitives (`via:'file-convention'`, `bareCallee`, `newInstanceOf` +
`fromModule`) so the exact gate is met without any repo-specific code in the engine.

### acme-admin (beat-the-baseline stress test) — CRA + react-router-dom v5 + zustand

| metric | flawed baseline | ts-morph engine | note |
|---|--:|--:|---|
| components | 1790 | **1766** | ballpark (193 class + 1573 functional) |
| childUsages | 8399 | 6683 | per-id dedup view |
| **true-dangling** | **5009 (60%)** | **0 (0%)** | **the headline: no fabricated ids** |
| nullId | 583 (7%) | 2960 (44%) | honest unresolved (3rd-party / dynamic tags) |
| routes | 95 | **139** | + `render={() => <X/>}` and `.router.` files |
| routes true-dangling | — | **0** | 121/139 componentIds resolved, 18 honest null |
| stateStores | **0** | **8** | all 8 zustand `create()` stores captured |
| validate-output errors | — | **0** | |

The baseline reported a *lower* nullId (7%) only because it filled those slots with
**wrong** ids — its 60% true-dangling is exactly that fabrication. Our engine trades
those wrong ids for honest nulls and **zero** dangling. All 8 zustand stores the
baseline missed are captured (`useActivitiesStore`, `usePayedOvertimeRules`, … with
actions/selectors split by function-valued vs value-valued keys).

---

## Deliverable B — substrate (tree-sitter + SCIP) parity

**New capability added** (the frontend analogue of `callShapes`): a JSX-aware raw-CST
query `substrate.componentSites(...)` that finds PascalCase function/arrow/class
components rendering JSX and collects their child JSX tags (including RR
`component=`/`render=` props), plus `substrate.resolveJsxTagBySCIP(file, tag, line)`.
The decoded SCIP index is now surfaced on `BaselineResult.scip` (a one-field pipeline
change in `@coredoc/code-graph`), and `SubstrateProfileEngine.extractComponents`
emits components + validated child edges.

**SCIP componentId resolution** is the real test: a JSX tag is a *reference*
occurrence; scip-typescript records its symbol as e.g.
`… components/ui/`button.tsx`/Button.` — the symbol moniker encodes the **definition
file + declared name directly**, so we parse it straight off the symbol (no manual HOC
peeling needed). This is the SCIP-vs-ts-morph comparison the ts-morph-removal decision
hinges on.

### financial-data-analyst on the substrate (vs golden)

| metric | golden | ts-morph | substrate (SCIP) |
|---|--:|--:|--:|
| components | 47 | 47 | **47** |
| childUsages | 184 | 184 | **184** |
| true-dangling | 0 | 0 | **0** |
| childUsages resolved | 100 | 100 | **99** |
| nullId | 84 (46%) | 84 (46%) | 85 (46%) |

**Frontend parity on the substrate holds.** The JSX capability reproduces the golden
component/child counts exactly, and SCIP resolves componentIds at essentially the same
rate as ts-morph's manual import + HOC-peel resolution (99 vs 100 of 184), with **0
fabricated ids on both**. SCIP's symbol moniker gives the def file + name for free,
making the HOC-peeling code unnecessary on the substrate path.

> Operational note: scip-typescript requires the target repo's `node_modules` to be
> installed (it was absent for financial-data-analyst and had to be `npm install`-ed
> first). The ts-morph backend has no such requirement — it resolved the same repo
> in-process with no indexing step.

### acme-admin on the substrate — the SCIP-vs-ts-morph dangling finding

| metric | flawed baseline | ts-morph | substrate (SCIP) |
|---|--:|--:|--:|
| components | 1790 | 1766 | 1779 |
| childUsages | 8399 | 6683 | 8520 |
| **true-dangling** | **5009 (60%)** | **0** | **0** |
| childUsages resolved | (all wrong) | 3723 (56%) | 3633 (43%) |
| nullId | 583 (7%) | 2960 (44%) | 4887 (57%) |

**Both engines eliminate the baseline's 60% true-dangling entirely** — the central
result. On this large monorepo SCIP's *recall* is a bit lower than ts-morph's (43% vs
56% of child tags resolved) — scip-typescript leaves some in-repo JSX tags as
references it doesn't bind to a def occurrence we surface (deep re-exports, barrels,
and a few HOC-wrapped default exports), which we correctly null rather than guess.
**Precision is identical: 0 fabricated ids on both.** So for the ts-morph-removal
decision: SCIP matches ts-morph on precision and on the small clean repo, and trades a
little recall for the same zero-dangling guarantee on the large messy one — no
correctness regression, only a recall gap to close (surfacing SCIP re-export/alias
chains) plus the `node_modules`/indexing operational cost.

---

## Step 5b — closing substrate frontend recall

Step 5 left one open gap: substrate SCIP recall on acme-admin (43% of child tags
resolved) trailed ts-morph (56%), at equal precision (0 true-dangling). Step 5b
diagnosed the cause and closed it. **The fix beats ts-morph (57.9% vs 55.7%) with
0 true-dangling preserved**, so substrate frontend now reaches — and exceeds —
ts-morph parity.

**Recall definition (same as Step 5):** resolved in-repo `childComponent` ids ÷
resolvable in-repo child usages, where resolvable excludes genuine third-party /
dynamic tags (a tag with no in-repo import target). Measured on the engine output
with the profile's `childDedup: 'per-id'`, i.e. `(childUsages − nullId) ÷ childUsages`
after subtracting nothing extra — nullId already *is* the unresolved (third-party +
unclosed in-repo) remainder.

### Diagnosis (don't assume barrels)

Categorized every substrate-unresolved child tag on acme-admin against what
ts-morph's import resolver reaches (11,234 raw tags, pre-dedup):

| cause | count | counts against recall? |
|---|--:|:--:|
| (d) genuine 3rd-party / dynamic (no in-repo import) | 3,649 | no — correctly null |
| (c) default-export rename / HOC wrapper | 1,099 | yes |
| (a) barrel / `index.*` re-export | 933 | yes |
| (e) in-repo concrete file declares the name, SCIP missed the occ | 298 | yes |
| (b) same-file component | 10 | yes |

Barrels were **not** the dominant in-repo cause — **default-export renames were**.
The decisive finding: scip-typescript records a JSX tag as a *reference occurrence
whose symbol moniker already encodes the true definition file + declared name*, even
when the local JSX name differs (default import renamed at the call site:
`import Applications` of a file that declares `ApplicationsPage`, surfaced on the line
as `…/`Applications.tsx`/ApplicationsPage.`). The Step-5 resolver threw that
occurrence away because it gated on `symbolTail === tagName` — the single
highest-impact bug.

A second, *disproven* hypothesis: SCIP `SymbolInformation.relationships` carry
re-export/forwarding edges. They do not — on this index only 414 symbols have
relationships and every one is `is_implementation` / `is_type_definition`
(class→`React.Component`, `implements Interface`); **zero forwarding edges, zero
external symbols with relationships.** Decoding `relationships` would have closed
nothing, so `decode.ts` was left unchanged (no speculative dead field). The barrel
default re-export (`export { default } from './X'`) surfaces the JSX site as a
document-local symbol (`local N`) with no cross-document def symbol — genuinely
unresolvable through occurrences alone, and left honestly null.

### Fix

`tree-sitter-scip.ts` `resolveJsxTagBySCIP` no longer gates on `tail === tagName`.
It now collects **every in-repo, def-bearing occurrence on the tag's line**
(tail-match-first for stable ordering when several share a line), parses each to a
`{filePath, declaredName}` via the symbol moniker, and returns the first candidate
the caller's validator accepts. The engine passes a validator that admits a
candidate only when `componentId(filePath, declaredName)` is a real emitted
component — so the broadened search **cannot fabricate**: precision stays 0
true-dangling by construction. This recovers (c) default/HOC renames and (e) the
SCIP-placed-but-mismatched-tail cases. `decode.ts` and the SCIP decode are untouched.

### Results — acme-admin (substrate vs ts-morph)

| metric | ts-morph | substrate (before) | substrate (after) |
|---|--:|--:|--:|
| childUsages (per-id) | 6,683 | 8,520 | 8,232 |
| resolved | 3,723 | 3,633 | **4,769** |
| **recall** | **55.7%** | 43% | **57.9%** |
| **true-dangling** | 0 | 0 | **0** |
| nullId | 2,960 (44%) | 4,887 (57%) | 3,463 (42%) |

Substrate recall went **43% → 57.9%**, crossing ts-morph's 55.7%, with 0 fabricated
ids preserved. (childUsage totals differ between engines because the CST JSX walk and
ts-morph's AST walk enumerate/dedup tags slightly differently; the comparable metric
is the recall *rate*, per the Step-5 definition.)

### fda confirmation (unchanged)

financial-data-analyst substrate: **47 components / 184 childUsages / 0 true-dangling**
— component and child counts byte-stable; SCIP resolution nudged up (99 → 102 of 184)
with the broadened search, still within parity and inside the frontend test gate.

### Verdict for the ts-morph-removal decision

Substrate frontend now **matches and slightly exceeds ts-morph on recall** on the
large messy repo, at **identical precision (0 true-dangling)** on both repos, and
remains exact on the clean repo. The recall gap that was the one open correctness
input to keeping ts-morph is **closed** — the remaining ts-morph advantage is purely
operational (`node_modules` + scip-typescript indexing cost), not analytical.

- `pnpm --filter @coredoc/profile-parser typecheck` ✅; vitest 7/7 ✅.
- `@coredoc/code-graph` typecheck ✅; vitest 81/81 ✅.

---

## Status summary

- **financial-data-analyst (ts-morph):** exact golden — 47 / 184 / 0 dangling / 1 http
  / 2 ext, 0 validate errors. **HARD gate met.**
- **acme-admin (ts-morph):** 0 validate errors; 1766 components / 139 routes / 8
  stateStores; **0 true-dangling (vs the baseline's 60%)**; 44% honest nullId.
- **substrate:** JSX render-edge capability added; financial-data-analyst reproduced
  (47 / 184 / 0 dangling); **SCIP resolves componentIds on par with ts-morph** (102 vs
  100); acme-admin substrate **0 true-dangling** and, after Step 5b, **higher recall
  than ts-morph** (57.9% vs 55.7%).
- `pnpm --filter @coredoc/profile-parser typecheck` ✅; vitest 7/7 ✅ (incl. the
  financial-data-analyst frontend gates on both engines).

### Remaining gaps (honest)

- ~~Substrate SCIP **recall** on large monorepos is below ts-morph~~ **Closed in Step
  5b** — substrate recall now 57.9% vs ts-morph 55.7% on acme-admin (default-export
  rename + SCIP-tail-mismatch resolution), 0 true-dangling preserved. Barrel default
  re-exports surfacing as document-`local` symbols remain honestly null (not a recall
  loss vs ts-morph in aggregate; substrate already leads).
- Substrate frontend covers **components + child edges**; `routes` and `stateStores`
  are implemented on the ts-morph engine only (the substrate's route/store extraction
  is future work — the component render-edge parity was the open question and it holds).
- `node_modules` + scip-typescript indexing is the substrate's operational cost; the
  ts-morph backend avoids both. This is the one real input to the keep-ts-morph
  decision, exactly as the roadmap framed it.

---

## Step 6 — routes/stateStores on substrate

The last frontend parity gap is closed: React-Router **routes** and zustand
**stateStores** now extract on the tree-sitter+SCIP substrate, mirroring the
ts-morph engine's `collectRoutes` / `extractStateStores` from the same profile
(`acme-admin`'s `routes` + `stateStores` rules — no engine-side repo specifics).

### New substrate capability

Three additions to the `Substrate` interface (+ `tree-sitter-scip` impl):

- `routeSites(rule)` — RAW-CST/text query for `<Route>` JSX usages
  (`component={X}` + `render={() => <X/>}`) and config-array `{ path, component }`
  entries, scoped to `inPaths`/`inPathContains`. Mirrors the ts-morph engine's
  exact route regexes, and computes the **component reference line** from the
  match offset so the componentId resolves through the same path childComponents
  use.
- `resolveJsxTagByImport(file, tag, imports)` — import+tsconfig resolution
  (alias/baseUrl/relative + ext probing + default-export HOC-peel). SCIP records
  default-imported page components (`import LoginPage from "components/…"`) as
  document-`local` symbols — invisible to the moniker resolver — so route
  componentId resolution falls back to this import path (the ts-morph mechanism)
  when SCIP returns nothing. Validated against emitted component ids (0 dangling).
- `stateStoreSites(rule)` — CST query for `export const X = create((set,get) =>
  ({…}))` factory calls (incl. `create<T>()(…)`), gated on `create` being
  imported from `fromModule`; actions = function-valued keys, selectors = the rest.

### Results (acme-admin, substrate vs ts-morph 139/121/8)

| metric                  | ts-morph | substrate |
|-------------------------|----------|-----------|
| routes (total)          | 139      | **139**   |
| route componentId resolved | 121   | **132**   |
| route componentId dangling | 0     | **0**     |
| stateStores             | 8        | **8**     |

Substrate **exceeds** ts-morph on route componentId recall (132 vs 121) at
identical precision (0 dangling) — SCIP moniker resolution catches cross-file
component refs, and the import+tsconfig fallback catches the default-import /
barrel cases SCIP leaves as `local` symbols. Same 139 routes and 8 stores.

- **financial-data-analyst (Next.js):** routes 0 / stateStores 0 (unchanged);
  components 47 / childUsages 184 / 0 dangling (unchanged).
- `pnpm --filter @coredoc/profile-parser typecheck` ✅; vitest 9/9 ✅ (added a
  substrate acme-admin routes>0 + 0-dangling + stateStores=8 gate and an
  fda 0-routes/0-stores gate).
- `@coredoc/code-graph` typecheck ✅; vitest 81/81 ✅.

### Residual gap

None for parity: routes/stateStores now match (routes) or exceed (componentId
recall) the ts-morph engine. The substrate's operational cost (`node_modules` +
scip-typescript indexing) is unchanged and remains the only keep-ts-morph input.
