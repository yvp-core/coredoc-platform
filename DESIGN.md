# Design System — Coredoc

> **Source of truth:** the shipped tokens in `apps/desktop/src/renderer/styles/globals.css`.
> This document describes and governs that system, anchored on `apps/desktop`.
> Always read this file before making any visual or UI decision.
>
> **Working against it:** [docs/agents/design-system.md](docs/agents/design-system.md) says which
> artefact is authoritative for which kind of fact (tokens vs. per-screen layout vs. the Figma
> library, which mirrors the code and is never a source), and gives the loop to follow — ground
> the number in the frame, change the token, `design:check`, look at it running, push the
> library. Read it before any UI change, not just this file.

## Product Context
- **What this is:** AI-powered codebase analysis. Claude authors a declarative extraction profile per repo; a generic tree-sitter + SCIP engine applies it to extract structure, entrypoints, data models, and call graphs. Accessible via CLI, REST API, and MCP.
- **Who it's for:** Engineers and teams who need to understand and navigate large/unfamiliar codebases; AI agents querying the graph.
- **Space / peers:** Developer tools. Adjacent taste references: Linear, Raycast, Arc, Warp — native-feeling, glass-and-gradient productivity apps.
- **Project type:** Desktop application (Electron + React), local-first with a cloud workspace tier.

## Aesthetic Direction
- **Direction:** Refined / glassmorphic. Native-macOS-feeling instrument, not a web page.
- **Decoration level:** Intentional. Translucent panels layered over a subtle gradient ground (`public/bg.svg` — light mesh, `#D9D9D9` at low opacity). Not flat, not maximalist.
- **Mood:** Calm, precise, premium. The UI recedes so the code graph is the subject. Green signals "yours / local / done"; a blue→magenta gradient signals "AI / cloud / special."
- **Memorable thing:** The **local (green) ↔ cloud (blue) duality is encoded into the color system itself**, and the AI/accent flourish is a single recognizable blue→magenta gradient. That pairing is the face of the product.

## Typography
- **Family:** Inter Variable (`@fontsource-variable/inter`), single family for display, body, UI, and data. `--font-sans: "Inter Variable", sans-serif`.
  - *Note:* Inter is a deliberate, shipped choice, not a default-to-avoid. Keep it; do not swap without explicit approval.
- **Code / mono:** SF Mono → Monaco → Inconsolata → Roboto Mono stack (terminal + `.num`/id cells). Tabular numerals for all metrics and IDs.
- **Weight remap (important, non-standard):** every Tailwind weight utility is shifted one step lighter in `globals.css`. Use these class names and expect these weights:
  | Utility | Actual weight |
  |---|---|
  | `.font-normal` | 300 |
  | `.font-medium` | 400 |
  | `.font-semibold` | 500 |
  | `.font-bold` | 600 |
  | `.font-black` | 800 |
  Body default is 300. The app reads lighter and more refined than stock Tailwind on purpose.
- **Base size / density:** small and dense — `text-xs/relaxed` (~12px) is the workhorse; body ~13px, line-height 1.5. Feature settings `"rlig" 1, "calt" 1`.
- **Rough scale:** display ~34–52 / 600 · h1 17 / 600 · title 14 / 500 · body 13 / 300 · label 11 / 400 (uppercase, `.02em`) · mono 12.

## Color
Values are the shipped `globals.css` tokens (light theme is the app default).

- **Brand — green (identity, positive & create actions, "local" state):**
  - Logo `#1ACA92` · brand action `#079467` → hover `#12B981` · `content-brand` green-500 · `border-local` green-400.
  - Usage: the primary create/positive button (`variant="brand"`), the logo, "local repo" affordances, success emphasis.
- **Accent — gradient (AI & special emphasis):** `linear-gradient(273deg, #439CFB 0%, #F187FB 100%)` (dodger-blue → lavender-magenta).
  - Usage: gradient text (`.text-content-accent-default`), gradient icons (`.gradient-icon`), gradient mask-composite borders (`.border-accent`). Reserve for AI-driven surfaces — authored profile, agent runs, suggested edges. Do not use as a generic button fill.
- **Cloud — dodger blue `#439CFB`** (`border-cloud` dodger-400 `#5CB6FE`): the "cloud workspace" counterpart to local-green. It is the blue end of the accent gradient, on purpose.
  - **Text-safe step — dodger-600 `#2E7CD6`** (`content-tag-progress`): the blue to use when the cloud/candidate semantic is TEXT on a light surface. Dodger-500 is tuned for fills, rails and gradients and drops under AA as small text; dodger-600 is the same hue at a legible step. Fills and washes stay on dodger-100/500 — on the `bg-tag-progress` wash the darker blue is the *wrong* way round, so the filled `info` badge keeps `content-secondary`.
