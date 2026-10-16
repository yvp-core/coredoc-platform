/**
 * Theme picker. 'system' means no attribute on <html> (the CSS falls back to
 * prefers-color-scheme); an explicit choice stamps data-theme and persists it,
 * read pre-paint by the inline script in index.html.
 */

import { useState } from 'react';

import { Segmented } from './ui/segmented';

const THEME_KEY = 'coredoc-theme';

type Theme = 'system' | 'light' | 'dark';

function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode, blocked) — the choice still
    // applies for the session, it just won't persist.
  }
}

export function ThemeSelect() {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = document.documentElement.dataset.theme;
    return t === 'light' || t === 'dark' ? t : 'system';
  });
  return (
    <Segmented<Theme>
      value={theme}
      onChange={(next) => {
        applyTheme(next);
        setTheme(next);
      }}
      items={[
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ]}
    />
  );
}
