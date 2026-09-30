const std = @import("std");

/// Sum two numbers.
pub fn add(a: u32, b: u32) u32 {
    return a + b;
}

fn secret() void {}

const Outer = struct {
    const Inner = struct {
        fn deep() u8 {
            return 1;
        }
    };
};

pub const Level = enum(u8) {
    low = 1,
    high,

    pub fn label(self: Level) []const u8 {
        return @tagName(self);
    }
};

pub const Plain = enum { first, second };

pub const Payload = union(enum) {
    num: u32,
    text: []const u8,
};

const Bits = packed struct(u8) {
    lo: u4,
    hi: u4,
};

const Raw = extern struct {
    handle: i32,
};

pub extern fn native(handle: i32) i32;

pub export fn shim() void {}

pub fn List(comptime T: type) type {
    return struct {
        items: []T,

        pub fn append(self: *@This(), item: T) void {
            _ = self;
            _ = item;
        }
    };
}

fn make() type {
    return std.ArrayList(u8);
}

const Wrapper = struct {
    inner: struct { w: f32 },
    seed: u8 = 7,
};

const defaults = .{ .retries = 2 };

/// A container with no fields at all.
pub const Empty = struct {};

/// An enum with no members.
pub const Nothing = enum {};

/// A tuple struct: its fields are positional, not named.
pub const Pair = struct { []const u8, u32 };

const Failure = error{ Timeout, Refused };

test "adds numbers" {
    _ = add(1, 2);
}

comptime {
    _ = 1;
}
