// Call-graph eval: ts-morph TypeChecker ground truth vs a coredoc parsed-repo JSON.
//
//   node eval.cjs <snapshotRoot> <parsed.json> <out.json>
//
// Ground truth = every CallExpression in the parsed files whose callee symbol resolves
// (through import aliases) to an in-repo, in-scope function-like declaration that has a
// coredoc function/method node. Interface/abstract callees expand to their implementations.
// A site is keyed `file:line:calleeId`; parser calls are keyed the same way.
// ts-morph is loaded from $TSMORPH (a path) so this dir needs no node_modules.
const fs = require('node:fs');
const path = require('node:path');
const { Project, Node, SyntaxKind, ts } = require(process.env.TSMORPH ?? 'ts-morph');

const [root, parsedPath, outPath] = process.argv.slice(2).map((p) => path.resolve(p));
const parsed = JSON.parse(fs.readFileSync(parsedPath, 'utf8'));
const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');

// ── coredoc side ────────────────────────────────────────────────────────────
const scoped = new Set(parsed.files.map((f) => f.path));
const nodesByFile = new Map(); // file → [{id,name,start,end}]
for (const n of parsed.functions) {
  const file = n.location?.filePath;
  if (!file) continue;
  if (!nodesByFile.has(file)) nodesByFile.set(file, []);
  nodesByFile.get(file).push({ id: n.id, name: n.name, start: n.location.startLine, end: n.location.endLine });
}

/** Map a TS function-like declaration (file, name, line span) to a coredoc node id. */
function mapDecl(file, name, start, nameLine, end) {
  const cands = (nodesByFile.get(file) ?? []).filter((n) => n.name === name);
  if (cands.length === 0) return undefined;
  const near = cands.filter((n) => n.start >= start - 2 && n.start <= Math.max(nameLine, start) + 2);
  if (near.length) return near.sort((a, b) => Math.abs(a.start - nameLine) - Math.abs(b.start - nameLine))[0].id;
  const overlap = cands.filter((n) => n.start <= end && n.end >= start);
  if (overlap.length === 1) return overlap[0].id;
  // The only same-named node in the file sits elsewhere: two declarations share one `file:name` id.
  if (cands.length === 1) collidedIds.add(cands[0].id);
  return cands.length === 1 ? cands[0].id : undefined;
}
const collidedIds = new Set();

// ── units: one ts-morph Project per apps/* | packages/* | root ──────────────
function unitOf(file) {
  const m = /^(apps|packages)\/[^/]+/.exec(file);
  return m ? m[0] : '.';
}

// Monorepo workspace packages: map `@scope/pkg[/sub]` to src instead of dist .d.ts.
function workspacePaths() {
  const paths = {};
  for (const dir of ['packages', 'apps']) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const pj = path.join(base, d, 'package.json');
      if (!fs.existsSync(pj)) continue;
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const exp = typeof pkg.exports === 'object' ? pkg.exports : { '.': { types: pkg.types ?? pkg.main } };
      for (const [k, v] of Object.entries(exp)) {
        const t = typeof v === 'string' ? v : (v?.types ?? v?.import ?? v?.default);
        if (typeof t !== 'string') continue;
        const src = t.replace(/^\.\/?dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '');
        const abs = ['.ts', '.tsx', '/index.ts'].map((e) => path.join(base, d, src + e)).find(fs.existsSync);
        if (abs) paths[k === '.' ? pkg.name : `${pkg.name}/${k.replace(/^\.\//, '')}`] = [abs];
      }
    }
  }
  return paths;
}

function unitOptions(unit, wsPaths) {
  const dir = path.join(root, unit);
  const cfgFile = ['tsconfig.json', 'jsconfig.json'].map((f) => path.join(dir, f)).find(fs.existsSync);
  let options = {};
  if (cfgFile) {
    const raw = ts.readConfigFile(cfgFile, ts.sys.readFile);
    options = ts.parseJsonConfigFileContent(raw.config ?? {}, ts.sys, dir, undefined, cfgFile).options;
  }
  const ownPaths = {};
  for (const [k, v] of Object.entries(options.paths ?? {})) {
    ownPaths[k] = v.map((p) => path.resolve(options.baseUrl ?? options.pathsBasePath ?? dir, p));
  }
  return {
    ...options,
    paths: { ...wsPaths, ...ownPaths },
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    jsx: options.jsx ?? ts.JsxEmit.ReactJSX,
    composite: false,
    incremental: false,
    declaration: false,
  };
}

