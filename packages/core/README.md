# @coredoc/core

Shared types (`ParsedRepo` and related contracts), stable ID generation, workspace
utilities, product intent, and cross-repository linking for Coredoc.

This package is used by the server, MCP, graph storage, CLI, and Desktop.
Code extraction belongs to [`@coredoc/profile-parser`](../profile-parser/README.md),
which owns the Tree-sitter runtime, WASM grammars, and tree lifecycle helpers.
Depending on `core` does not install parser runtimes or grammars.

## Tests

```sh
pnpm --filter @coredoc/core test
```