- **Neutrals — four grey families, not interchangeable.** Each has a role; do not substitute one for another:
  - **Zinc** (`Zink/*`) — text, icons, action surfaces. Content ramp: `content-primary` zinc-800 `#27272a` · `secondary` zinc-600 `#52525b` · `tertiary` zinc-500 `#71717a` · `quaternary` zinc-400 `#a1a1aa` · `inverted` white. Primary action fill zinc-950 `#09090b`, its border zinc-800, its disabled fill zinc-400.
  - **Alto** (`alto-50/200/300`) — input surfaces and hairlines: field fill `#fafafa` (`bg-input`), dividers/table hairlines `#e6e6e6` (`border-input`), field border `#d9d9d9` (`alto-300`).
  - **Gray** (`gray-50/100/200/300/500/600`) — graph filter chips and neutral tags: chip idle fill `#f3f4f6` / border `#e5e7eb`, chip selected fill `#d1d5db`, tertiary-button border and the sticky footer bar `#f9fafb`.
  - **Selago** (`selago-50/100`) — soft lilac surfaces: repo cards and the segmented-control track `#f7f7fb`, card borders and progress-bar tracks `#ebebf5` (`bg-tertiary`).
  - `--color-bg-bar` (white gradient) is a separate role from the design's `Background/Bar` `#f9fafb` — use `gray-50` for the sticky footer bar, never `bg-bar`.
- **Semantic tags** (bg + content token pairs; always labelled): `initial` gray · `progress` dodger-blue · `success` green · `warning` amber · `info` orange · `error` red. Filled and outline variants both exist (`badge.tsx`).
- **Dark mode:** `.dark` class exists (shadcn slate defaults: `--background: 222.2 84% 4.9%`) but the app currently runs light-first (`lib/explorer-theme.ts`, no shipped toggle). Treat light as canonical; if a real dark theme lands, redesign surfaces rather than only inverting, and keep the green/accent hues (drop saturation ~10–20%).
- **Graph palette:** categorical node colors (`--n-*`, 14 node types) and edge-provenance colors (`--edge-parser|ai|human|crossrepo`) are read at paint time by `viz-style.ts` via `getComputedStyle`. When touching the explorer, change the token, never a hardcoded hex.

## Spacing
- **Base unit:** 4px (Tailwind v4 default scale).
- **Density:** compact → comfortable. Buttons `h-9` (36px) default / `h-7` (sm) / `h-5` (xs). Cards `py-3`, `px-6`. Tight, information-dense layouts.
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48).

## Layout
- **Approach:** grid-disciplined app chrome (sidebar nav + main), with frosted glass as the surface system.
- **Border radius:** `--radius: 0.5rem` (8px). Scale: `sm` 4px · `md` 6px · `lg` 8px (buttons) · cards `rounded-xl` 12px · overlays up to 16px.
- **Surfaces & depth (the glass system):**
  - Translucent white borders — `--color-border-primary: rgba(255,255,255,0.5)`.
  - Backdrop blur — `--blur-foundation: 3px`, `--blur-action: 20px`; buttons carry `backdrop-blur-[10px]`.
  - Two white-gradient fills, both needing the `@utility` escape hatch because `bg-*` compiles to `background-color` and a gradient is not one: `--color-bg-secondary` (0.64 → 0.56, over the page ground) and `--color-bg-panel` (0.80 → 0.66, for the docked right panel floating over the graph canvas).
  - **Surface A / Surface B — the two recurring recipes.** Every panel, drawer, dialog and content card is one of them. Both ship as `@utility` classes that paint background + shadow only; **border color and radius stay with the consumer**, because they differ per surface.
    - `.surface-a` — glass panel: gradient `rgba(255,255,255,.80) → .66`, `backdrop-filter: blur(8px)`, `shadow-foundation` (`0 1px 3px rgba(0,0,0,.1)`). Radius 12 (`rounded-xl`); border `border-tertiary` `#d4d4d8` on dialogs, `border-secondary` `#fafafa` on drawers.
    - `.surface-b` — content card: gradient `rgba(255,255,255,.57) → .48`, `shadow-foundation`, **no backdrop blur** (perf rule 1). Radius 16 (`rounded-2xl`); 8 on the graph filter panel; border `#fafafa` where drawn.
  - **Scrim** — `--color-bg-scrim: #0000004d` (black 30%), the full-screen overlay behind every dialog. No blur on the scrim; the blur lives on the panel.
  - Gradient mask-composite borders — `.border-controls` (neutral) and `.border-accent` (accent gradient + baked glass fill) paint a 1–2px border via `mask-composite: exclude`. For a fill-agnostic accent ring on top of any button background (Figma `Border/Accent/Default`), use `border-accent-gradient` with `border-2` — the element keeps a transparent 2px border for geometry and the masked `::before` paints `--color-border-accent` over it. Never approximate this token with a flat `border-lavender-magenta-400`.
  - 6 shadow elevations: `--shadow-foundation | field | surface | feature | action | scroll` (use `surface` for cards, `action` for buttons, `feature` for raised/floating).
