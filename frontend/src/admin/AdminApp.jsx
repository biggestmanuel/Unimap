import React, { useCallback, useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_BASE ?? '/api';

function fmt(meters) {
  if (meters == null) return '–';
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Turn an API error code into something a person can act on.
 *
 * The API speaks in codes (`last_admin`, `already_merged`); an admin reading
 * the console should not have to know that. Unrecognised codes fall through
 * unchanged so a new server error is still visible rather than swallowed.
 */
const ERROR_TEXT = {
  last_admin: 'That is the last active admin — the console would be left with no way in.',
  cannot_delete_self: 'You cannot delete your own account.',
  cannot_disable_self: 'You cannot disable your own account.',
  already_merged: 'That trace has already been merged into the map.',
  trace_too_short: 'That trace is too short to be a usable path.',
  not_authenticated: 'Your session has ended. Sign in again.',
  account_disabled: 'That account has been disabled.',
};

function explain(code) {
  return ERROR_TEXT[code] ?? code;
}

/**
 * Admin console.
 *
 * A single self-contained screen rather than a router: there are four queues
 * and they all do the same thing, so a router would be more machinery than
 * the job needs.
 *
 * Everything here is rendered as text via React, never as HTML. Student
 * submissions are untrusted input, and `dangerouslySetInnerHTML` appears
 * nowhere in this project on purpose -- see docs/SECURITY.md.
 */
export default function AdminApp() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState('corrections');
  const [summary, setSummary] = useState(null);
  const [corrections, setCorrections] = useState([]);
  const [traces, setTraces] = useState([]);
  const [graph, setGraph] = useState(null);
  const [users, setUsers] = useState([]);
  const [flash, setFlash] = useState(null);

  // Session token held in a ref, not state: nothing here re-renders when it
  // changes, and a page reload drops it by design.
  const tokenRef = useRef(null);

  const api = useCallback(
    async (path, options = {}) => {
      const token = tokenRef.current;
      const res = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers ?? {}),
        },
        // A bearer token rather than the session cookie, because the console
        // is served from a different origin than the API. A cross-site cookie
        // would need SameSite=None plus an exact-origin allowlist, and the
        // browser would then send it automatically on any request -- which is
        // CSRF. A token in a header is attached deliberately, so forgery is
        // structurally impossible. The cost is no persistence across reloads.
      });
      if (res.status === 401) {
        tokenRef.current = null;
        setUser(null);
        throw new Error('not_authenticated');
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    },
    [],
  );

  // Resume an existing session on load.
  useEffect(() => {
    api('/auth/me')
      .then((b) => setUser(b.user))
      .catch(() => setUser(null))
      .finally(() => setBooting(false));
  }, [api]);

  const refresh = useCallback(async () => {
    try {
      const [s, c, t, g, u] = await Promise.all([
        api('/admin/summary'),
        api('/admin/corrections?status=pending'),
        api('/traces?status=pending'),
        api('/graph/stats'),
        api('/admin/users'),
      ]);
      setSummary(s);
      setCorrections(c.items ?? []);
      setTraces(t.items ?? []);
      setGraph(g);
      setUsers(u.items ?? []);
    } catch (err) {
      if (err.message !== 'not_authenticated') setFlash(err.message);
    }
  }, [api]);

  useEffect(() => {
    // Only an admin has anything to load. A student who signed in would get
    // 401 from all four admin endpoints, which used to clear the session and
    // bounce them straight back to the login screen with no explanation --
    // the "Not allowed" panel below never got a chance to render.
    if (user?.role === 'admin') refresh();
  }, [user, refresh]);

  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setLoginError(null);
    try {
      const body = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      tokenRef.current = body.token;
      setUser(body.user);
    } catch (err) {
      setLoginError(err.message === 'invalid_credentials' ? 'Wrong email or password.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    tokenRef.current = null;
    setUser(null);
  }

  async function reviewCorrection(id, status) {
    setFlash(null);
    try {
      await api(`/admin/corrections/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, reviewer: user.email, note: null }),
      });
      setFlash(`${status === 'approved' ? 'Approved' : 'Rejected'}.`);
      refresh();
    } catch (err) {
      setFlash(err.message);
    }
  }

  async function reviewTrace(id, status) {
    setFlash(null);
    try {
      await api(`/traces/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, reviewer: user.email, note: null }),
      });
      setFlash(`Trace ${status}.`);
      refresh();
    } catch (err) {
      setFlash(err.message);
    }
  }

  /**
   * Merge a trace into the walk graph.
   *
   * The only action in the console that changes routing, so it is the one that
   * asks first: the geometry is cleaned up automatically (jitter removed, real
   * bends kept) and becomes a footpath. That is much cheaper than adding a
   * footpath by hand in OpenStreetMap, which is what this used to tell you to
   * do instead.
   */
  async function mergeTrace(id) {
    const ok = window.confirm(
      'Add this path to the walk graph as a footpath?\n\n'
      + 'GPS jitter is cleaned up automatically. It can be removed later if it '
      + 'turns out to be wrong.',
    );
    if (!ok) return;
    setFlash(null);
    try {
      const body = await api(`/traces/${id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ note: null }),
      });
      const e = body.edge;
      setFlash(
        `Merged. Added a ${e.vertices}-point footpath to the graph `
        + `(${body.stats.totalWays} ways total).`,
      );
      refresh();
    } catch (err) {
      setFlash(explain(err.message));
    }
  }

  async function setUserDisabled(id, disabled) {
    setFlash(null);
    try {
      const body = await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ disabled }),
      });
      setFlash(
        disabled
          ? `Account disabled. ${body.revokedSessions} session(s) revoked.`
          : 'Account re-enabled.',
      );
      refresh();
    } catch (err) {
      setFlash(explain(err.message));
    }
  }

  async function revokeSessions(id) {
    setFlash(null);
    try {
      const body = await api(`/admin/users/${id}/revoke-sessions`, { method: 'POST' });
      // Saying "0" is more useful than silence: it tells the admin the request
      // worked and there was nothing signed in.
      setFlash(
        body.revokedSessions === 0
          ? 'That account had no active sessions.'
          : `Revoked ${body.revokedSessions} session(s).`,
      );
      refresh();
    } catch (err) {
      setFlash(explain(err.message));
    }
  }

  async function deleteUser(id, email) {
    // Spelled out rather than a bare confirm, because this is the one action
    // here that cannot be undone from the interface.
    const ok = window.confirm(
      `Permanently delete ${email}?\n\n`
      + 'Their sessions go with them. Audit history is kept, but the account '
      + 'cannot be restored from here.',
    );
    if (!ok) return;
    setFlash(null);
    try {
      await api(`/admin/users/${id}`, { method: 'DELETE' });
      setFlash('Account deleted.');
      refresh();
    } catch (err) {
      setFlash(explain(err.message));
    }
  }

  if (booting) return <p className="admin-boot">Loading…</p>;

  if (!user) {
    return (
      <div className="admin-login">
        <form className="admin-card" onSubmit={login}>
          <h1>UniMap admin</h1>
          {loginError && <p className="admin-error" role="alert">{loginError}</p>}
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    );
  }

  if (user.role !== 'admin') {
    return (
      <div className="admin-login">
        <div className="admin-card">
          <h1>Not allowed</h1>
          <p>This account is not an admin.</p>
          <button type="button" onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  const tabs = [
    ['corrections', `Corrections (${corrections.length})`],
    ['traces', `Walk traces (${traces.length})`],
    ['graph', 'Graph health'],
    ['users', `Users (${users.length})`],
  ];

  return (
    <div className="admin">
      <header className="admin-bar">
        <strong>UniMap admin</strong>
        <span className="admin-bar__who">{user.email}</span>
        <button type="button" onClick={logout}>Sign out</button>
      </header>

      <nav className="admin-tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'is-active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {flash && <p className="admin-flash" role="status">{flash}</p>}

      <main className="admin-main">
        {tab === 'corrections' && (
          <section>
            <h2>Pending corrections</h2>
            {corrections.length === 0 && <p className="admin-empty">Queue is clear.</p>}
            <ul className="admin-list">
              {corrections.map((c) => (
                <li key={c.id} className="admin-item">
                  <div className="admin-item__head">
                    <span className="admin-badge">{c.kind}</span>
                    <span className="admin-item__meta">
                      {c.reporterEmail ?? 'anonymous'} · {new Date(c.createdAt ?? c.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="admin-item__body">{c.detail}</p>
                  <div className="admin-item__actions">
                    <button type="button" onClick={() => reviewCorrection(c.id, 'approved')}>
                      Approve
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => reviewCorrection(c.id, 'rejected')}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tab === 'traces' && (
          <section>
            <h2>Pending walk traces</h2>
            <p className="admin-hint">
              Furthest off the mapped network first — those are filling a real gap.
              Merging turns the recorded path into a real footpath, cleaned up
              automatically, and it starts routing immediately.
            </p>
            {traces.length === 0 && <p className="admin-empty">No traces waiting.</p>}
            <ul className="admin-list">
              {traces.map((t) => (
                <li key={t.id} className="admin-item">
                  <div className="admin-item__head">
                    <span className="admin-badge admin-badge--warn">
                      {t.maxOffGraphMeters == null ? 'no graph' : `${Math.round(t.maxOffGraphMeters)} m off`}
                    </span>
                    <span className="admin-item__meta">
                      {t.pointCount} pts · {fmt(t.distanceMeters)}
                    </span>
                  </div>
                  {t.note && <p className="admin-item__body">{t.note}</p>}
                  <div className="admin-item__actions">
                    <button type="button" onClick={() => mergeTrace(t.id)}>
                      Merge into map
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => reviewTrace(t.id, 'rejected')}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tab === 'graph' && graph && (
          <section>
            <h2>Walk graph health</h2>
            <dl className="admin-stats">
              <div><dt>Ways</dt><dd>{graph.totalWays}</dd></div>
              <div><dt>Connected groups</dt><dd>{graph.connectedGroups}</dd></div>
              <div><dt>Routable</dt><dd>{fmt(graph.routableMeters)} of {fmt(graph.totalMeters)}</dd></div>
              <div><dt>Dead ends</dt><dd>{graph.deadEndCount}</dd></div>
              <div><dt>Islands</dt><dd>{graph.islandCount}</dd></div>
              <div><dt>Pending corrections</dt><dd>{summary?.pendingCorrections ?? 0}</dd></div>
            </dl>

            <h3>By class</h3>
            <table className="admin-table">
              <thead>
                <tr><th>Class</th><th>Ways</th><th>Length</th><th>Routable</th></tr>
              </thead>
              <tbody>
                {graph.byClass.map((c) => (
                  <tr key={c.edgeClass}>
                    <td>{c.edgeClass}</td>
                    <td>{c.ways}</td>
                    <td>{fmt(c.meters)}</td>
                    <td>
                      {c.meters > 0 ? `${Math.round((100 * c.routableMeters) / c.meters)}%` : '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {graph.islandCount > 0 && (
              <>
                <h3>Islands — unreachable from the network</h3>
                <table className="admin-table">
                  <thead>
                    <tr><th>Ways</th><th>Length</th><th>Names</th></tr>
                  </thead>
                  <tbody>
                    {graph.islands.map((i, idx) => (
                      <tr key={idx}>
                        <td>{i.ways}</td>
                        <td>{fmt(i.meters)}</td>
                        <td>{i.names.length ? i.names.join(', ') : '(unnamed)'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )}

        {tab === 'users' && (
          <section>
            <h2>Users</h2>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th><th>Role</th><th>Sessions</th><th>Created</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.disabledAt ? 'is-disabled' : undefined}>
                    <td>
                      {u.email}
                      {u.disabledAt && (
                        <span className="admin-badge admin-badge--warn">disabled</span>
                      )}
                    </td>
                    <td>
                      <span className={u.role === 'admin' ? 'admin-badge' : ''}>{u.role}</span>
                    </td>
                    <td>{u.activeSessions ?? '–'}</td>
                    <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '–'}</td>
                    <td className="admin-row-actions">
                      <button
                        type="button"
                        onClick={() => setUserDisabled(u.id, !u.disabledAt)}
                        disabled={u.email === user.email}
                        title={u.email === user.email ? 'You cannot do this to yourself' : undefined}
                      >
                        {u.disabledAt ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => revokeSessions(u.id)}
                        disabled={u.email === user.email}
                        title="Sign this account out everywhere"
                      >
                        Revoke sessions
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => deleteUser(u.id, u.email)}
                        disabled={u.email === user.email}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="admin-hint">
              Disabling keeps the account and its history but signs it out
              everywhere. Revoking sessions is what a password reset cannot do
              on its own, because a session is keyed by its own token rather
              than by the password.
            </p>
            <p className="admin-hint">
              Create another admin: <code>npm run user -- --email you@rsu.edu.ng --role admin</code>
            </p>
          </section>
        )}
      </main>
    </div>
  );
}