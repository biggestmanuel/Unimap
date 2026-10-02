import React, { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

const KINDS = [
  { value: 'moved', label: 'It is in the wrong place' },
  { value: 'renamed', label: 'It has been renamed' },
  { value: 'removed', label: 'It no longer exists' },
  { value: 'detail', label: 'Something else is wrong' },
];

/**
 * Student correction submission.
 *
 * The whole point of this form is that it works with no signal. It queues to
 * IndexedDB when the network is unavailable and the queue is drained by the
 * offline layer, so a student in a basement lab can still report that a
 * lecture hall is not where the map says it is.
 *
 * Note what is deliberately absent: no coordinates are asked for. A student
 * reporting "the NEH door is 30 m north" will produce worse geometry than
 * nothing. The map pin from the selected POI is sent instead, and detail is
 * free text.
 */
export default function CorrectionForm({ poi, onClose }) {
  const [kind, setKind] = useState('moved');
  const [detail, setDetail] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | sent | queued | error
  const [error, setError] = useState(null);

  const needsName = kind === 'renamed';
  const canSubmit = detail.trim().length >= 5 && (!needsName || detail.trim().length > 0);

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;

    setStatus('sending');
    setError(null);

    const payload = {
      poiId: poi?.id,
      kind,
      detail: detail.trim(),
      reporterEmail: email.trim() || undefined,
      reporterDevice: navigator.userAgent?.slice(0, 100),
    };

    try {
      const res = await fetch(`${API_BASE}/corrections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 201) {
        setStatus('sent');
        return;
      }
      // Offline or server down: queue rather than lose the report.
      const { queueCorrection } = await import('../lib/offlineQueue.js');
      await queueCorrection(payload);
      setStatus('queued');
    } catch {
      try {
        const { queueCorrection } = await import('../lib/offlineQueue.js');
        await queueCorrection(payload);
        setStatus('queued');
      } catch {
        setError('Could not send that, and could not save it for later.');
        setStatus('error');
      }
    }
  }

  if (status === 'sent' || status === 'queued') {
    return (
      <div className="sheet sheet--form" role="dialog" aria-label="Report a problem">
        <div className="sheet__body">
          <h2 className="sheet__title">
            {status === 'sent' ? 'Thank you' : 'Saved — will send when you are back online'}
          </h2>
          <p className="sheet__text">
            {status === 'sent'
              ? 'An admin will review your report.'
              : 'Your report is queued on this device. It will send itself automatically.'}
          </p>
          <button type="button" className="btn btn--primary" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet sheet--form" role="dialog" aria-label="Report a problem">
      <form className="sheet__body" onSubmit={submit}>
        <h2 className="sheet__title">
          {poi ? `Report a problem with ${poi.name}` : 'Report a problem'}
        </h2>

        <label className="field">
          <span className="field__label">What is wrong?</span>
          <select
            className="field__input"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">
            Tell us more {kind === 'renamed' && <em>(what should it be called?)</em>}
          </span>
          <textarea
            className="field__input"
            rows={4}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="e.g. The main gate entrance is further north, past the car park."
            maxLength={2000}
            required
          />
          <span className="field__hint">
            {detail.trim().length < 5 ? 'A little more detail, please.' : ' '}
          </span>
        </label>

        <label className="field">
          <span className="field__label">Your email <em>(optional)</em></span>
          <input
            className="field__input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="so we can tell you what happened"
          />
        </label>

        {error && <p className="field__error" role="alert">{error}</p>}

        <div className="sheet__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!canSubmit || status === 'sending'}>
            {status === 'sending' ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </form>
    </div>
  );
}