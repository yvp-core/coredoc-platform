// No `build.zig` executable claims this file: its command is the basename (BR-13).
pub fn main() void {}

// `pub fn maintenance` only starts with `main` — not an entrypoint, and not a `cli` signal.
pub fn maintenance() void {}

const Nested = struct {
    // A `main` inside a container is not the program entry: not top-level, and not `pub`.
    fn main() void {}
};
