import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'unimap-theme';

/** Read the stored preference, falling back to the OS setting. */
export function initialTheme() {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private browsing can make localStorage throw. Not worth failing over.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Light/dark theme.
 *
 * Applied by setting `data-theme` on <html> rather than by swapping a
 * stylesheet: the CSS owns the result, so there is one source of truth for
 * what "dark" looks like and no chance of the two drifting.
 */
export function useTheme() {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    // Keep the native form controls and scrollbars in step with the page.
    root.style.colorScheme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore quota / private-mode failures.
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, setTheme, toggle, isDark: theme === 'dark' };
}