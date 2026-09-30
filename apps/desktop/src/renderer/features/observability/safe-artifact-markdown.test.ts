import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { SafeArtifactMarkdown } from './SafeArtifactMarkdown';

describe('SafeArtifactMarkdown', () => {
  it('keeps HTML, scripts, handlers, javascript links, and remote images inert', () => {
    const markdown = [
      '# Checkpoint',
      '<script>globalThis.__artifactPwned = true</script>',
      '<img src="https://tracker.example/pixel" onerror="globalThis.__artifactPwned = true">',
      '<button onclick="globalThis.__artifactPwned = true">unsafe button</button>',
      '[unsafe link](javascript:alert(1))',
      '[safe-looking link](https://example.test/path)',
      '![remote diagram](https://images.example.test/diagram.png)',
      '```mermaid',
      'graph TD; A-->B',
      '```',
    ].join('\n\n');

    const html = renderToStaticMarkup(createElement(SafeArtifactMarkdown, { content: markdown }));

    expect(html).toContain('Checkpoint');
    expect(html).toContain('unsafe link');
    expect(html).toContain('safe-looking link');
    expect(html).toContain('remote diagram');
    expect(html).toContain('graph TD; A--&gt;B');
    expect(html).not.toMatch(/<script|<img|<button|<a\b|href=|src=|onerror|onclick|javascript:/i);
    expect(html).not.toContain('__artifactPwned');
    expect(html).not.toContain('mermaid-svg');
  });
});
