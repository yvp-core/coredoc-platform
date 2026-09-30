// =============================================================================
// ZigProfile — declarative per-repo config for the Zig substrate.
//
// The Zig substrate extracts files, one root package, container types
// (struct / enum / union / opaque), functions, `@import` edges, calls, `cli` entrypoints,
// `std.http.Client` egress, raw-SQL entities/operations, variables and type aliases —
// all from conventions the language itself fixes. Nothing about that extraction is
// tunable per repo, so this profile carries NO knobs beyond the file scope: the
// `'zig'` literal is the registry dispatch discriminant and `include`/`exclude`
// are the target's ownership globs. Knobs get added when a rule needs them, not
// in advance (YAGNI).
// =============================================================================
import type { BaseProfile } from './profile-base.js';

export interface ZigProfile extends BaseProfile {
  parserId: string;
  substrate: {
    language: 'zig';
    include?: string[];
    exclude?: string[];
    /**
     * Built-in default excludes SHIP in code (`build.zig`, `zig-out/`, `.zig-cache/`,
     * `zig-cache/`); the profile's `exclude` EXTENDS them. Set `excludeDefaults: false` to opt
     * out of the built-ins entirely. Default: true. (`build.zig` is a build script, not a
     * source file — it is still read by the build-map lane, just never parsed as repo source.)
     */
    excludeDefaults?: boolean;
  };
  dbOperations?: {
    /**
     * Extra methods whose string argument is EXECUTED as SQL (a repo-owned wrapper's
     * `runSql`). UNION with the generic verb set (`exec`, `query`, `prepare`, …), never a
     * replacement: a profile must not be able to switch the defaults off and shrink the lane.
     */
    methods?: string[];
  };
}
