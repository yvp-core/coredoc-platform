pub fn keep() void {}

fn legacy() void {
    var async: u8 = 1;
    _ = async;
}

pub const Kept = struct {
    id: u32,
};
