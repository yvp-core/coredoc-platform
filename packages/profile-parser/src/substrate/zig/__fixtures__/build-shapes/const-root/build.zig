const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const flags_dep = b.dependency("flags", .{});

    const tool_module = b.createModule(.{
        .root_source_file = b.path("src/entry.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "flags", .module = flags_dep.module("flags") },
        },
    });

    const tool = b.addExecutable(.{
        .name = "widget",
        .root_module = tool_module,
    });
    b.installArtifact(tool);

    const helpers = b.addModule("helpers", .{
        .root_source_file = b.path("./src/helpers.zig"),
        .target = target,
    });
    tool_module.addImport("helpers", helpers);
}
