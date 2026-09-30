const std = @import("std");
const hub = @import("hub");
const util = @import("util.zig");
const missing = @import("missing.zig");
const outside = @import("../outside.zig");
const Client = @import("net/Client.zig");
const Aliased = @import("util.zig").Outer;
const Inner = @import("util.zig").Outer.Inner;

pub fn main() void {
    hub.Client.init();
    hub.util.f();
    util.g();
    Client.init();
    Inner.m();
    std.debug.print("x", .{});
}
