export type Theme = 'dark' | 'light';

// The desktop app runs in light mode (shadcn :root base, no .dark applied), so
// the explorer palette is light to match its chrome. viz-style.ts re-resolves
// the explorer canvas palette from this value + the --n-* CSS tokens (globals.css).
// Wire this to real desktop theme state if/when a theme toggle is added.
export const useTheme = (): Theme => 'light';
