const std = @import("std");

pub fn fetchItems(a: std.mem.Allocator) !void {
    // Annotated receiver — the form both real fixtures use.
    var c: std.http.Client = .{ .allocator = a };
    _ = try c.fetch(.{ .location = .{ .url = "https://api.example.com/v1/items" } });
    // Host-only: no route to join on, so no edge.
    _ = try c.fetch(.{ .location = .{ .url = "https://api.example.com" } });
}

pub fn postThing(a: std.mem.Allocator, url: []const u8) !void {
    // Initializer-typed receiver, and the `open(.VERB, Uri, …)` call shape.
    const c2 = std.http.Client{ .allocator = a };
    _ = try c2.open(.POST, try std.Uri.parse("https://h/x"), .{});
    // Non-literal URL: unreadable at extraction, so no edge.
    _ = try c2.fetch(.{ .location = .{ .url = url } });
}
