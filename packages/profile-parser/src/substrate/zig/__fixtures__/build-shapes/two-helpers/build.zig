const std = @import("std");

// Two helpers, each with its OWN `const root` — a flat const table gives both exes the first.
pub fn build(b: *std.Build) void {
    addFirst(b);
    addSecond(b);
}

fn addFirst(b: *std.Build) void {
    const root = b.path("src/first.zig");
    _ = b.addExecutable(.{ .name = "first", .root_module = b.createModule(.{ .root_source_file = root }) });
}

fn addSecond(b: *std.Build) void {
    const root = b.path("src/second.zig");
    _ = b.addExecutable(.{ .name = "second", .root_module = b.createModule(.{ .root_source_file = root }) });
}
