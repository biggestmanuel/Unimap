import React, { useEffect, useState, useCallback } from 'react';

/**
 * `beforeinstallprompt` handler.
 *
 * Chrome fires this once and then forgets the event unless it is held onto,
 * so it has to be captured early and kept in a ref for as long as the app
 * lives. Without this there is nothing to show an install button.
 *
 * Deliberately not shown on iOS: Safari never fires the event, so the honest
 * thing there is instructions rather than a button that never appears.
 */
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    const onInstalled = () => {
      setDeferred(null);
      setInstalled(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // Already installed as a standalone app?
    if (window.matchMedia?.('(display-mode: standalone)').matches) {
      setInstalled(true);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setDeferred(null);
  }, [deferred]);

  const dismiss = useCallback(() => setDeferred(null), []);

  if (installed || !deferred) return null;

  return (
    <div className="install-prompt" role="dialog" aria-label="Install UniMap">
      <div className="install-prompt__body">
        <p className="install-prompt__title">Install UniMap</p>
        <p className="install-prompt__text">
          Works offline on Glo data, and opens full screen.
        </p>
      </div>
      <div className="install-prompt__actions">
        <button type="button" className="btn btn--ghost" onClick={dismiss}>Not now</button>
        <button type="button" className="btn btn--primary" onClick={install}>Install</button>
      </div>
    </div>
  );
}