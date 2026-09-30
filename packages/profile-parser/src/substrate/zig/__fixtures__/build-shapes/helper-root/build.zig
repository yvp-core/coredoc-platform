const std = @import("std");
const Build = std.Build;

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const shared_module = b.addModule("shared", .{
        .root_source_file = b.path("src/shared.zig"),
        .target = target,
        .optimize = optimize,
    });

    const cfg = ExeConfig{
        .shared_module = shared_module,
        .target = target,
        .optimize = optimize,
    };

    {
        const exe = addExe(b, cfg, "widget", "widget_check", "src/main.zig");
        b.installArtifact(exe);
    }

    {
        const exe = addExe(b, cfg, "widget-worker", "worker_check", "src/main_worker.zig");
        b.installArtifact(exe);
    }
}

const ExeConfig = struct {
    shared_module: *Build.Module,
    target: Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
};

fn addExe(b: *Build, config: ExeConfig, name: []const u8, check_name: []const u8, root_source_file: []const u8) *Build.Step.Compile {
    const exe = b.addExecutable(.{
        .name = name,
        .root_module = b.createModule(.{
            .root_source_file = b.path(root_source_file),
            .target = config.target,
            .optimize = config.optimize,
            .imports = &.{
                .{ .name = "shared", .module = config.shared_module },
            },
        }),
    });
    const check = b.step(check_name, "Check the executable");
    check.dependOn(&exe.step);
    return exe;
}