- **Electron chrome:** `.drag-region` / `.no-drag` for the custom title bar.

## Motion
- **Approach:** intentional / functional — motion aids comprehension, never decorates.
- **Patterns:** `transition-all` on interactive elements; `.animate-indeterminate` loader bar; view-enter rise; graph node-pulse / edge-flow in the explorer.
- **Easing / duration:** enter ease-out · exit ease-in · move ease-in-out; micro 50–140ms (hovers/transitions), short 150–340ms (view enter). Always honor `prefers-reduced-motion: reduce`.

## Component Conventions
- **Stack:** shadcn/ui (style `radix-mira`, baseColor `zinc`) over Radix + Base UI primitives, `class-variance-authority` for variants, `cn()` (`tailwind-merge`) for class composition.
- **Icons:** Solar (`@solar-icons/react`) primary, Lucide secondary.
- **Modal pattern (`components/ui/dialog.tsx`):** the single source of the dialog surface. Scrim `bg-bg-scrim`; panel = Surface A + `border-border-tertiary` + `rounded-xl` + `py-1.5` (no ring — one hairline only); default width `sm:max-w-[480px]`. Slots: `DialogHeader` (16/16/12), `DialogBody` (4/16/8, `gap-4`), `DialogFooter` (8/16/10, right-aligned, `gap-2`, Cancel `secondary` then the primary action). `DialogTitle` is 16/24/800 (`font-black`) `content-primary`. `hideOverlay` and `showCloseButton` are part of the API; `className` always wins via `cn()`.
- **Buttons (`components/ui/button.tsx`):** variants `default` (zinc-950 fill + zinc-800 border; disabled zinc-400, borderless) · **`brand`** (green `#079467`) · `outline` · `secondary` (transparent + zinc-700 border, `content-primary` label) · `ghost` · `destructive` (red-600 fill, no border; disabled red-300) · `link` · `wrapper`. Sizes `default/xs/sm/lg` + `icon(-xs/-sm/-lg)`.
  - Design → code variant mapping: design **primary** = `default` · **secondary** = `secondary` · **tertiary / white** = `outline` · **destructive** = `destructive`. There is no fifth design button.
  - Glass (`backdrop-blur-[10px]`) is carried only by the transparent variants (`secondary`, `ghost`) — perf rule 3.
- **Badges (`components/ui/badge.tsx`):** full semantic matrix — `initial/success/warning/error/info` (filled) and `outlineInitial/outlineSuccess/outlineInfo`, plus base `default/secondary/outline/ghost`.
- **Cards (`components/ui/card.tsx`):** frosted panel — `bg-card` + `border-border-primary` + `shadow-surface` + `rounded-xl`, with `hover` and `data-[selected]` states; `default` and `sm` sizes.

## Performance Deviations from Figma
The shipped surfaces intentionally diverge from the literal Figma values below. These are rules, not one-off exceptions — apply them to new work.
1. Surface B ships **without** `backdrop-filter`: the design's 1.5px blur is invisible over an opaque ground and the graph canvas repaint cost is real. Gradient + border + box-shadow only.
2. `filter: drop-shadow(...)` → `box-shadow` for anything with a background. Reserve `drop-shadow` for transparent SVG glyphs.
3. `backdrop-blur` only on transparent button variants (`secondary`, `ghost`); stripped from opaque fills (`default`, `brand`, `destructive`, `outline`).
4. The terminal column is an opaque sibling **outside** the blurred drawer element, never a blurred child.
5. The 344↔768 drawer width switch is not animated.
6. `XTerminal`'s ResizeObserver fit is rAF-coalesced/debounced.

## Conformance checks
The mechanically verifiable part of this document. Run it before and after any desktop UI change:
- `pnpm --filter @coredoc/desktop design:check` (`apps/desktop/scripts/design-conformance.mjs`, no deps, no running app).
- **Gradient tokens (ERROR):** a gradient-valued token used via `bg-*`/`text-*`/`border-*`/`ring-*` compiles to `background-color`/`color`/`border-color`, which reject gradients — the rule is dropped and the surface paints nothing. Use a dedicated `@utility` that sets `background:` (`bg-panel` is the reference).
- **Raw colors (WARN):** arbitrary literals like `text-[#079467]` in the renderer. Deliberate exceptions go in `scripts/design-conformance-allowlist.json` with a `reason`.
- **Figma drift:** `--figma-vars <dump.json>` compares `@theme` values to a `get_variable_defs` export, reporting `MATCH` / `DRIFT(old→new)` / `UNMAPPED` / `UNVERIFIABLE` (gradients export empty and are never guessed at).
- Exit is non-zero on ERROR only, unless `--strict`. The `coredoc-design-conformance` skill covers the agent-session workflow; `--self-test` verifies the checker itself.

