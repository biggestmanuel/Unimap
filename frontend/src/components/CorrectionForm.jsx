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
  const [proposedName, setProposedName] = useState('');

  // The API requires a replacement name for a rename, and a name-only hint in
  // the free text is not enough to satisfy it -- every rename submitted this
  // way was rejected with a 400 and then queued forever.
  const needsName = kind === 'renamed';
  const canSubmit = detail.trim().length >= 5
    && (!needsName || proposedName.trim().length >= 2);

  async function submit(event) {
    event.preventDefault();
    if (!canSubmit) return;

    setStatus('sending');
    setError(null);

    const payload = {
      poiId: poi?.id,
      kind,
      detail: detail.trim(),
      proposedName: needsName ? proposedName.trim() : undefined,
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

      // Rate limited: the request was fine, there are just too many of them.
      // Queuing would only hit the same limit again on reconnect, so say so
      // and let the student decide when to retry.
      if (res.status === 429) {
        const wait = Number(res.headers.get('Retry-After'));
        setError(
          `Too many reports at once. Try again in about `
          + `${Number.isFinite(wait) && wait > 0 ? wait : 30} seconds.`,
        );
        setStatus('error');
        return;
      }

      // Server rejected it (validation) or we are offline. Try to queue it.
      await queueLocally(payload);
    } catch {
      // Network threw. Queue it.
      await queueLocally(payload);
    }
  }

  /**
   * Save a report for later.
   *
   * `queueCorrection` resolves to false when IndexedDB is unavailable rather
   * than throwing -- private browsing does exactly that. Treating that as
   * success told the student their report was safely stored and then threw it
   * away, so the return value has to be checked.
   */
  async function queueLocally(payload) {
    try {
      const { queueCorrection } = await import('../lib/offlineQueue.js');
      const stored = await queueCorrection(payload);
      if (stored) {
        setStatus('queued');
        return;
      }
      setError('Could not send that, and this browser will not let me save it for later.');
    } catch {
      setError('Could not send that, and could not save it for later.');
    }
    setStatus('error');
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

        {/* Only asked for a rename, because only a rename needs it. */}
        {needsName && (
          <label className="field">
            <span className="field__label">What is it called now?</span>
            <input
              className="field__input"
              type="text"
              value={proposedName}
              onChange={(e) => setProposedName(e.target.value)}
              placeholder="e.g. Faculty of Engineering Block C"
              maxLength={200}
            />
          </label>
        )}

        <label className="field">
          <span className="field__label">
            Tell us more
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