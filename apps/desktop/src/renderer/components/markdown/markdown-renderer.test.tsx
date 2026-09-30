// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

const openExternal = vi.fn(async () => ({ success: true }));

beforeEach(() => {
  openExternal.mockClear();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { openDeliveryExternal: openExternal } });
});
afterEach(cleanup);

describe('MarkdownRenderer links', () => {
  it('opens a link through the main process instead of navigating the window', () => {
    // Query and fragment included: an ordinary docs link must still open.
    render(<MarkdownRenderer content="[docs](https://coredoc.ai/docs?tab=1#section)" enableMermaid={false} />);

    const link = screen.getByRole('link', { name: 'docs' });
    // The window itself opens nothing: `setWindowOpenHandler` denies every popup.
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(openExternal).toHaveBeenCalledWith({ externalUrl: 'https://coredoc.ai/docs?tab=1#section' });
    expect(event.defaultPrevented).toBe(true);
  });

  it('renders a url the main process would refuse as plain text', () => {
    const { container } = render(
      <MarkdownRenderer content="[click](javascript:alert(1)) and [local](file:///etc/passwd)" enableMermaid={false} />,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // The label survives as text, so nothing silently disappears from the doc.
    expect(container.textContent).toContain('click');
    expect(container.textContent).toContain('local');
  });
});
