# C# compiler fixtures

These decoded SCIP fixtures were regenerated with .NET SDK 10.0.401 and
[Coredoc scip-dotnet 0.2.15-coredoc.1](https://github.com/yvp-core/scip-dotnet/releases/tag/0.2.15-coredoc.1),
commit `b3c9a8e59c1396de33cd7e25a51f9f8c679080de`.
Archive SHA-256: `1ed60c52134515fc72b81fa06846bd75dda343bb22db223dd1a09ee2b4ec7ba5`.

With .NET SDK 10 on PATH, from the Coredoc checkout:

```sh
coredoc tools install csharp
pnpm exec tsx scripts/regen-csharp-fixtures.ts
pnpm --filter @coredoc/profile-parser exec vitest run src/substrate/csharp/semantic.test.ts
```

The generator requires the already installed, checksum-pinned release. It never
installs a tool. Restore/index run on isolated copies, and temporary compiler
artifacts are removed. It writes only the checked-in decoded fixture files.
Generated source documents are excluded and projectRoot becomes `file:///fixture`.
The receivers fixture includes supplemental facts; the other fixtures deliberately
omit them to exercise ordinary SCIP. No application or database is started.
Offline unit tests re-encode these documents with the real SCIP codec.
