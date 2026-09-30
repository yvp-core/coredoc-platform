Compiler evidence regenerated with .NET SDK 10.0.401 and Coredoc scip-dotnet
`0.2.15-coredoc.1`. See the [reproduction instructions](../README.md).

Reproduces incorrect inferred overload identity and a missing explicit generic reference in upstream revision `47884461a79839fb74c99e6a0a7978cd7eb62476`. Both calls in the released fork target `Choose<T>(T)`.
