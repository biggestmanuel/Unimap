import React, { useCallback, useEffect, useState } from 'react';

const API = import.meta.env.VITE_API_BASE ?? '/api';

function fmt(meters) {
  if (meters == null) return '–';
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
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

  const api = useCallback(
    async (path, options = {}) => {
      const res = await fetch(`${API}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
        // Session cookie. Deliberately not a bearer token in localStorage:
        // an XSS here would be far more damaging.
        credentials: 'same-origin',
      });
      if (res.status === 401) {
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
        api('/corrections?status=pending'),
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
      setUser(body.user);
    } catch (err) {
      setLoginError(err.message === 'invalid_credentials' ? 'Wrong email or password.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
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
              Approving does not add geometry; merge the path into OpenStreetMap or
              re-run the importer with the corrected data.
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
                    <button type="button" onClick={() => reviewTrace(t.id, 'merged')}>
                      Mark merged
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
                <tr><th>Email</th><th>Role</th><th>Sessions</th><th>Created</th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>
                      <span className={u.role === 'admin' ? 'admin-badge' : ''}>{u.role}</span>
                    </td>
                    <td>{u.activeSessions ?? '–'}</td>
                    <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="admin-hint">
              Create another admin: <code>npm run user -- --email you@rsu.edu.ng --role admin</code>
            </p>
          </section>
        )}
      </main>
    </div>
  );
}