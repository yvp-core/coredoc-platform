pub const Ignored = struct {
    x: u8,

    pub fn get(self: Ignored) u8 {
        return self.x;
    }
};
