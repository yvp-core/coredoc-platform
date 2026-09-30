const Store = @import("../Store.zig");

const Self = @This();

store: *Store,
id: u32,

pub fn init() Client {
    return .{ .store = undefined, .id = 0 };
}

pub fn run(self: *Client) void {
    self.store.put();
    Self.helper();
    helper();
}

fn helper() void {}
