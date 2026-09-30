const std = @import("std");
const Foo = @import("a.zig").Foo;
const Deep = @import("b.zig").Outer.Inner;
const c = @cImport({
    @cInclude("pcre2.h");
});
const blob = @embedFile("data.bin");
const Self = @This();
pub const VERSION = "1.0";
const N = 5;
var counter: u32 = 0;
pub const Error = error{ Oops };

pub const Cache = struct {
    client: std.http.Client,
    url: []const u8,

    const SCHEMA =
        \\create table cache (
        \\  url text
        \\);
    ;

    pub fn load(self: *Cache) void {
        self.client.fetch(.{ .location = .{ .url = "https://x/y" } });
        helper();
    }
};

pub fn main() void {
    var client: std.http.Client = .{};
    client.fetch(.{ .location = .{ .url = "https://x/y" }, .method = .GET });
    std.debug.print("hi", .{});
    exec("insert into cache (url) values (?1)");
    exec("select " ++ "count(*) from cache");
    @memcpy(N, N);
    helper();
}

fn helper() void {}

fn exec(sql: []const u8) void {
    _ = sql;
}

test "not a caller" {
    helper();
    exec("select 1 from cache");
}
