Compiler evidence regenerated with .NET SDK 10.0.401 and Coredoc scip-dotnet
`0.2.15-coredoc.1`. See the [reproduction instructions](../README.md).

Uses Quartz.Extensions.DependencyInjection 3.13.1, Polly.Core 8.6.4 and AutoMapper 15.0.1. Tests cover typed Quartz registration, registered SignalR methods and ordinary Polly/AutoMapper calls. Unknown schedules and unregistered implementations do not become fabricated entrypoints.
