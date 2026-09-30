const std = @import("std");

const SCHEMA =
    \\create table cache (
    \\  url text not null primary key,
    \\  status integer not null
    \\)
;

const OWNER_SCHEMA =
    \\create table cache_owner (
    \\  id integer not null primary key,
    \\  owner_id integer references cache(url)
    \\)
;

// create table nope (x int)

pub fn put(conn: anytype) !void {
    try conn.exec("insert into cache (url) values (?1)");
}

pub fn get(conn: anytype) !void {
    try conn.exec("select * from cache where url = ?1");
}

pub fn count(conn: anytype) !void {
    try conn.exec("select " ++ "count(*) from cache");
    std.log.info("select something", .{});
}

// DDL that does not START the literal: the anchored verb pre-filter never sees it.
const PRAGMA_FIRST =
    \\pragma foreign_keys = on;
    \\create table pragma_first (id integer)
;

test "t" {
    _ = "create table t_test (id int)";
}

// A NON-test helper operating on a table only the `test` block above creates.
pub fn helper(conn: anytype) !void {
    try conn.exec("update t_test set x = 1");
}

pub fn unknown(conn: anytype) !void {
    try conn.exec("select * from unknown_t");
}

// The formatted-SQL idiom: the literal's immediate callee is `bufPrint`, and the DB verb sees
// only the local it bound (BR-15, one hop).
pub fn evict(conn: anytype, url: []const u8) !void {
    var buf: [128]u8 = undefined;
    const sql = try std.fmt.bufPrint(&buf, "delete from cache where url = {s}", .{url});
    try conn.exec(sql, .{});
}

// Twin: formatted but never executed — a message, not an operation.
pub fn describe(url: []const u8) !void {
    var buf: [128]u8 = undefined;
    const msg = try std.fmt.bufPrint(&buf, "delete from cache where url = {s}", .{url});
    std.log.info("{s}", .{msg});
}

// Twin: formatted, then passed through a SECOND local — beyond the one hop, so dropped (LIM-B).
pub fn evictIndirect(conn: anytype, url: []const u8) !void {
    var buf: [128]u8 = undefined;
    const sql = try std.fmt.bufPrint(&buf, "delete from cache where url = {s}", .{url});
    const stmt = sql;
    try conn.exec(stmt, .{});
}
