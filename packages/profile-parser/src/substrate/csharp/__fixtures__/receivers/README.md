Compiler evidence regenerated with .NET SDK 10.0.401 and Coredoc scip-dotnet
`0.2.15-coredoc.1`. See the [reproduction instructions](../README.md).

Uses EntityFrameworkCore.Relational 10.0.6. `receiver-types.json` records concrete Roslyn identities and generic arguments at UTF-16 offsets. `Data.cs` intentionally has a UTF-8 BOM: offsets follow Roslyn SourceText, while source hashes retain the original bytes. Tests resolve EF operations from concrete DbSet receiver facts and reject the same methods on an unrelated receiver. The open TContext factory result is intentionally unknown; this fixture does not prove resolution of that hop.
