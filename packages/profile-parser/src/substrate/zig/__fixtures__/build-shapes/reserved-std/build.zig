const std = @import("std");

// RT1: `build.zig` is ordinary user code and may bind a module under a RESERVED name. Honouring
// it would redirect every `@import("std")` in the repo at this file.
pub fn build(b: *std.Build) void {
    _ = b.addModule("std", .{ .root_source_file = b.path("src/std_shim.zig") });
    _ = b.addModule("shim", .{ .root_source_file = b.path("src/std_shim.zig") });
}
