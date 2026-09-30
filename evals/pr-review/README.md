# PR review evidence

These are plain cohort and human-adjudication records. They do not modify the
planning eval harness or claim primary admission there.

## Prepare before paid runs

The pilot owner records repository/PR, immutable base/merge-base/head SHAs, a
named model and effective sampling settings, the frozen runtime and policy,
finite per-run/total budgets, expected defect labels, negative twins, and the
minimum useful improvement and tolerable false-positive/latency/cost regression.
Use `cohort.example.json` as a template in a private output directory.

Historical requests are fed to `coredoc review run --request ... --output ...`.
Capture prospective requests when the PR is reviewed. Pair arm A (source) with
arm B (same runtime/model/policy/budget, plus graph). Preserve graph identity,
commit, relation/ahead/behind counts and admission from every report.

Prepare historical B's base graph locally, outside the review runner. A live or
post-review graph makes historical B diagnostic; use prospective cases for the
primary H-2 decision. A failed B attempt remains a failed treatment, not control.

## Keep the assessment blind

- Every independently seeded defect has a handled/adversarial negative twin.
  Example: a changed divisor can be zero; its twin preserves an effective zero
  guard. Give each pair a named failure hypothesis and immutable Git SHAs.
- Keep expected labels, paired identities and other arms' outputs outside the
  source checkout visible to the model. `evals/pr-review/` and `.scratch/` are
  always excluded by the reviewer, but private external storage is preferred.
- Assign opaque report IDs for the human review. Reveal arms only after labels
  are recorded. Label findings by root cause: actionable, false positive,
  duplicate, style-only, unresolved. Reactions/merges are not ground truth.
- A missed seed is adjudicated; do not retry until the model finds it. Record
  every scheduled attempt, including cancellation and unknown charges.
- Record Greptile as arm C only when the same revisions/settings are accessible.
  Otherwise report `unavailable`; do not infer parity or Greptile internals.

## Decide

Summarize precision (undefined for zero findings), known-defect recall, false
positive and duplicate burden, useful findings, completion, latency and cost.
Keep completed-only scores separate from all-attempt results. Show paired A/B
differences and uncertainty; small samples do not establish product parity.

Record H-1 and H-2 separately as `proceed`, `iterate`, `stop` or
`insufficient_evidence`. H-3 is `not_evaluated` until Gate 2 is explicitly chosen.
An unfinished Eve trial is recorded as deferred; freeze the direct AI SDK
runtime and continue. Never swap runtimes within a measured cohort.

No real cohort, human label or product outcome is pre-populated by this change.
The unit tests use mock model responses to test control flow and invariants,
not model precision. Provider/model, paid budget and tolerances remain pilot-owner inputs.

## Local run artifacts

Only this protocol and the cohort/adjudication templates are versioned here.
Store requests, reports, provider traces and human labels in private external
storage or the ignored `evals/pr-review/pilots/` directory. They are run outputs,
not test fixtures or inputs to the CI eval harness. Do not commit credentials or
raw provider reasoning. Frozen historical requests may use an older schema;
prepare new requests with the current CLI before rerunning a case.

The retained local engineering pilots do not establish representative review
quality, graph benefit or Greptile parity. Independent human adjudication and a
measured cohort remain pending. Eve is deferred and is not shipped in this PR.