// ── callee resolution ───────────────────────────────────────────────────────
const unwrap = (n) => {
  while (n && (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isSatisfiesExpression?.(n))) n = n.getExpression();
  return n;
};
const isFnExpr = (n) => n && (Node.isArrowFunction(n) || Node.isFunctionExpression(n));

const FN_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/** Function-like target of a declaration: {file,name,start,nameLine,end,kind,nested} | {iface:node} | undefined. */
function targetOf(decl) {
  const file = rel(decl.getSourceFile().getFilePath());
  const span = (nameNode, n = decl) => ({
    file,
    name: nameNode.getText(),
    start: n.getStartLineNumber(),
    nameLine: nameNode.getStartLineNumber(),
    end: n.getEndLineNumber(),
    nested: !!n.getFirstAncestor((a) => FN_KINDS.has(a.getKind())),
  });
  if (Node.isFunctionDeclaration(decl) && decl.getNameNode()) return { ...span(decl.getNameNode()), kind: 'function' };
  if (Node.isMethodDeclaration(decl)) {
    const cls = decl.getParent();
    if (decl.isAbstract?.()) return { iface: decl };
    return { ...span(decl.getNameNode()), kind: Node.isObjectLiteralExpression(cls) ? 'object-method' : 'method' };
  }
  if (Node.isMethodSignature(decl) || (Node.isPropertySignature(decl) && decl.getTypeNode()?.getKind() === SyntaxKind.FunctionType)) return { iface: decl };
  if (Node.isVariableDeclaration(decl) && isFnExpr(unwrap(decl.getInitializer())) && Node.isIdentifier(decl.getNameNode())) return { ...span(decl.getNameNode()), kind: 'const-fn' };
  if (Node.isPropertyDeclaration(decl) && isFnExpr(unwrap(decl.getInitializer()))) return { ...span(decl.getNameNode()), kind: 'class-prop-fn' };
  if (Node.isPropertyAssignment(decl) && isFnExpr(unwrap(decl.getInitializer()))) return { ...span(decl.getNameNode()), kind: 'object-prop-fn' };
  if (Node.isBinaryExpression(decl) && isFnExpr(unwrap(decl.getRight()))) {
    const left = decl.getLeft();
    if (Node.isPropertyAccessExpression(left)) return { ...span(left.getNameNode()), kind: 'exports-assign' };
  }
  if (Node.isPropertyAccessExpression(decl) && Node.isBinaryExpression(decl.getParent()) && isFnExpr(unwrap(decl.getParent().getRight()))) {
    return { ...span(decl.getNameNode(), decl.getParent()), kind: 'exports-assign' };
  }
  if (isFnExpr(decl)) return undefined;
  return undefined;
}

function resolveSymbol(sym) {
  if (!sym) return undefined;
  for (let i = 0; i < 5 && sym.isAlias?.(); i++) {
    const next = sym.getAliasedSymbol?.() ?? sym.getImmediatelyAliasedSymbol?.();
    if (!next || next === sym) break;
    sym = next;
  }
  return sym;
}

// Follow `const x = require('./y').z` / shorthand `{ foo }` / `module.exports = foo` hops.
function declsOf(sym, depth = 0) {
  sym = resolveSymbol(sym);
  if (!sym || depth > 4) return [];
  const out = [];
  for (const d of sym.getDeclarations()) {
    if (Node.isShorthandPropertyAssignment(d)) {
      out.push(...declsOf(checker.getShorthandAssignmentValueSymbol(d), depth + 1));
      continue;
    }
    if (Node.isPropertyAssignment(d) && Node.isIdentifier(unwrap(d.getInitializer()))) {
      out.push(...declsOf(unwrap(d.getInitializer()).getSymbol(), depth + 1));
      continue;
    }
    if (Node.isVariableDeclaration(d) && Node.isIdentifier(unwrap(d.getInitializer()) ?? undefined)) {
      out.push(...declsOf(unwrap(d.getInitializer()).getSymbol(), depth + 1));
      continue;
    }
    // `const { a } = await import('./m')` / `const { a } = obj`: follow the property of the initializer's type.
    if (Node.isBindingElement(d) && Node.isObjectBindingPattern(d.getParent())) {
      const init = d.getParent().getParent().getInitializer?.();
      const prop = d.getPropertyNameNode()?.getText() ?? d.getName();
      const psym = init?.getType().getProperty(prop);
      if (psym) {
        out.push(...declsOf(psym, depth + 1));
        continue;
      }
    }
    out.push(d);
  }
  return out;
}

