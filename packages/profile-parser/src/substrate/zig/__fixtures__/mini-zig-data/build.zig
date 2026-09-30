const std = @import("std");

pub fn build(b: *std.Build) void {
    // The zeegrep shape: a `const`-bound module handed to `addExecutable`.
    const m = b.createModule(.{ .root_source_file = b.path("src/main.zig") });
    _ = b.addExecutable(.{ .name = "tool", .root_module = m });

    // The browser shape: the literals live at the helper's call site.
    addExe(b, "second-tool", "src/second.zig");
}

fn addExe(b: *std.Build, name: []const u8, root: []const u8) void {
    _ = b.addExecutable(.{
        .name = name,
        .root_module = b.createModule(.{ .root_source_file = b.path(root) }),
    });
}
