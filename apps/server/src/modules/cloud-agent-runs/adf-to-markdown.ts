/**
 * Atlassian Document Format to markdown, for the PRD a scope turn hands to the
 * agent. Lossy on purpose: the agent needs the words and the structure, not
 * Jira's presentation. Text is not markdown-escaped, so literal markers the PRD
 * tooling writes (`[unverified]`) reach the agent unchanged; only table cell
 * pipes are escaped, because they would break the row.
 */

interface AdfNode {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: unknown; attrs?: Record<string, unknown> }>;
  content?: unknown;
}

function asNode(value: unknown): AdfNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as AdfNode) : {};
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.map(asNode) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function adfToMarkdown(document: unknown): string {
  return renderBlocks(children(asNode(document))).trim();
}

function renderBlocks(nodes: AdfNode[]): string {
  return nodes
    .map(renderBlock)
    .filter((block) => block.trim() !== '')
    .join('\n\n');
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(children(node));
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${renderInline(children(node))}`;
    }
    case 'bulletList':
    case 'orderedList':
      return renderList(node, 0);
    case 'codeBlock': {
      const language = str(node.attrs?.language) ?? '';
      return `\`\`\`${language}\n${plainText(node)}\n\`\`\``;
    }
    case 'blockquote':
      return renderBlocks(children(node))
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'rule':
      return '---';
    case 'table':
      return renderTable(node);
    case 'panel':
    case 'layoutSection':
    case 'layoutColumn':
    case 'bodiedExtension':
    case 'multiBodiedExtension':
    case 'extensionFrame':
      return renderBlocks(children(node));
    case 'expand':
    case 'nestedExpand': {
      const title = str(node.attrs?.title);
      const body = renderBlocks(children(node));
      return title ? `**${title}**\n\n${body}` : body;
    }
    case 'extension':
      return renderExtension(node);
    case 'blockCard':
    case 'embedCard': {
      const url = str(node.attrs?.url);
      return url ? `<${url}>` : '';
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return children(node).map(renderMedia).join('\n');
    case 'media':
      return renderMedia(node);
    default:
      // Unknown or inline-only nodes at block level: keep what they say.
      return children(node).some(isBlockNode) ? renderBlocks(children(node)) : renderInline([node]);
  }
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'codeBlock',
  'blockquote',
  'rule',
  'table',
  'panel',
  'expand',
  'nestedExpand',
  'extension',
  'bodiedExtension',
  'mediaSingle',
  'mediaGroup',
  'blockCard',
  'embedCard',
]);

function isBlockNode(node: AdfNode): boolean {
  return typeof node.type === 'string' && BLOCK_TYPES.has(node.type);
}

/**
 * Legacy macros carry their body as nested ADF (as a JSON string or object in
 * their parameters); render that, else whatever text the node holds.
 */
function renderExtension(node: AdfNode): string {
  const parameters = asNode(node.attrs?.parameters) as Record<string, unknown>;
  for (const candidate of [parameters.adf, parameters.content, node.attrs?.content]) {
    let parsed: unknown = candidate;
    if (typeof candidate === 'string') {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    const nested = asNode(parsed);
    if (nested.type === 'doc' || Array.isArray(nested.content)) {
      const rendered = renderBlocks(children(nested));
      if (rendered) return rendered;
    }
  }
  if (children(node).length) return renderBlocks(children(node));
  return str(node.attrs?.text) ?? str(node.text) ?? '';
}

function renderMedia(node: AdfNode): string {
  const label = str(node.attrs?.alt) ?? str(node.attrs?.name) ?? str(node.attrs?.type) ?? 'attachment';
  return `[media: ${label}]`;
}

function renderList(node: AdfNode, depth: number): string {
  const ordered = node.type === 'orderedList';
  const start = ordered ? Math.max(0, Math.trunc(Number(node.attrs?.order ?? 1)) || 1) : 0;
  const indent = '  '.repeat(depth);
  return children(node)
    .map((item, index) => {
      const marker = ordered ? `${start + index}.` : '-';
      const lines: string[] = [];
      for (const child of children(item)) {
        if (child.type === 'bulletList' || child.type === 'orderedList') {
          lines.push(renderList(child, depth + 1));
        } else {
          const rendered = renderBlock(child);
          if (!rendered) continue;
          const continuation = `${indent}${' '.repeat(marker.length + 1)}`;
          const body = rendered
            .split('\n')
            .map((line, lineIndex) => (lineIndex === 0 ? line : `${continuation}${line}`))
            .join('\n');
          lines.push(lines.length === 0 ? `${indent}${marker} ${body}` : `${continuation}${body}`);
        }
      }
      return lines.length ? lines.join('\n') : `${indent}${marker}`;
    })
    .join('\n');
}

function renderTable(node: AdfNode): string {
  const rows = children(node).map((row) =>
    children(row).map((cell) => renderBlocks(children(cell)).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
  const [header, ...body] = rows;
  return [line(header!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

function renderInline(nodes: AdfNode[]): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return applyMarks(typeof node.text === 'string' ? node.text : '', node.marks ?? []);
    case 'hardBreak':
      return '  \n';
    case 'inlineCard': {
      const url = str(node.attrs?.url);
      return url ? `<${url}>` : '';
    }
    case 'status':
      return str(node.attrs?.text) ? `\`${node.attrs!.text as string}\`` : '';
    case 'emoji':
      return str(node.attrs?.text) ?? str(node.attrs?.shortName) ?? '';
    case 'mention':
      return str(node.attrs?.text) ?? '@mention';
    case 'date':
      return renderDate(node.attrs?.timestamp);
    case 'media':
    case 'mediaInline':
      return renderMedia(node);
    default:
      return str(node.text) ?? str(node.attrs?.text) ?? renderInline(children(node));
  }
}

/** Jira writes epoch milliseconds as a string; older content holds seconds. */
function renderDate(timestamp: unknown): string {
  const raw =
    typeof timestamp === 'number' ? String(Math.trunc(timestamp)) : typeof timestamp === 'string' ? timestamp : '';
  if (!/^\d{1,16}$/.test(raw)) return raw;
  const millis = raw.length <= 10 ? Number(raw) * 1000 : Number(raw);
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : raw;
}

function applyMarks(value: string, marks: NonNullable<AdfNode['marks']>): string {
  if (!value) return value;
  let out = value;
  const types = new Set(marks.map((mark) => mark.type));
  if (types.has('code')) out = `\`${out}\``;
  if (types.has('em')) out = `*${out}*`;
  if (types.has('strong')) out = `**${out}**`;
  if (types.has('strike')) out = `~~${out}~~`;
  const link = marks.find((mark) => mark.type === 'link');
  const href = str(link?.attrs?.href);
  if (href) out = `[${out}](${href})`;
  return out;
}

function plainText(node: AdfNode): string {
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  return children(node).map(plainText).join('');
}
