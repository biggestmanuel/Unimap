import React from 'react';

/**
 * Light/dark switch.
 *
 * Announces its state via aria-pressed rather than a label swap, so a screen
 * reader says "dark, pressed" instead of describing the button's own name.
 */
export default function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      className="btn btn--icon"
      onClick={onToggle}
      aria-pressed={isDark}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Light theme' : 'Dark theme'}
    >
      {isDark ? '☀️' : '🌙'}
    </button>
  );
}