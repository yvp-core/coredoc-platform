/**
 * AC-10 / BR-14: `std.http.Client` egress, gated on the receiver.
 *
 * The fixture holds the two receiver forms that appear in the wild (annotated `var c:
 * std.http.Client`, initializer `std.http.Client{…}`) and the two shapes that must produce
 * NOTHING: a host-only URL (no route to join on) and a non-literal URL (unreadable). The
 * `self.<field>` receiver is exercised inline, so the fixture's `std.http.Client` count stays
 * the number the scorer's denominator expects (AC-13).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ZigFile, type ZigFileEntry, extractZigFileFacts, toZigFile } from './zig-declarations.js';
import { emitZigEgress } from './zig-egress.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'mini-zig-data');
const REL = 'src/net.zig';
const idGen = new StableIdGenerator(FIXTURE, 'mini-zig-data');

const parsed: ZigFile[] = [];
let files: ZigFileEntry[];

/** Facts for an inline source — shapes the fixture deliberately does not carry. */
async function inlineFile(source: string, relPath = 'src/inline.zig'): Promise<ZigFileEntry> {
  const file = await toZigFile(relPath, source);
  parsed.push(file);
  return { relPath, facts: extractZigFileFacts(file, idGen) };
}

beforeAll(async () => {
  const file = await toZigFile(REL, readFileSync(join(FIXTURE, REL), 'utf-8'));
  parsed.push(file);
  files = [{ relPath: REL, facts: extractZigFileFacts(file, idGen) }];
});

afterAll(() => releaseParsedTrees(parsed));

