import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import './styles/unimap.css';
import './styles/navigation.css';

/**
 * Apply the stored theme before first paint.
 *
 * Done as a tiny inline script rather than in React because useTheme runs in
 * an effect, which lands after the first frame -- long enough to show a flash
 * of the wrong theme to anyone who chose the non-default one.
 */
try {
  const stored = localStorage.getItem('unimap-theme');
  const theme = stored === 'light' || stored === 'dark'
    ? stored
    : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
} catch {
  // localStorage unavailable; useTheme will sort it out after mount.
}

/**
 * Service worker registration.
 *
 * `autoUpdate` means a new deploy is picked up on the next load rather than
 * leaving students pinned to a stale build with a stale walk graph.
 * onNeedRefresh is deliberately unused: with autoUpdate there is no
 * "waiting" state to prompt for.
 */
registerSW({
  immediate: true,
  onRegisterError(error) {
    // A failed registration only costs offline support, not the app.
    console.warn('[unimap] service worker registration failed:', error);
  },
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);