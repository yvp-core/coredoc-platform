---
name: coredoc-design-conformance
description: Mechanically check the desktop renderer against its token system — gradient tokens used through plain color utilities, arbitrary color literals, and drift between globals.css and the Figma variables. Use before and after any UI work in apps/desktop.
---

# Design conformance

`DESIGN.md` is the source of truth; this checker is the part of it a machine can
verify. Run it before touching desktop UI (to know the pre-existing findings) and
after (to prove you added none). It reads `apps/desktop/src/renderer/styles/globals.css`
and every renderer `.ts`/`.tsx`, and needs no dependencies or running app.

```bash
pnpm --filter @coredoc/desktop design:check           # checks A and B
pnpm --filter @coredoc/desktop design:check -- --strict   # warnings fail too
node apps/desktop/scripts/design-conformance.mjs --self-test
```

## What it catches

- **CHECK A (ERROR)** — a gradient-valued token used through `bg-*`, `text-*`,
  `border-*`, or `ring-*`. Tailwind emits `background-color`/`color`/`border-color`,
  those properties reject a gradient, and the declaration is silently dropped, so
  the surface paints nothing. The fix is a dedicated `@utility` that sets
  `background:` — `bg-panel` in `globals.css` is the reference shape. A utility
  named exactly like the color utility is recognized as correct, not flagged.
- **CHECK B (WARN)** — arbitrary color literals such as `text-[#079467]` in
  renderer components. Deliberate exceptions belong in
  `apps/desktop/scripts/design-conformance-allowlist.json`; every entry needs a
  `reason`, and a reasonless entry is reported as an ERROR.
- **CHECK C (drift, opt-in)** — `@theme` values against a Figma variable dump.

## Figma drift mode

In an agent session with the Figma MCP server, call `get_variable_defs` on the
relevant node ids, save the returned `name -> value` object as JSON, and pass it in:

```bash
node apps/desktop/scripts/design-conformance.mjs --figma-vars /tmp/figma-vars.json
```

Figma exports gradients as an empty value, so those are reported `UNVERIFIABLE`
rather than read as a change. Variable names map to css tokens automatically when
they normalize to the same name (`Bg/info` → `--color-bg-info`); anything else is
`UNMAPPED` until it is added to `FIGMA_TOKEN_MAP` at the top of
`apps/desktop/scripts/design-conformance-lib.mjs`. `MATCH` and `DRIFT(old → new)` cover the rest, and a
token whose value is an alias the checker cannot resolve is `UNVERIFIABLE` too —
never treat that as a pass.

## Reading the report

Findings are `file:line` with the offending utility. Exit is non-zero on any
ERROR; warnings and drift exit zero unless `--strict`. Fix only what your task
authorizes: pre-existing findings on the base branch are data to report, not
scope to absorb. A `DRIFT` is a design question — confirm the intended value with
the user before editing a token.