describe('emitZigEgress', () => {
  it('emits exactly one edge per literal-URL request, for both receiver forms', () => {
    const edges = emitZigEgress(files, idGen);
    const fetchCaller = idGen.functionId(REL, 'fetchItems');
    const openCaller = idGen.functionId(REL, 'postThing');
    const fetchId = idGen.externalCallId(fetchCaller, 'std.http', 'GET', `${REL}:6:/v1/items`);
    const openId = idGen.externalCallId(openCaller, 'std.http', 'POST', `${REL}:14:/x`);

    expect(edges).toEqual([
      {
        id: fetchId,
        versionedId: idGen.versionedId(
          fetchId,
          'c.fetch(.{ .location = .{ .url = "https://api.example.com/v1/items" } })',
        ),
        callerId: fetchCaller,
        // The linker's `unresolvableServices` sentinel is 'http': naming the transport here
        // would exclude every edge from the cross-repo join.
        serviceName: '',
        method: 'GET',
        targetDescriptor: {
          protocol: 'http',
          http: {
            method: 'GET',
            pathTemplate: '/v1/items',
            originalPath: 'https://api.example.com/v1/items',
          },
        },
        location: { filePath: REL, startLine: 6, endLine: 6 },
      },
      {
        id: openId,
        versionedId: idGen.versionedId(openId, 'c2.open(.POST, try std.Uri.parse("https://h/x"), .{})'),
        callerId: openCaller,
        serviceName: '',
        method: 'POST',
        targetDescriptor: {
          protocol: 'http',
          http: { method: 'POST', pathTemplate: '/x', originalPath: 'https://h/x' },
        },
        location: { filePath: REL, startLine: 14, endLine: 14 },
      },
    ]);
  });

  it('emits nothing for a host-only URL and nothing for a non-literal URL', () => {
    const edges = emitZigEgress(files, idGen);

    // Both dropped call sites ARE recorded call sites — the lane drops them, not the walk.
    expect(files[0].facts.callSites.filter((c) => c.chain?.at(-1) === 'fetch')).toHaveLength(3);
    expect(edges.map((e) => e.targetDescriptor?.http?.originalPath)).toEqual([
      'https://api.example.com/v1/items',
      'https://h/x',
    ]);
  });

  it('resolves a `self.<field>` receiver whose property is typed std.http.Client', async () => {
    const file = await inlineFile(
      'const std = @import("std");\n' +
        'const Fetcher = struct {\n' +
        '    client: std.http.Client,\n\n' +
        '    pub fn load(self: *Fetcher) !void {\n' +
        '        _ = try self.client.fetch(.{ .location = .{ .url = "https://h/api/v2/ping" }, .method = .POST });\n' +
        '    }\n' +
        '};\n',
    );

    const edges = emitZigEgress([file], idGen);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      callerId: idGen.methodId('src/inline.zig', 'Fetcher', 'load'),
      method: 'POST',
      targetDescriptor: { http: { pathTemplate: '/api/v2/ping' } },
    });
  });

  it('does not let one function’s client type a same-named receiver in another', async () => {
    const file = await inlineFile(
      'const std = @import("std");\n' +
        'fn a() void {\n' +
        '    var client: std.http.Client = .{};\n' +
        '    _ = client;\n' +
        '}\n' +
        'fn b() !void {\n' +
        '    var client = Other.init();\n' +
        '    _ = try client.fetch(.{ .location = .{ .url = "https://h/x" } });\n' +
        '}\n',
      'src/scoped.zig',
    );

    // `b`'s `client` is not a client: the only edge a file-wide key would emit is b's, and
    // `a` makes no request at all.
    expect(emitZigEgress([file], idGen)).toEqual([]);
  });

  it('folds a file-scope const URL, and a `++` chain built on one, one hop', async () => {
    const file = await inlineFile(
      'const std = @import("std");\n' +
        'const base = "https://h";\n' +
        'const api_url = "https://models.dev/api.json";\n' +
        'pub fn go(a: std.mem.Allocator) !void {\n' +
        '    var c: std.http.Client = .{ .allocator = a };\n' +
        '    _ = try c.fetch(.{ .location = .{ .url = api_url } });\n' +
        '    _ = try c.fetch(.{ .location = .{ .url = base ++ "/x" } });\n' +
        '}\n',
      'src/folded.zig',
    );

    expect(emitZigEgress([file], idGen).map((e) => e.targetDescriptor?.http?.pathTemplate)).toEqual([
      '/api.json',
      '/x',
    ]);
  });

  it('does not fold a FILE-scope const into a parameter of the same name', async () => {
    // The Codex case: `fn get(url: []const u8)` next to `const url = "https://…"` at file scope.
    // Folding the constant in publishes a route the code never requests.
    const shadowed = await inlineFile(
      'const std = @import("std");\n' +
        'const url = "https://h/file/scope";\n' +
        'pub fn get(a: std.mem.Allocator, url: []const u8) !void {\n' +
        '    var c: std.http.Client = .{ .allocator = a };\n' +
        '    _ = try c.fetch(.{ .location = .{ .url = url } });\n' +
        '}\n',
      'src/shadowed.zig',
    );
    expect(emitZigEgress([shadowed], idGen)).toEqual([]);

    // The twin: the same file-scope const, read from a function that binds nothing called `url`.
    const open = await inlineFile(
      'const std = @import("std");\n' +
        'const url = "https://h/file/scope";\n' +
        'pub fn get(a: std.mem.Allocator) !void {\n' +
        '    var c: std.http.Client = .{ .allocator = a };\n' +
        '    _ = try c.fetch(.{ .location = .{ .url = url } });\n' +
        '}\n',
      'src/unshadowed.zig',
    );
    expect(emitZigEgress([open], idGen).map((e) => e.targetDescriptor?.http?.pathTemplate)).toEqual(['/file/scope']);
  });

  it('does not type a caller-bound receiver by a FILE-scope client of the same name', async () => {
    const shadowed = await inlineFile(
      'const std = @import("std");\n' +
        'var client: std.http.Client = .{};\n' +
        'pub fn go(raw: anytype) !void {\n' +
        '    const client = raw;\n' +
        '    _ = try client.fetch(.{ .location = .{ .url = "https://h/a/b" } });\n' +
        '}\n',
      'src/shadowed-client.zig',
    );
    expect(emitZigEgress([shadowed], idGen)).toEqual([]);

    // The twin: the same file-scope client, used by a function that binds nothing called `client`.
    const open = await inlineFile(
      'const std = @import("std");\n' +
        'var client: std.http.Client = .{};\n' +
        'pub fn go() !void {\n' +
        '    _ = try client.fetch(.{ .location = .{ .url = "https://h/a/b" } });\n' +
        '}\n',
      'src/filescope-client.zig',
    );
    expect(emitZigEgress([open], idGen).map((e) => e.targetDescriptor?.http?.pathTemplate)).toEqual(['/a/b']);
  });

  it('emits nothing for an identifier bound to a parameter', async () => {
    const file = await inlineFile(
      'const std = @import("std");\n' +
        'pub fn go(a: std.mem.Allocator, u: []const u8) !void {\n' +
        '    var c: std.http.Client = .{ .allocator = a };\n' +
        '    const url = u;\n' +
        '    _ = try c.fetch(.{ .location = .{ .url = url } });\n' +
        '    _ = try c.fetch(.{ .location = .{ .url = u } });\n' +
        '}\n',
      'src/param.zig',
    );

    expect(emitZigEgress([file], idGen)).toEqual([]);
  });

  it('emits nothing for a method outside the HttpMethod union', async () => {
    // `.CONNECT` is a real HTTP verb the graph's `HttpMethod` union does not carry: casting it
    // in would put an unjoinable value in the descriptor, so the edge is dropped instead.
    const file = await inlineFile(
      'const std = @import("std");\n' +
        'pub fn go(a: std.mem.Allocator) !void {\n' +
        '    var c: std.http.Client = .{ .allocator = a };\n' +
        '    _ = try c.fetch(.{ .location = .{ .url = "https://h/a/b" }, .method = .CONNECT });\n' +
        '}\n',
      'src/connect.zig',
    );

    expect(emitZigEgress([file], idGen)).toEqual([]);
  });

  it('emits nothing for a `fetch` on a receiver that is not a client', async () => {
    const file = await inlineFile(
      'fn a(cache: anytype) !void {\n' +
        '    _ = try cache.fetch(.{ .location = .{ .url = "https://h/a/b" } });\n' +
        '}\n',
      'src/other.zig',
    );

    expect(file.facts.callSites).toHaveLength(1);
    expect(emitZigEgress([file], idGen)).toEqual([]);
  });
});
