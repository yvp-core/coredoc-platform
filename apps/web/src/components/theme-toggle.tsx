/**
 * Theme switcher. 'system' means no attribute on <html> (the CSS falls back to
 * prefers-color-scheme); an explicit choice stamps data-theme and persists it,
 * read pre-paint by the inline script in index.html. A window event keeps every
 * useTheme() subscriber in sync.
 */

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Segmented } from './ui/segmented';

const THEME_KEY = 'coredoc-theme';
const THEME_EVENT = 'coredoc-themechange';

export type Theme = 'system' | 'light' | 'dark';

const CYCLE: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'system';
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

/** Apply + persist + broadcast a theme. */
export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode, blocked) — the toggle still
    // works for the session, it just won't persist.
  }
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
}

/** The active theme, re-rendering on change. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    const onChange = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);
  return theme;
}

const ICONS = { system: Monitor, light: Sun, dark: Moon };

export function ThemeToggle() {
  const theme = useTheme();
  const Icon = ICONS[theme];
  const next = CYCLE[theme];
  return (
    <button
      type="button"
      aria-label={`Theme: ${theme}. Switch to ${next}`}
      title={`Theme: ${theme}`}
      onClick={() => applyTheme(next)}
      className="grid size-8 place-items-center rounded-lg border border-border bg-surface text-ink-3 transition-colors hover:border-axis hover:text-ink-1"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

export function ThemeSelect() {
  const theme = useTheme();
  return (
    <Segmented<Theme>
      value={theme}
      onChange={applyTheme}
      items={[
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ]}
    />
  );
}
