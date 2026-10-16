# Design system: what is authoritative, and the loop for UI work

Read this before touching anything visual in `apps/desktop`. [DESIGN.md](../../DESIGN.md)
describes the system; this file describes **where its facts live and how to work against
them**. Sessions have repeatedly re-derived values by eye from a screenshot crop and got
them wrong — the whole point of the list below is that you never have to.

## The five artefacts, and what each one is authoritative for

| Artefact | Authoritative for | Not authoritative for |
|---|---|---|
| `apps/desktop/src/renderer/styles/globals.css` | Token **values** as shipped — every `--color-*`, shadow, blur, radius | Whether a surface *should* use a given token |
| [DESIGN.md](../../DESIGN.md) | The **vocabulary**: grey families and their roles, Surface A/B recipes, button variant mapping, the weight remap, the performance deviations | Per-screen layout |
| Figma file `5RjMUITUnQvGc0jkQzCoKk` ("CoreDoc") | Per-screen **layout, composition, icon choice, states** | Anything the perf-deviation list overrides |
| Figma library `idOJ0ISbJdYW9gzw1w4tr0` | Nothing. It is the **code → Figma export**, a mirror | Never treat it as a source; it follows the code |

When two of them disagree, the order is: perf deviations in DESIGN.md → the CoreDoc Figma
file → the distilled specs → the shipped CSS. A disagreement is a finding, not a licence
to pick the convenient one — say so in the change.

## The loop

1. **Read** DESIGN.md, then the distilled spec for the surface you are touching.
2. **Ground the numbers.** If the spec does not carry the value, pull the frame:
   `get_metadata(fileKey, nodeId)` gives you exact x/y/width/height per layer, which is how
   you settle a spacing question. `get_screenshot` settles a *colour or fill* question.
   Never settle either from a cropped screenshot pasted into a review — crops carry no scale.
3. **Change the token, not the site.** A hardcoded hex in the renderer is a `design:check`
   warning for a reason. If a value is missing, add the token.
4. **`pnpm --filter @coredoc/desktop design:check`** before and after. Zero errors is the bar;
   new warnings need an allowlist entry with a `reason`.
5. **Look at it running.** `COREDOC_DESKTOP_QA_PORT=9333 pnpm --filter @coredoc/desktop dev`,
   then drive it with the `coredoc-desktop` skill and screenshot the surface. A visual change
   that was never rendered is not verified, and typecheck will not catch a class that
   silently no-ops.
6. **Push the library.** Once components change in code, update the Figma library file so the
   mirror stops lying. This is the step that is forgotten most often.

## Pulling shadows and styles out of Figma

You do not have to eyeball an effect. `get_variable_defs` returns the named styles with
their full definitions, including effects:

```
Shadows/Action      Effect(BACKGROUND_BLUR, 20); Effect(DROP_SHADOW, #0000000D, (0,5), 5);
                    Effect(DROP_SHADOW, #00000008, (0,2), 2); Effect(DROP_SHADOW, #00000008, (0,1), 0)
Shadows/Fields      Effect(DROP_SHADOW, #0000001A, (0,0), 2)
Shadows/Foundation  Effect(DROP_SHADOW, #0000001A, (0,1), 3); Effect(BACKGROUND_BLUR, 3)
```

Read those as CSS: the drop shadows concatenate into `box-shadow` (offset-x, offset-y, blur,
spread, colour), and a `BACKGROUND_BLUR` is a separate `backdrop-filter` — it is **not** part of
the shadow, which is why `--shadow-action` and `--blur-action` are two tokens.

Feed the dump straight into the drift check rather than diffing it by hand:

```bash
node scripts/design-conformance.mjs --figma-vars <dump.json>
```

It reports `MATCH` / `DRIFT(old→new)` / `UNMAPPED` / `UNVERIFIABLE`, and counts (without
listing) the non-colour variables. Two things it deliberately cannot do:

- **Gradients export as an empty string**, so gradient-valued tokens come back `UNVERIFIABLE`
  and are never guessed at. `Background/Secondary/Default` — the content underlay — is one of
  them, so its opacity has to come from `get_design_context` on the node, not from the variables.
- **Aliases into Tailwind's built-in palette** are `UNVERIFIABLE`. `@theme` defines no
  `--color-zinc-*`; the semantic tokens alias into Tailwind's ramp, and the checker carries no
  copy of it. Resolving those would need a Tailwind default-palette table.

`UNMAPPED` means a Figma colour variable has no counterpart in `FIGMA_TOKEN_MAP`
(`scripts/design-conformance-lib.mjs`) — it is a lookup table, edit it freely.

## Reading an icon out of Figma

Figma layer names are `Outline / <Category> / <Name>` or `Bold / <Category> / <Name>`. The
`@solar-icons/react` export is `<Name>` in PascalCase with the spaces removed, and the prefix
is the weight:

- `Outline / Network, IT, Programming / Window Frame` → `<WindowFrame />` (default weight)
- `Bold / Messages, Conversation / Plain` → `<Plain weight="Bold" />`

Getting the weight wrong is a real visual bug and reads as "wrong icon" in review — an
outline glyph and its Bold twin do not look like the same family.

Verify the export exists before using it:

```bash
grep -rl "declare const WindowFrame:" apps/desktop/node_modules/@solar-icons/react/dist/types
```

## Traps this repo has already hit

- **The weight remap.** Every Tailwind weight utility is one step lighter than its name
  (`font-bold` → 600). Read the table in DESIGN.md; do not reason from stock Tailwind.
- **Gradient tokens through colour utilities.** A gradient-valued token used via `bg-*`
  compiles to `background-color`, which rejects gradients — the rule drops and the surface
  paints nothing. Use the dedicated `@utility`. `design:check` CHECK A catches this.
- **A state that should not exist.** Before adding a selected/active fill, check whether the
  design ships one recipe for that component. Two fills for one control read as two controls.
- **One card, two greys.** Repo cards are Selago (`selago-50`/`selago-100`). If you are about
  to style a card that already exists elsewhere, go and look at the twin first.
- **Value-importing the `@coredoc/core` root in the renderer** breaks the browser bundle. Type-only, or value-import the browser-safe `@coredoc/core/browser/*` subpaths.

## Where a design review lives

A review with findings goes to a spec file, with before/after screenshots
beside it. The ledger is
the recovery map when a review spans more than one session — record what landed, what was
measured and found already-correct, and what is blocked and on whom.
