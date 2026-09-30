/** Eval-only T1 touchpoints; these are deliberately not production mapping decisions. */
export interface LineRange {
  start: number;
  end: number;
}
export interface ChangedFile {
  path: string;
  ranges: LineRange[];
  deletedLines: number;
}
export interface BaselineNode {
  id: string;
  type: string;
  startLine?: number;
  endLine?: number;
}

/** Git --no-renames --unified=0, using new-side coordinates in the graph's checkout. */
export function changedLineRanges(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      inHunk = false;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const raw = line.slice(4);
      const path: string = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
      current = path === '/dev/null' ? undefined : { path: path.replace(/^b\//, ''), ranges: [], deletedLines: 0 };
      if (current) files.push(current);
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      if (!current) continue;
      const start = Number(hunk[2]);
      const count = Number(hunk[3] ?? 1);
      if (count > 0) current.ranges.push({ start, end: start + count - 1 });
      else current.deletedLines += Number(hunk[1] ?? 1);
    }
  }
  return files;
}

export function selectChangedNodes<T extends BaselineNode>(
  nodes: T[],
  ranges: LineRange[],
  kind: 'symbol' | 'file',
): T[] {
  return nodes.filter((node) => {
    if (kind === 'file') return node.type === 'file';
    if (node.type === 'file' || !node.startLine || !node.endLine) return false;
    return ranges.some((range) => node.startLine! <= range.end && node.endLine! >= range.start);
  });
}

export function replaceItemAnchors<T extends { itemId: string }>(
  base: T[],
  changedIds: ReadonlySet<string>,
  replacements: T[],
): T[] {
  if (replacements.some((anchor) => !changedIds.has(anchor.itemId)))
    throw new Error('Replacement outside the fixed PR item set');
  return [...base.filter((anchor) => !changedIds.has(anchor.itemId)), ...replacements];
}
