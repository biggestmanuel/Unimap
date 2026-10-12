import React, { useCallback, useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import { tileStatus } from '../lib/tileStatus.js';

/**
 * Watches the tile layer and reports failures upwards.
 *
 * Renders nothing. `MapShell` owns the banner so it can sit outside the map
 * container, which keeps this component free of layout concerns.
 *
 * The failure count is a ref rather than state on purpose: `tileerror` fires
 * once per tile, and a campus viewport can fire a dozen times in a burst. Only
 * a change of *status* is worth re-rendering for.
 */
export default function TileWatcher({ onStatus, isOnline = true }) {
  const map = useMap();
  const failures = useRef(0);
  const notified = useRef(null);

  // Kept in a ref so `report` never changes identity. A new function on every
  // render would tear down and re-add both listeners each time.
  const onlineRef = useRef(isOnline);
  onlineRef.current = isOnline;

  const report = useCallback(() => {
    const status = tileStatus(failures.current, onlineRef.current);
    if ((status?.kind ?? null) === notified.current) return;
    notified.current = status?.kind ?? null;
    onStatus(status);
  }, [onStatus]);

  useEffect(() => {
    const onError = () => {
      failures.current += 1;
      report();
    };

    // A single success clears the count: the server is answering again, and a
    // stale "refusing requests" banner would be worse than no banner.
    const onLoad = () => {
      if (failures.current === 0) return;
      failures.current = 0;
      report();
    };

    map.on('tileerror', onError);
    map.on('tileload', onLoad);
    return () => {
      map.off('tileerror', onError);
      map.off('tileload', onLoad);
    };
  }, [map, report]);

  // Going offline is not a tile-layer event, but it changes what the failures
  // mean, so the message has to be re-evaluated.
  useEffect(() => { report(); }, [isOnline, report]);

  return null;
}