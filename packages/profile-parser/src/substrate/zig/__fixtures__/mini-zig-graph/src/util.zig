const std = @import("std");
const c = @cImport({
    @cInclude("h.h");
});
const BLOB = @embedFile("blob.txt");

pub const Outer = struct {
    pub const Inner = struct {
        pub fn m() void {}
    };
    // Same method name one level up: a selector that loses its tail resolves HERE by mistake.
    pub fn m() void {}
};

pub fn f() void {
    Outer.Inner.m();
    std.debug.print("hi\n", .{});
}

pub fn g() void {
    f();
}

pub fn h() void {
    var p = Outer.Inner;
    p.run();
}

test "a test block is never a caller" {
    g();
}