## Component vocabulary settled by review
These were re-derived wrongly at least once. They are facts now, not preferences.
- **Button Circle (top-bar 32px disc) has no selected state.** The design ships one recipe
  (Figma `4841:18548`); a second fill made one control read as two. Toggle state is legible
  from the panel it opens.
- **Top-bar icons** (Figma `4841:18546`): header `Window Frame` · tabs `Share Circle` / `Chat Line` /
  `Chart 2` · right cluster `Code File` then `Link Circle` · CTA `User Plus`. The Team MCP drawer
  heading pairs with the **outline** `Link Circle`, matching the top bar's connect button.
- **Repo cards are Selago** (`selago-50` fill, `selago-100` border), everywhere — the workspace-graph
  drawer row and the project card are the same card and must not carry two greys.
- **Explorer filter chips have exactly two states** (on/off) and their face never grows extra text;
  a truncation shortfall belongs in the `title`, not the label.
- **Icon weight is part of the icon.** `Outline / …` → default weight, `Bold / …` → `weight="Bold"`.
  Mixing them reads as the wrong glyph.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-03 | Analytics tab redesign (Usage / Delivery views): new chart tokens `--color-chart-grid` (alto-200) and `--color-chart-axis` (alto-300); a sequential **brand-family** stage ramp `--color-chart-stage-1..5` aliasing `green-300, green-400, green-500, green-600, green-800`; the existing tooltip recipe (`bg-bg-inverted-secondary` + inverted text) reused for chart hover readouts; one segmented-control recipe (`SegmentedControl`, same face as `DaysSelector`) for the lifecycle filter, with `Tabs` variant `pill` for the view switch. Figma library push pending. | The charts are hand-rolled SVG (no chart library), so grid/axis and stage colours had to become tokens rather than literals — `design:check` gates zero raw hex in the new files. The stage ramp is deliberately a single-hue brand ramp because stages are **pipeline progress**, not a categorical state family: a categorical palette would imply the stages are unordered peers. Aliasing a Tailwind ramp for a semantic token follows the existing `globals.css` precedent (`--color-content-tag-success`, `--color-border-local`). Full context: `.scratch/analytics-redesign/spec.md` ADR-7. |
| 2026-09-02 | Intent KB redesign palette: option A + text-safe blue; POC dark palette and opaque cards rejected. Added the `dodger-blue-600` primitive and `content-tag-progress` alias; no violet replacement pair, no soft-error tag. Per-screen note: the CoreDoc Figma FRAME needs the Intent tab's waiting-count chip added (top-bar discovery badge), not just the library. | The candidate/cloud semantic is the most repeated one on the intent surface and the only place the POC's palette was more accessible than the shipped one; everything else maps onto existing tokens. Dark mode and opaque white cards would fork the surface system for one tab. Decision input: `.scratch/intent-cloud-design/desktop-redesign/token-comparison.md`. |
| 2026-08-08 | Design-review QA pass: icon vocabulary fixed against the current Figma frame, Button Circle selected state removed, repo cards aligned on Selago, chip faces frozen at two states, `Anthropic OAuth token` → `Claude Subscription Token`, MCP config blocks wrap instead of scrolling, Team MCP CTA yields to the connect icon once connected, workspace entry lands on Graph | Findings from the 2026-08-08 review over the built app (working notes lived in `.scratch/design-review-2026-08/`, since removed; this row is the record). The review's node (`4841:18530`) is newer than the 2026-08-07 extraction (`4832:1910`), so icon and layout facts were re-pulled rather than taken from the distilled specs. |
| 2026-08-07 | Figma restyle vocabulary: four grey families, Surface A/B recipes, scrim + modal pattern, button variant mapping, perf deviation rules 1–6 | Reconciled the shipped tokens with Figma file `5RjMUITUnQvGc0jkQzCoKk` (design specs in `.scratch/figma-styles-update/design-specs/`). The deviations are performance-motivated and deliberate. |
| 2026-07-24 | DESIGN.md created, anchored on `apps/desktop` | Codified the shipped desktop system as the canonical source of truth (via `/design-consultation`). `apps/web` is a POC on a divergent dark theme and is explicitly out of scope for the standard. |
