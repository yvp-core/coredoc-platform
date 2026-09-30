const std = @import("std");

pub fn build(b: *std.Build) void {
    _ = b.addModule("hub", .{
        .root_source_file = b.path("src/hub.zig"),
    });
}
