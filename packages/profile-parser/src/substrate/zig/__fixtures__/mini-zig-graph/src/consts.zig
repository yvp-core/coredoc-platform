//! BR-16: the four shapes a `const`/`var` can take, plus the one that is only an import.

const std = @import("std");

pub const VERSION = "1.0";

var counter: u32 = 0;

pub const Error = error{ Oops };

pub const Outer = struct {
    pub const Inner = struct {
        pub fn m() void {}
    };

    const Self = @This();
};

const In = Outer.Inner;
