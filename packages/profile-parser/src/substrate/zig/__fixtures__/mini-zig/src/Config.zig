const std = @import("std");

/// Where the artifact is written.
path: []const u8,
retries: u32 = 3,

const Self = @This();

/// Build a config with defaults.
/// The second doc line.
pub fn init(path: []const u8) Self {
    return .{ .path = path, .retries = 3 };
}

pub fn retryLimit(self: Self) u32 {
    return self.retries;
}

fn reset(self: *Self) void {
    self.retries = 0;
}

pub const Inner = struct {
    depth: u8,

    pub fn deeper(self: Inner) u8 {
        return self.depth + 1;
    }
};
