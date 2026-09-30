# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub
private vulnerability reporting on this repository (**Security → Report a
vulnerability**) and include affected versions or commits, reproduction steps,
impact, and any suggested mitigation.

The maintainers will acknowledge a complete report within seven days and will
coordinate disclosure after a fix or mitigation is available. Please avoid
accessing data that is not yours while validating a report.

## Supported versions

Security fixes are issued for the latest release. Older releases may be asked
to upgrade before a fix is backported.

## Scope notes

- Enhanced C#/Go/Rust analysis can execute repository build code; run it only
  on trusted code (see [CI setup](ci/README.md)).
- Source code is stripped from graphs before any remote push; the server
  rejects uploads that contain it unless explicitly configured otherwise.
- `apps/server/src/modules/license/test-fixtures/` holds a throwaway test
  keypair that is not a production key.
