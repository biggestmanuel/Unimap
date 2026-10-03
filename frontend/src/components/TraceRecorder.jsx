import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cleanTrace, submitTrace, traceLength } from '../lib/traceRecorder.js';
import { formatDistance } from '../hooks/useRouting.js';

/**
 * "You are not on any edge" recorder.
 *
 * Shown when the app has noticed the user is well away from the mapped
 * network. Recording is explicit -- a button they press -- because this app
 * uploads a path someone actually walked, and that should never happen
 * without them agreeing to it at that moment.
 *
 * Auto-stops on reaching the network again, so a forgotten recording cannot
 * silently accumulate a campus-wide walk.
 */
export default function TraceRecorder({ position, offNetworkMeters, onDismiss }) {
  const [recording, setRecording] = useState(false);
  const [points, setPoints] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | recording | sending | sent | error
  const [message, setMessage] = useState(null);

  const buffer = useRef([]);
  const pointsRef = useRef([]);

  // Accumulate while recording. Refs, because this runs on every GPS fix and
  // must not re-render the map -- the panel only needs the length.
  useEffect(() => {
    if (!recording || !position) return;
    buffer.current.push({ lat: position.lat, lng: position.lng });
    const cleaned = cleanTrace(buffer.current);
    buffer.current = cleaned;
    pointsRef.current = cleaned;
    setPoints(cleaned);
  }, [position, recording]);

  /**
   * Stop once we are back on the mapped network, so an abandoned recording
   * cannot quietly accumulate a campus-wide walk.
   *
   * Needs at least one recorded point first. `offNetworkMeters` is whatever
   * the *last route request* reported, so on the very first render it can
   * already be small -- acting on it then stopped recording instantly, every
   * time.
   */
  useEffect(() => {
    if (!recording || offNetworkMeters == null) return;
    if (pointsRef.current.length < 2) return;
    if (offNetworkMeters < 25) setRecording(false);
  }, [offNetworkMeters, recording]);

  const start = useCallback(() => {
    if (recording) return;
    buffer.current = position ? [{ lat: position.lat, lng: position.lng }] : [];
    pointsRef.current = buffer.current;
    setPoints(buffer.current);
    setRecording(true);
    setStatus('recording');
    setMessage(null);
  }, [position, recording]);

  const stop = useCallback(async () => {
    setRecording(false);
    const coords = pointsRef.current;

    if (coords.length < 2) {
      setStatus('idle');
      setMessage('Walked too little to record.');
      return;
    }

    setStatus('sending');
    const result = await submitTrace(coords, {
      reporterDevice: navigator.userAgent?.slice(0, 100),
    });

    if (!result.ok) {
      setStatus('error');
      setMessage(result.error);
      return;
    }

    setStatus('sent');
    setMessage(
      result.duplicatesExistingPath
        ? 'Thanks — we already had a path there.'
        : 'Thanks — that path is now in the review queue.',
    );
    pointsRef.current = [];
    setPoints([]);
  }, []);

  if (status === 'sent') {
    return (
      <div className="trace-recorder trace-recorder--done" role="status">
        <p className="trace-recorder__msg">{message}</p>
        <button type="button" className="btn btn--ghost" onClick={onDismiss}>Close</button>
      </div>
    );
  }

  const metres = points.length >= 2 ? traceLength(points) : 0;

  return (
    <div className="trace-recorder" role="region" aria-label="Record a missing path">
      <p className="trace-recorder__msg">
        {recording
          ? `Recording — ${formatDistance(metres)} so far.`
          : `You are about ${formatDistance(offNetworkMeters)} from any mapped path. Walk the route and record it?`}
      </p>

      {status === 'error' && <p className="trace-recorder__error" role="alert">{message}</p>}

      <div className="trace-recorder__actions">
        {!recording ? (
          <button type="button" className="btn btn--primary" onClick={start} disabled={!position}>
            Record this walk
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={stop}>
            Stop and send ({formatDistance(metres)})
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}