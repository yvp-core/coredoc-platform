/**
 * The window picker's behavioural contract, and the only place in either app where
 * the *open* popover is exercised (the desktop suite runs in the 'node'
 * environment, so it can only assert the closed trigger — see
 * apps/desktop/src/renderer/features/observability/window-selector.test.ts).
 *
 * The trigger and the presets share their wording ("Last 30 days"), which is the
 * point of the control — so every popover query is scoped to the dialog.
 *
 * (The feedback-card contracts live in usage/feedback-card.test.tsx.)
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AnalyticsWindow, AnalyticsWindowKind } from './types.js';
import { WindowSelector } from './WindowSelector.js';

afterEach(cleanup);

/** Renders the selector, opens the popover, and returns queries scoped to it. */
async function openPicker(analyticsWindow: AnalyticsWindow, onChange: (next: AnalyticsWindow) => void) {
  render(<WindowSelector analyticsWindow={analyticsWindow} onChange={onChange} />);
  await userEvent.click(screen.getByRole('button', { expanded: false }));
  return within(screen.getByRole('dialog'));
}

describe('WindowSelector trigger', () => {
  it('names the preset, and is the only control in the header', () => {
    render(
      <WindowSelector analyticsWindow={{ kind: AnalyticsWindowKind.Days, days: 30 }} onChange={() => undefined} />,
    );

    expect(screen.getByRole('button', { name: /Last 30 days/ })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByLabelText('From date')).toBeNull();
  });

  it('names the range itself when the window is a custom one', () => {
    render(
      <WindowSelector
        analyticsWindow={{ kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' }}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: /1 Aug – 14 Aug/ })).toBeTruthy();
  });
});

describe('WindowSelector popover', () => {
  it('emits a Days window for each of the three presets', async () => {
    for (const days of [7, 30, 90]) {
      const onChange = vi.fn();
      const picker = await openPicker(
        { kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' },
        onChange,
      );

      await userEvent.click(picker.getByRole('button', { name: `Last ${days} days` }));
      await userEvent.click(picker.getByRole('button', { name: 'Update' }));

      expect(onChange).toHaveBeenCalledWith({ kind: AnalyticsWindowKind.Days, days });
      cleanup();
    }
  });

  it('marks the preset the window came from as the pressed one', async () => {
    const picker = await openPicker({ kind: AnalyticsWindowKind.Days, days: 7 }, () => undefined);

    expect(picker.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(picker.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('emits a Custom window of UTC calendar-day strings when a range is edited by hand', async () => {
    const onChange = vi.fn();
    const picker = await openPicker(
      { kind: AnalyticsWindowKind.Custom, since: '2026-08-01', until: '2026-08-14' },
      onChange,
    );

    // The date fields are three segments each; move the start of the range.
    await userEvent.clear(picker.getByLabelText('From date day'));
    await userEvent.type(picker.getByLabelText('From date day'), '5');
    await userEvent.click(picker.getByRole('button', { name: 'Update' }));

    expect(onChange).toHaveBeenCalledWith({
      kind: AnalyticsWindowKind.Custom,
      since: '2026-08-05',
      until: '2026-08-14',
    });
  });

  it('blocks Update and says why while the draft spans more than the clamp', async () => {
    const onChange = vi.fn();
    const picker = await openPicker(
      { kind: AnalyticsWindowKind.Custom, since: '2026-01-01', until: '2026-03-31' }, // exactly 90 days
      onChange,
    );

    expect(picker.getByRole('button', { name: 'Update' })).not.toBeDisabled();

    // One day more.
    await userEvent.clear(picker.getByLabelText('From date day'));
    await userEvent.type(picker.getByLabelText('From date day'), '31');
    await userEvent.clear(picker.getByLabelText('From date month'));
    await userEvent.type(picker.getByLabelText('From date month'), '12');
    await userEvent.clear(picker.getByLabelText('From date year'));
    await userEvent.type(picker.getByLabelText('From date year'), '2025');

    expect(picker.getByRole('alert').textContent).toMatch(/90 days/);
    expect(picker.getByRole('button', { name: 'Update' })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers no day past today', async () => {
    const picker = await openPicker({ kind: AnalyticsWindowKind.Days, days: 30 }, () => undefined);

    // Two months are rendered; the later one is the current month.
    const grids = picker.getAllByRole('grid');
    const currentMonth = within(grids[grids.length - 1] as HTMLElement);
    const selectable = currentMonth
      .getAllByRole('gridcell')
      // Days spilling in from a neighbouring month are rendered invisible.
      .filter((cell) => !cell.hasAttribute('disabled') && !cell.className.includes('invisible'));

    expect(selectable.length).toBeGreaterThan(0);
    for (const cell of selectable) expect(Number(cell.textContent)).toBeLessThanOrEqual(new Date().getDate());
  });

  it('discards the draft on Cancel, leaving the committed window untouched', async () => {
    const onChange = vi.fn();
    const picker = await openPicker({ kind: AnalyticsWindowKind.Days, days: 30 }, onChange);

    await userEvent.click(picker.getByRole('button', { name: 'Last 7 days' }));
    await userEvent.click(picker.getByRole('button', { name: 'Cancel' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Last 30 days/ })).toBeTruthy();
  });

  it('closes on Escape without committing', async () => {
    const onChange = vi.fn();
    await openPicker({ kind: AnalyticsWindowKind.Days, days: 30 }, onChange);

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