function shapeOf(call, expr) {
  if (Node.isIdentifier(expr)) return 'ident';
  if (Node.isPropertyAccessExpression(expr)) {
    const obj = unwrap(expr.getExpression());
    if (obj.getKind() === SyntaxKind.ThisKeyword) return 'this.m';
    if (obj.getKind() === SyntaxKind.SuperKeyword) return 'super.m';
    if (Node.isPropertyAccessExpression(obj) && unwrap(obj.getExpression()).getKind() === SyntaxKind.ThisKeyword) return 'this.field.m';
    if (Node.isIdentifier(obj)) {
      const s = obj.getSymbol();
      const d = s?.getDeclarations()?.[0];
      if (d && (Node.isNamespaceImport(d) || Node.isImportClause(d) || Node.isImportSpecifier(d))) return 'import.m';
      if (d && Node.isVariableDeclaration(d) && /\brequire\s*\(/.test(d.getInitializer()?.getText() ?? '')) return 'require.m';
      if (d && Node.isClassDeclaration(d)) return 'Class.static';
      if (d && Node.isParameterDeclaration(d)) return 'param.m';
      return 'local.m';
    }
    return 'chain.m';
  }
  if (Node.isElementAccessExpression(expr)) return 'element';
  return 'other';
}

// ── main ────────────────────────────────────────────────────────────────────
const wsPaths = workspacePaths();
const units = new Map();
let checker;
for (const f of scoped) {
  if (!/\.(m|c)?[jt]sx?$/.test(f)) continue;
  const u = unitOf(f);
  if (!units.has(u)) units.set(u, []);
  units.get(u).push(f);
}

const gt = new Map(); // primaryKey → {file,line,callee,shape,calleeKind,crossFile,crossUnit,dispatch,expr}
const altToPrimary = new Map();
const gtSiteByLoc = new Map(); // file:line → [primaryKey]
const accessorKeys = new Set();
const refKeys = new Set();
const fnNames = new Set(parsed.functions.map((n) => n.name));
const counts = { callExprs: 0, unresolvedSymbol: 0, external: 0, outOfScope: 0, nodeGap: 0, noFnTarget: 0, gtSites: 0 };
const nodeGapByKind = {};
const nodeGapSamples = [];
const unresolvedSamples = [];
const t0 = Date.now();

for (const [unit, files] of units) {
  const project = new Project({ compilerOptions: unitOptions(unit, wsPaths), skipAddingFilesFromTsConfig: true });
  for (const f of files) project.addSourceFileAtPathIfExists(path.join(root, f));
  const ls = project.getLanguageService();
  checker = project.getTypeChecker();
  for (const f of files) {
    const sf = project.getSourceFile(path.join(root, f));
    if (!sf) continue;
    // Getter reads: the parser emits these as call edges by design; tracked so they are not scored as errors.
    for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const d = pa.getNameNode().getSymbol()?.getDeclarations()?.[0];
      if (!d || !Node.isGetAccessorDeclaration(d)) continue;
      const file = rel(d.getSourceFile().getFilePath());
      const id = mapDecl(file, d.getName(), d.getStartLineNumber(), d.getNameNode().getStartLineNumber(), d.getEndLineNumber());
      if (id) for (const l of [pa.getStartLineNumber(), pa.getNameNode().getStartLineNumber()]) accessorKeys.add(`${f}:${l}:${id}`);
    }
    // Function references passed as values (`xs.map(fn)`, `{ handler: fn }`): the parser emits
    // reference edges for these; tracked so they are not scored as errors.
    for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!fnNames.has(id.getText())) continue;
      const p = id.getParent();
      if (Node.isCallExpression(p) && p.getExpression() === id) continue;
      if (Node.isPropertyAccessExpression(p) && p.getNameNode() === id && Node.isCallExpression(p.getParent()) && p.getParent().getExpression() === p) continue;
      for (const d of declsOf(id.getSymbol())) {
        if (d.getNameNode?.() === id) continue;
        const t = targetOf(d);
        const target = t?.iface ? undefined : t;
        const rid = target && mapDecl(target.file, target.name, target.start, target.nameLine, target.end);
        if (rid) refKeys.add(`${f}:${id.getStartLineNumber()}:${rid}`);
      }
    }
    const callsPerLine = new Map();
    for (const c of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) callsPerLine.set(c.getStartLineNumber(), (callsPerLine.get(c.getStartLineNumber()) ?? 0) + 1);
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = unwrap(call.getExpression());
      if (expr.getKind() === SyntaxKind.SuperKeyword || expr.getKind() === SyntaxKind.ImportKeyword) continue;
      counts.callExprs++;
      const nameNode = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
      const decls = declsOf(nameNode.getSymbol());
      if (decls.length === 0) {
        counts.unresolvedSymbol++;
        if (unresolvedSamples.length < 30) unresolvedSamples.push(`${f}:${call.getStartLineNumber()}  ${expr.getText().replace(/\s+/g, ' ').slice(0, 60)}`);
        continue;
      }
      let dispatch = false;
      const targets = [];
      for (const d of decls) {
        const t = targetOf(d);
        if (!t?.iface) {
          if (t) targets.push(t);
          continue;
        }
        // Dispatch through an in-repo interface/abstract member only; lib interfaces (Set.add…) are external.
        const isf = t.iface.getSourceFile();
        if (isf.isInNodeModules() || isf.isDeclarationFile()) continue;
        dispatch = true;
        // An abstract method may itself be a graph node; an edge to it is an acceptable answer too.
        targets.push({
          file: rel(isf.getFilePath()),
          name: t.iface.getName(),
          start: t.iface.getStartLineNumber(),
          nameLine: t.iface.getNameNode().getStartLineNumber(),
          end: t.iface.getEndLineNumber(),
          kind: 'abstract-decl',
        });
        try {
          for (const impl of ls.getImplementations(t.iface.getNameNode?.() ?? t.iface)) {
            const n = impl.getNode();
            const it = targetOf(n) ?? targetOf(n.getParent());
            if (it && !it.iface) targets.push(it);
          }
        } catch {}
      }
      if (targets.length === 0) {
        const anyLocal = decls.some((d) => !d.getSourceFile().isInNodeModules() && !d.getSourceFile().isDeclarationFile());
        if (anyLocal) counts.noFnTarget++;
        else counts.external++;
        continue;
      }
      const line = call.getStartLineNumber();
      const lines = new Set([line, nameNode.getStartLineNumber(), expr.getEndLineNumber()]);
      // One GT site per call; it accepts any of its resolved targets (overloads, implementations).
      const accept = new Map(); // id → target
      for (const t of targets) {
        if (t.file.startsWith('..') || t.file.includes('node_modules/')) continue;
        if (!scoped.has(t.file)) {
          counts.outOfScope++;
          continue;
        }
        const id = mapDecl(t.file, t.name, t.start, t.nameLine, t.end);
        if (!id && t.kind === 'abstract-decl') continue;
        if (!id) {
          counts.nodeGap++;
          nodeGapByKind[t.kind] = (nodeGapByKind[t.kind] ?? 0) + 1;
          if (nodeGapSamples.length < 40) nodeGapSamples.push(`${t.kind} ${t.file}:${t.nameLine} ${t.name}  ← ${f}:${line}`);
          continue;
        }
        accept.set(id, t);
      }
      if (accept.size === 0) {
        counts.external++;
        continue;
      }
      const ids = [...accept.keys()].sort();
      const key = `${f}:${line}:${ids.join('|')}`;
      if (gt.has(key)) continue;
      const t = [...accept.values()].find((x) => x.kind !== 'abstract-decl') ?? accept.get(ids[0]);
      gt.set(key, {
        file: f,
        line,
        callee: ids.map((i) => i.split(':').slice(2).join(':')).join(' | '),
        ids,
        shape: shapeOf(call, expr),
        calleeKind: t.kind,
        crossFile: t.file !== f,
        crossUnit: unitOf(t.file) !== unitOf(f),
        dispatch: dispatch && ids.length > 0,
        inFunction: (nodesByFile.get(f) ?? []).some((n) => n.start <= line && n.end >= line),
        nested: [...accept.values()].some((x) => x.nested),
        multiCallLine: callsPerLine.get(line) > 1,
        aliasedImport: Node.isIdentifier(expr) && expr.getText() !== t.name,
        typeArgs: call.getTypeArguments().length > 0,
        expr: expr.getText().replace(/\s+/g, ' ').slice(0, 80),
      });
      for (const id of ids) {
        for (const l of lines) {
          altToPrimary.set(`${f}:${l}:${id}`, key);
          const lk = `${f}:${l}`;
          if (!gtSiteByLoc.has(lk)) gtSiteByLoc.set(lk, []);
          gtSiteByLoc.get(lk).push(key);
        }
      }
    }
  }
  process.stderr.write(`unit ${unit}: ${files.length} files, gt=${gt.size}, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
counts.gtSites = gt.size;

// ── compare ─────────────────────────────────────────────────────────────────
const parserResolved = new Map(); // normalized key → call
const parserUnresolvedLoc = new Set();
const parserResolvedLoc = new Map(); // file:line → [calleeId]
for (const c of parsed.calls) {
  const file = c.location?.filePath;
  if (!file) continue;
  const lk = `${file}:${c.location.startLine}`;
  if (!c.calleeId) {
    parserUnresolvedLoc.add(lk);
    continue;
  }
  const raw = `${lk}:${c.calleeId}`;
  parserResolved.set(altToPrimary.get(raw) ?? raw, c);
  if (!parserResolvedLoc.has(lk)) parserResolvedLoc.set(lk, []);
  parserResolvedLoc.get(lk).push(c.calleeId);
}

const bump = (o, k, f) => {
  o[k] ??= { gt: 0, tp: 0, fn: 0 };
  o[k][f]++;
};
const byShape = {};
const byCalleeKind = {};
const byScope = {};
const byCaller = {};
const byFileKind = {};
const byLineDensity = {};
const byCallForm = {};
const missReason = {};
const missSamples = {};
const missBucket = {};
const perCallee = {};
const bucketSamples = {};
// Files where the parser resolved at least one call through SCIP: a miss elsewhere suggests no compiler coverage.
const scipFiles = new Set(parsed.calls.filter((c) => c.provenance === 'scip').map((c) => c.location?.filePath));
const bucketOf = (g) =>
  !g.inFunction
    ? 'module-scope call (no caller node)'
    : g.ids.some((id) => collidedIds.has(id))
      ? 'callee id collides (same name twice in file)'
    : g.dispatch
      ? 'dispatch via interface/abstract'
      : g.calleeKind === 'object-prop-fn' || g.calleeKind === 'object-method'
        ? 'callee is object-literal function'
        : !scipFiles.has(g.file)
          ? 'file has no SCIP-resolved calls'
          : g.calleeKind === 'const-fn'
            ? g.nested ? 'callee is nested arrow const' : 'callee is top-level arrow const'
            : g.nested
              ? 'callee is nested function'
              : 'other';
let tp = 0;
for (const [key, g] of gt) {
  const scope = g.crossUnit ? 'cross-package' : g.crossFile ? 'cross-file' : 'same-file';
  const dims = [
    [byShape, g.dispatch ? `${g.shape} (dispatch)` : g.shape],
    [byCalleeKind, g.calleeKind],
    [byScope, scope],
    [byCaller, g.inFunction ? "in-function" : "module-scope"],
    [byLineDensity, g.multiCallLine ? 'line has several calls' : 'single call on line'],
    [byCallForm, g.aliasedImport ? 'aliased import' : g.typeArgs ? 'explicit type args' : 'plain'],
    [byFileKind, /(\.(test|spec)\.[cm]?[jt]sx?$)|__tests__|\/e2e\/|\/test\//.test(g.file) ? 'test' : 'prod'],
  ];
  for (const [o, k] of dims) bump(o, k, 'gt');
  const pc = (perCallee[g.callee] ??= { gt: 0, tp: 0, kind: g.calleeKind, nested: g.nested });
  pc.gt++;
  if (parserResolved.has(key)) {
    pc.tp++;
    tp++;
    for (const [o, k] of dims) bump(o, k, 'tp');
    continue;
  }
  for (const [o, k] of dims) bump(o, k, 'fn');
  const lk = `${g.file}:${g.line}`;
  const reason = parserResolvedLoc.has(lk)
    ? 'parser resolved a different callee'
    : parserUnresolvedLoc.has(lk)
      ? 'parser saw the call, left it unresolved'
      : 'parser has no call record at this line';
  missReason[reason] = (missReason[reason] ?? 0) + 1;
  const bucket = bucketOf(g);
  missBucket[bucket] = (missBucket[bucket] ?? 0) + 1;
  (bucketSamples[bucket] ??= []).length < (bucket === 'other' ? 60 : 8) && bucketSamples[bucket].push(`${lk}  ${g.expr}  → ${g.callee}  [${reason}]`);
  const sk = `${reason} | ${g.shape}`;
  (missSamples[sk] ??= []).length < 6 && missSamples[sk].push(`${lk}  ${g.expr}  → ${g.callee}`);
}

// False positives: parser edges the checker does not produce.
const fpReason = {};
const fpSamples = {};
let fp = 0;
let accessorEdges = 0;
let referenceEdges = 0;
for (const [key, c] of parserResolved) {
  if (gt.has(key)) continue;
  if (accessorKeys.has(key)) {
    accessorEdges++;
    continue;
  }
  if (refKeys.has(key)) {
    referenceEdges++;
    continue;
  }
  fp++;
  const lk = `${c.location.filePath}:${c.location.startLine}`;
  const atLoc = gtSiteByLoc.get(lk);
  const reason = atLoc?.length ? 'checker resolves this site to a different callee' : 'checker has no in-scope callee at this line';
  const k = `${reason} | ${c.provenance ?? '?'}`;
  fpReason[k] = (fpReason[k] ?? 0) + 1;
  (fpSamples[k] ??= []).length < 6 &&
    fpSamples[k].push(`${lk}  ${String(c.calleeExpression).replace(/\s+/g, ' ').slice(0, 70)}  → ${c.calleeId.split(':').slice(2).join(':')}${atLoc?.length ? `   (checker: ${atLoc.map((p) => gt.get(p).callee).join(', ')})` : ''}`);
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const table = (o) =>
  Object.fromEntries(
    Object.entries(o)
      .sort((a, b) => b[1].gt - a[1].gt)
      .map(([k, v]) => [k, { ...v, recall: pct(v.tp, v.gt) }]),
  );
const result = {
  repo: parsed.name,
  commit: parsed.git?.commitShortHash,
  parsedAt: parsed.parsedAt,
  seconds: Math.round((Date.now() - t0) / 1000),
  counts,
  parser: { calls: parsed.calls.length, resolved: parserResolved.size, unresolvedRecords: parsed.calls.filter((c) => !c.calleeId).length },
  headline: {
    gt: gt.size,
    parserResolved: parserResolved.size,
    tp,
    fn: gt.size - tp,
    fp,
    accessorEdges,
    referenceEdges,
    recall: pct(tp, gt.size),
    precision: pct(tp, tp + fp),
  },
  byScope: table(byScope),
  byCaller: table(byCaller),
  byFileKind: table(byFileKind),
  byLineDensity: table(byLineDensity),
  byCallForm: table(byCallForm),
  byShape: table(byShape),
  byCalleeKind: table(byCalleeKind),
  missReason,
  missBucket,
  collidedNodeIds: collidedIds.size,
  calleeCoverage: (() => {
    // Is a miss tied to the callee (every call to it missed) or to the call site (some calls hit)?
    const out = { calleesAllMissed: 0, sitesAllMissed: 0, calleesPartial: 0, sitesMissedPartial: 0, calleesAllHit: 0, allMissedSamples: [] };
    for (const [id, v] of Object.entries(perCallee)) {
      if (v.tp === 0) {
        out.calleesAllMissed++;
        out.sitesAllMissed += v.gt;
        if (v.gt >= 3 && out.allMissedSamples.length < 25) out.allMissedSamples.push(`${v.gt}x ${v.kind}${v.nested ? ' nested' : ''} ${id}`);
      } else if (v.tp < v.gt) {
        out.calleesPartial++;
        out.sitesMissedPartial += v.gt - v.tp;
      } else out.calleesAllHit++;
    }
    return out;
  })(),
  bucketSamples,
  fpReason,
  nodeGapByKind,
  nodeGapSamples,
  unresolvedSamples,
  missSamples,
  fpSamples,
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ repo: result.repo, headline: result.headline, byScope: result.byScope, missReason, counts }, null, 2));
