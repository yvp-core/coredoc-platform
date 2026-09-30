# C# profile vocabulary

Use a type-only `CSharpProfile` import from `@coredoc/profile-parser`. In a
`MultiTargetProfile`, omit `parserId` from this target and add a unique `name`.
All C# projects share one target. TS/JS source needs its own language target.

The default C# analysis attempts an already-installed compiler indexer and falls
back to tree-sitter/lexical analysis with a warning. Do not install tools or make
the profile depend on a local SDK path. `substrate.analysis: { mode: 'basic' }`
selects basic explicitly; `{ mode: 'enhanced', fallback: false }` requires the
compiler tier. Keep the chosen policy consistent when scoring and parsing.

In Desktop, use the app-provided score tool. Its native analysis dialog owns the
mode choice, build consent, prerequisite checks and indexer installation. Leave
`substrate.analysis` unset unless the user explicitly requests a fixed policy.
An authoring question cannot install or enable tools: never offer that as an
answer option or ask the user for analyzer internals to repair a missing capability.

```ts
import type { CSharpProfile } from '@coredoc/profile-parser';
const profile: CSharpProfile = {
  parserId: 'example/service',
  substrate: { language: 'csharp', include: ['**/*.cs'], exclude: ['**/Tests/**'] },
  libraries: [{
    projectSdk: 'Microsoft.NET.Sdk.Web',
    types: ['Microsoft.AspNetCore.Mvc.ControllerBase',
      'Microsoft.AspNetCore.Mvc.RouteAttribute', 'Microsoft.AspNetCore.Mvc.HttpGetAttribute'],
  }],
  nominal: { controllers: [{
    baseTypes: ['Microsoft.AspNetCore.Mvc.ControllerBase'],
    routeAttributes: ['Microsoft.AspNetCore.Mvc.RouteAttribute'],
    verbAttributes: { 'Microsoft.AspNetCore.Mvc.HttpGetAttribute': 'GET' },
    controllerSuffix: 'Controller',
  }] },
};
export default profile;
```

`substrate.projects` optionally selects one relative solution path or a list of
relative `.csproj` paths. Otherwise source-owning projects are selected.
`substrate.defines` supplies conditional symbols to syntax extraction; mismatches
with compiler declarations surface as errors. `bin`, `obj`, `*.g.cs` and
`*.generated.cs` are excluded by default. Record deliberate test/migration exclusions.

Each `libraries` row has `types: string[]` and `dependency` (exact PackageReference
or FrameworkReference name) or `projectSdk` (exact project SDK). Qualified type identities include generic
arity, for example `Microsoft.EntityFrameworkCore.DbSet` followed by a backtick and
`1`. Names are established through source usings/aliases and the current project's
declared dependency. Basic analysis recognizes the base .NET SDK implicit usings when
`ImplicitUsings` and a modern .NET target framework are explicit, unconditional project
properties; explicit `Using Remove` entries suppress those imports. Do not assume transitive
package declarations, imported/conditional MSBuild properties, or additional SDK-specific
global usings are recovered. `members` can declare library return types:
`{ [qualifiedType]: { methods?: { [method]: qualifiedReturnType }, properties?: { [property]: qualifiedType } } }`.
These are reviewed type facts, not permission to invent missing receiver types.
Compiler receiver facts take precedence over lexical inference, including types
obtained through awaited generic factories. Conflicting or unknown compiler facts
do not fall back to a guessed type.

All `nominal` sections below are optional arrays. Supply only rules grounded in source:

| Section | Fields and supported form |
|---|---|
| `controllers` | `baseTypes`, `routeAttributes`, `verbAttributes` (attribute→HTTP verb), optional `ignoreAttributes`, `controllerSuffix`. Combines inherited/controller and method routes; unknown templates abstain. |
| `httpCalls` | `receiverTypes`, `verbs` (method→verb), `pathArg`, `handlerArg`; optional `groups: { receiverTypes, methods }`, where group method values are prefix argument indices. Constant chains and unreassigned locals compose paths. |
| `registrations` | `receiverTypes`, `methods`, `typeArgument`, optional `baseTypes`, `handlers`, `excludeHandlers`; `kind: 'event'` with `eventName`, or `kind: 'websocket'` with `pathArg`. Requires a source type and concrete handler. Schedule unknowns use an event, never a made-up cron value. |
| `bindings` | `receiverTypes`, `methods`, `serviceTypeArgument`, `implementationTypeArgument`. A unique explicit binding plus compiler method-implementation evidence permits constructor DI inference. Conflicts/factories retain interface targets. |
| `models` | `contextTypes`, `setTypes`, `orm`, `tableAttributes`, `operations` (method→create/read/update/delete/query); optional `columnAttributes`, `keyAttributes`, `ignoreAttributes`, `chainMethods`, `setMethods`, `fluent`. Models require registration and an explicit known table. A DTO with only a table attribute is insufficient. |
| `externalCalls` | `receiverTypes`, `serviceName`, optional `sdkName`, `baseAddress`, `factory`; either `via: 'methods', methods: { [method]: { verb?, pathArg? } }`, or `via: 'attributes', verbAttributes, pathArg`. An attribute rule uses the compiler-resolved interface method. `factory` is `{ receiverTypes, methods, nameArg, name }` for a specific named client. A base address is a reviewed profile constant; it is not automatically extracted from DI configuration. Unknown URLs remain unknown. |

Model `fluent` has `builderTypes`, `entityBuilderTypes`, optional
`entityCallbackArg`, and `methods` mapping names to these roles:
`entity`, `table`, `property`, `column`, `columnType`, `key`, `ignore`,
`reference`, `collection`, `inverseReference`, `inverseCollection`, `foreignKey`.
The entity is generic argument 0; table/schema are arguments 0/1; property/key/
navigation/foreign-key selectors are argument 0, a string or direct parameter-member
lambda. Callback parameter 0 is bound to the registered model. Only proven builder
chains participate. Conflicting/dynamic table mappings abstain; unresolved mappings,
generic configuration helpers, inherited generic contexts and composite keys need
explicit gap reporting. `setMethods` binds generic argument 0 on a known context.
Inherited instance properties participate in models; derived properties override
same-name base properties, and static members are excluded. `SaveChanges` alone
does not imply writes to every entity.

Only actual I/O belongs in operation rules. `DbContext.Set<T>()` acquires a set;
`Where`/a query-building wrapper constructs a query without reading the database.
Keep these in `setMethods`/`chainMethods`, not `operations`. Likewise,
`IHttpClientFactory.CreateClient` constructs a client without sending a request:
use it as `factory` metadata, never as an `externalCalls` operation. Do not add
setup calls to improve a coverage score; report the unresolved receiver limitation.

Do not claim coverage from package presence. Compile a supported positive form and
check same-name, unregistered, ambiguous and dynamic counterexamples. Compiler
indices have known namespace-collision limits; ambiguous symbol definitions abstain.
The C# grammar can reject valid interpolated strings with escaped braces. Such extraction errors
are not a passing score, and source must not be rewritten to hide them.
