Compiler evidence regenerated with .NET SDK 10.0.401 and Coredoc scip-dotnet
`0.2.15-coredoc.1`. See the [reproduction instructions](../README.md).

Reproduces upstream scip-dotnet [issue #85](https://github.com/sourcegraph/scip-dotnet/issues/85): `Left.Shared.Service.Ping` and `Right.Shared.Service.Ping` have the same SCIP symbol. Excluding Right.cs must leave Caller.Run unresolved; the provider must not select the sole in-scope definition.
