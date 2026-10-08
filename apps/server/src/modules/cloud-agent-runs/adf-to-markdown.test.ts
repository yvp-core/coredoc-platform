import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adfToMarkdown } from './adf-to-markdown.js';

/** Synthetic until the first real PRD description is captured and scrubbed (SF-001 ticket 13). */
const syntheticPrd: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/synthetic-prd.adf.json', import.meta.url), 'utf8'),
);

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });

describe('Atlassian Document Format to markdown', () => {
  it.each([
    ['headings by level', doc({ type: 'heading', attrs: { level: 2 }, content: [text('Goals')] }), '## Goals'],
    [
      'strong, emphasis, code and link marks',
      doc(
        p(
          text('bold', [{ type: 'strong' }]),
          text(' and '),
          text('soft', [{ type: 'em' }]),
          text(' with '),
          text('cfg.yaml', [{ type: 'code' }]),
          text(' see '),
          text('docs', [{ type: 'link', attrs: { href: 'https://example.com/docs' } }]),
        ),
      ),
      '**bold** and *soft* with `cfg.yaml` see [docs](https://example.com/docs)',
    ],
    [
      'bullet lists, nested',
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              p(text('one')),
              { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('one-a'))] }] },
            ],
          },
          { type: 'listItem', content: [p(text('two'))] },
        ],
      }),
      '- one\n  - one-a\n- two',
    ],
    [
      'ordered lists keep their start number',
      doc({
        type: 'orderedList',
        attrs: { order: 3 },
        content: [
          { type: 'listItem', content: [p(text('third'))] },
          { type: 'listItem', content: [p(text('fourth'))] },
        ],
      }),
      '3. third\n4. fourth',
    ],
    [
      'code blocks with their language',
      doc({ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] }),
      '```ts\nconst a = 1;\n```',
    ],
    [
      'tables with cell pipes escaped',
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [p(text('Field'))] },
              { type: 'tableHeader', content: [p(text('Rule'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [p(text('status'))] },
              { type: 'tableCell', content: [p(text('open | closed'))] },
            ],
          },
        ],
      }),
      '| Field | Rule |\n| --- | --- |\n| status | open \\| closed |',
    ],
    ['blockquotes', doc({ type: 'blockquote', content: [p(text('quoted'))] }), '> quoted'],
    ['rules', doc(p(text('above')), { type: 'rule' }, p(text('below'))), 'above\n\n---\n\nbelow'],
    ['hard breaks', doc(p(text('line one'), { type: 'hardBreak' }, text('line two'))), 'line one  \nline two'],
    [
      'smart links by their URL',
      doc(p(text('See '), { type: 'inlineCard', attrs: { url: 'https://example.com/page' } })),
      'See <https://example.com/page>',
    ],
    [
      'block and embed cards by their URL',
      doc({ type: 'blockCard', attrs: { url: 'https://example.com/board' } }),
      '<https://example.com/board>',
    ],
    [
      'status lozenges by their text',
      doc(p({ type: 'status', attrs: { text: 'IN REVIEW', color: 'blue' } })),
      '`IN REVIEW`',
    ],
    ['emoji by their text', doc(p({ type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } })), '😄'],
    ['emoji by their short name without text', doc(p({ type: 'emoji', attrs: { shortName: ':rocket:' } })), ':rocket:'],
    [
      'mentions by their text',
      doc(p({ type: 'mention', attrs: { id: 'abc', text: '@Product Owner' } })),
      '@Product Owner',
    ],
    ['mentions without text as a placeholder', doc(p({ type: 'mention', attrs: { id: 'abc' } })), '@mention'],
    ['13-digit dates as an ISO date', doc(p({ type: 'date', attrs: { timestamp: '1767225600000' } })), '2026-01-01'],
    ['10-digit dates as an ISO date', doc(p({ type: 'date', attrs: { timestamp: '1767225600' } })), '2026-01-01'],
    [
      'panels rendered inline',
      doc({ type: 'panel', attrs: { panelType: 'warning' }, content: [p(text('Careful'))] }),
      'Careful',
    ],
    [
      'expands rendered inline with their title',
      doc({ type: 'expand', attrs: { title: 'Details' }, content: [p(text('Hidden body'))] }),
      '**Details**\n\nHidden body',
    ],
    [
      'media as a placeholder',
      doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'x', alt: 'diagram.png' } }] }),
      '[media: diagram.png]',
    ],
    [
      'extension nodes from their nested ADF content',
      doc({
        type: 'bodiedExtension',
        attrs: { extensionKey: 'legacy-macro' },
        content: [p(text('inside the macro'))],
      }),
      'inside the macro',
    ],
    [
      'legacy extension nodes carrying ADF in their parameters',
      doc({
        type: 'extension',
        attrs: {
          extensionKey: 'legacy-content',
          parameters: { adf: JSON.stringify(doc(p(text('nested legacy text')))) },
        },
      }),
      'nested legacy text',
    ],
    [
      'extension nodes without nested content as their text',
      doc({ type: 'extension', attrs: { extensionKey: 'toc', text: 'Table of contents' } }),
      'Table of contents',
    ],
    [
      'inline cards inside headings by their URL',
      doc({
        type: 'heading',
        attrs: { level: 3 },
        content: [text('Design '), { type: 'inlineCard', attrs: { url: 'https://example.com/design' } }],
      }),
      '### Design <https://example.com/design>',
    ],
    ['unknown nodes degraded to their text', doc({ type: 'futureNode', content: [text('kept text')] }), 'kept text'],
    [
      'literal markers survive unescaped',
      doc(p(text('[unverified] the export takes 2 minutes'))),
      '[unverified] the export takes 2 minutes',
    ],
  ])('renders %s', (_name, input, expected) => {
    expect(adfToMarkdown(input)).toBe(expected);
  });

  it('renders nothing for an empty or missing description', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(doc())).toBe('');
  });

  it('renders the synthetic PRD fixture with every structure the PRD tooling produces', () => {
    const markdown = adfToMarkdown(syntheticPrd);
    expect(markdown).toContain('## Problem <https://example.com/wiki/context>');
    expect(markdown).toContain('Teams lose track of exports.');
    expect(markdown).toContain('Decision: exports stay asynchronous.');
    expect(markdown).toContain('1. Request an export');
    expect(markdown).toContain('2. Download the file');
    expect(markdown).toContain('`ExportJob`');
    expect(markdown).toContain('Shared acceptance criteria from the legacy macro');
    expect(markdown).toContain('| Limit | Value |');
    expect(markdown).toContain('[unverified] exports finish within 10 minutes');
  });
});
