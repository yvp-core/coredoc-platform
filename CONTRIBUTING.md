# Contributing

Thanks for improving Coredoc.

## Before opening a pull request

1. Read [AGENTS.md](AGENTS.md) and [DoD.md](DoD.md): make the smallest useful
   change and follow the nearest existing analogue. Parser work follows the
   [language guide](docs/ADDING-A-LANGUAGE.md) or
   [framework guide](docs/ADDING-A-FRAMEWORK.md).
2. Add or update a regression test for observable behavior.
3. Run the checks that match the change (see
   [DoD](DoD.md#4-validation-baseline)), typically:

   ```bash
   pnpm install
   pnpm build
   pnpm typecheck
   pnpm check
   pnpm --filter @coredoc/<pkg> test
   ```

Node.js 22+ and the pnpm version pinned in `package.json` are required.

## Fixtures and data

Never commit credentials, private repository names or paths, customer data,
captured telemetry, or graphs/snapshots derived from a private codebase. Use
neutral fixtures (`acme-*`, `example.test`). Eval target manifests and run
artifacts for private repositories stay out of the tree (see `.gitignore`).

## Sign-off

Contributions are accepted under the Apache License 2.0. Sign off each commit
(`git commit -s`) to certify the
[Developer Certificate of Origin](https://developercertificate.org/).

## Pull requests

Explain the user-visible outcome, risk, validation performed, and any check
that could not be run.
