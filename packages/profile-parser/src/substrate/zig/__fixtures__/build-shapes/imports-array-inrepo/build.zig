const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});

    const shared_module = b.createModule(.{
        .root_source_file = b.path("src/shared.zig"),
        .target = target,
    });

    const exe_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .imports = &.{
            .{ .name = "shared", .module = shared_module },
        },
    });
    _ = exe_module;
}
