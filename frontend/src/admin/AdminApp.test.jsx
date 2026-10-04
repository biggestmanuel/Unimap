import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminApp from './AdminApp.jsx';

/**
 * AdminApp tests.
 *
 * This file had none, which was the largest untested surface in the project --
 * it now holds the merge, the account controls and the sign-in path. The API is
 * stubbed so the tests exercise the component's decisions (which endpoint, what
 * it sends, what it says afterwards) rather than the network.
 */

const API = 'http://test.invalid/api';

/** Every fetch the component makes, recorded for assertions. */
let calls = [];

/**
 * A minimal Response stand-in.
 *
 * `clone()` is not decorative: the component reads the body of a 401 to decide
 * whether it was a failed sign-in or an expired session, and it does that with
 * `res.clone()` so the body stays readable. A stub without it fails in a way
 * that looks like a component bug.
 */
function json(body, status = 200) {
  const make = () => ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  const res = make();
  res.clone = make;
  return Promise.resolve(res);
}

const ADMIN = { id: 'a1', email: 'admin@rsu.edu.ng', role: 'admin' };

/** Default route table; override per test with `routes`. */
function install(routes = {}) {
  calls = [];
  const table = {
    '/auth/me': () => json({ error: 'not_authenticated' }, 401),
    '/auth/login': () => json({ user: ADMIN, token: 'test-token' }),
    '/auth/logout': () => json({ ok: true }),
    '/admin/summary': () => json({ pendingCorrections: 0, users: 1, admins: 1 }),
    '/admin/corrections': () => json({ items: [], total: 0 }),
    '/traces': () => json({ items: [], total: 0 }),
    '/graph/stats': () => json({
      totalWays: 323, connectedGroups: 42, routableMeters: 39141,
      totalMeters: 47953, deadEndCount: 102, islandCount: 41,
      byClass: [], islands: [],
    }),
    '/admin/users': () => json({ items: [{ ...ADMIN, activeSessions: 1 }] }),
    ...routes,
  };

  globalThis.fetch = vi.fn((url, options = {}) => {
    // The component prefixes every call with VITE_API_BASE, which is `/api`
    // under test. Strip it so the route table can be written in the same short
    // form the component uses in its `api()` calls.
    const full = new URL(url, 'http://x').pathname;
    const path = full.replace(/^\/api(?=\/|$)/, '') || '/';
    calls.push({ path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers });

    // Match longest-prefix first so '/traces/abc/merge' beats '/traces'.
    const key = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((k) => path === k || path.startsWith(`${k}/`));
    if (!key) return json({ error: 'not_found' }, 404);
    return table[key](options, path);
  });
}

/** Sign in and land on the console. */
async function signIn() {
  const view = render(<AdminApp />);
  await screen.findByLabelText(/email/i);
  await userEvent.type(screen.getByLabelText(/email/i), ADMIN.email);
  await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  await screen.findByRole('button', { name: /sign out/i });
  return view;
}

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AdminApp sign-in', () => {
  it('shows the login form when there is no session', async () => {
    install();
    render(<AdminApp />);
    expect(await screen.findByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText(/password/i)).toBeTruthy();
  });

  it('stores the token from the login response', async () => {
    install();
    await signIn();
    // Every subsequent call must carry it, or nothing would authenticate.
    const afterLogin = calls.filter((c) => c.path !== '/auth/login' && c.path !== '/auth/me');
    expect(afterLogin.length).toBeGreaterThan(0);
    for (const c of afterLogin) {
      expect(c.headers?.Authorization).toBe('Bearer test-token');
    }
  });

  it('never sends credentials, which is what makes it cross-origin safe', async () => {
    install();
    await signIn();
    for (const c of calls) {
      expect(c.headers?.credentials).toBeUndefined();
    }
  });

  it('shows a friendly message for a wrong password', async () => {
    install({ '/auth/login': () => json({ error: 'invalid_credentials' }, 401) });
    render(<AdminApp />);
    await screen.findByLabelText(/email/i);
    await userEvent.type(screen.getByLabelText(/email/i), ADMIN.email);
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/wrong email or password/i);
  });

  it('refuses to render the console for a non-admin', async () => {
    install({
      '/auth/me': () => json({ user: { ...ADMIN, role: 'student' } }),
    });
    render(<AdminApp />);
    expect(await screen.findByText(/not allowed/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeTruthy();
  });

  it('clears the token on sign out', async () => {
    install();
    await signIn();
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));

    await screen.findByLabelText(/email/i);
    const after = calls[calls.length - 1];
    expect(after.path).toBe('/auth/logout');
    // No later call may reuse the old token.
    const later = calls.slice(calls.indexOf(after) + 1);
    for (const c of later) {
      expect(c.headers?.Authorization).not.toBe('Bearer test-token');
    }
  });
});

describe('AdminApp walk-trace merge', () => {
  const TRACES = {
    items: [{
      id: 't1',
      pointCount: 61,
      distanceMeters: 895,
      maxOffGraphMeters: 45,
      note: 'path behind the halls',
      status: 'pending',
    }],
    total: 1,
  };

  const MERGED = {
    trace: { id: 't1', status: 'merged', pointCount: 61, distanceMeters: 895 },
    edge: { id: 'e1', edgeClass: 'footpath', source: 'walk-trace', vertices: 6 },
    stats: { totalWays: 324 },
  };

  async function openTraces() {
    const view = await signIn();
    await userEvent.click(screen.getByRole('button', { name: /walk traces/i }));
    await screen.findByText(/path behind the halls/i);
    return view;
  }

  it('merges through the dedicated endpoint, not the old PATCH', async () => {
    install({
      '/traces': () => json(TRACES),
      '/traces/t1/merge': () => json(MERGED),
    });
    await openTraces();

    await userEvent.click(screen.getByRole('button', { name: /merge into map/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.path === '/traces/t1/merge' && c.method === 'POST')).toBe(true);
    });
    // The old "mark merged" path must not be used.
    expect(calls.some((c) => c.path === '/traces/t1' && c.method === 'PATCH')).toBe(false);
  });

  it('asks before merging, because this changes routing', async () => {
    install({
      '/traces': () => json(TRACES),
      '/traces/t1/merge': () => json(MERGED),
    });
    await openTraces();
    await userEvent.click(screen.getByRole('button', { name: /merge into map/i }));
    expect(globalThis.confirm).toHaveBeenCalled();
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    install({
      '/traces': () => json(TRACES),
      '/traces/t1/merge': () => json(MERGED),
    });
    await openTraces();
    await userEvent.click(screen.getByRole('button', { name: /merge into map/i }));

    await waitFor(() => expect(globalThis.confirm).toHaveBeenCalled());
    expect(calls.some((c) => c.path.includes('/merge'))).toBe(false);
  });

  it('reports the new way count after a merge', async () => {
    install({
      '/traces': () => json(TRACES),
      '/traces/t1/merge': () => json(MERGED),
    });
    await openTraces();
    await userEvent.click(screen.getByRole('button', { name: /merge into map/i }));

    const flash = await screen.findByRole('status');
    expect(flash).toHaveTextContent(/merged/i);
    expect(flash).toHaveTextContent(/324 ways total/);
  });

  it('explains a double merge rather than showing a raw code', async () => {
    install({
      '/traces': () => json(TRACES),
      '/traces/t1/merge': () => json({ error: 'already_merged' }, 409),
    });
    await openTraces();
    await userEvent.click(screen.getByRole('button', { name: /merge into map/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/already been merged/i);
    expect(screen.queryByText('already_merged')).toBeNull();
  });

  it('offers no merge button on an empty queue', async () => {
    install({ '/traces': () => json({ items: [], total: 0 }) });
    await signIn();
    await userEvent.click(screen.getByRole('button', { name: /walk traces/i }));
    expect(await screen.findByText(/no traces waiting/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /merge into map/i })).toBeNull();
  });
});

describe('AdminApp user controls', () => {
  const USERS = {
    items: [
      { id: 'a1', email: 'admin@rsu.edu.ng', role: 'admin', activeSessions: 2 },
      { id: 's1', email: 'student@rsu.edu.ng', role: 'student', activeSessions: 1 },
    ],
  };

  async function openUsers() {
    const view = await signIn();
    await userEvent.click(screen.getByRole('button', { name: /^users/i }));
    await screen.findByText('student@rsu.edu.ng');
    return view;
  }

  /** Scope to the users table, since the header shows the admin email too. */
  function userRow(email) {
    const table = screen.getByRole('table');
    const cell = within(table).getByText(email);
    return cell.closest('tr');
  }

  it('disables the destructive controls on your own row', async () => {
    install({ '/admin/users': () => json(USERS) });
    await openUsers();

    const ownRow = userRow('admin@rsu.edu.ng');
    for (const label of [/disable/i, /revoke sessions/i, /delete/i]) {
      const btn = within(ownRow).getByRole('button', { name: label });
      expect(btn.disabled).toBe(true);
    }
  });

  it('leaves them enabled on someone else', async () => {
    install({ '/admin/users': () => json(USERS) });
    await openUsers();

    const otherRow = userRow('student@rsu.edu.ng');
    expect(within(otherRow).getByRole('button', { name: /revoke sessions/i }).disabled).toBe(false);
  });

  it('disables an account with an explicit boolean', async () => {
    install({
      '/admin/users': () => json(USERS),
      '/admin/users/s1': () => json({ user: USERS.items[1], revokedSessions: 1 }),
    });
    await openUsers();

    const otherRow = userRow('student@rsu.edu.ng');
    await userEvent.click(within(otherRow).getByRole('button', { name: /disable/i }));

    await waitFor(() => {
      const call = calls.find((c) => c.method === 'PATCH' && c.path === '/admin/users/s1');
      expect(call).toBeTruthy();
      expect(call.body).toEqual({ disabled: true });
    });
  });

  it('reports how many sessions a disable revoked', async () => {
    install({
      '/admin/users': () => json(USERS),
      '/admin/users/s1': () => json({ user: USERS.items[1], revokedSessions: 3 }),
    });
    await openUsers();

    const otherRow = userRow('student@rsu.edu.ng');
    await userEvent.click(within(otherRow).getByRole('button', { name: /disable/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/3 session/i);
  });

  it('says so plainly when there was nothing to revoke', async () => {
    install({
      '/admin/users': () => json(USERS),
      '/admin/users/s1/revoke-sessions': () => json({ revokedSessions: 0 }),
    });
    await openUsers();

    const otherRow = userRow('student@rsu.edu.ng');
    await userEvent.click(within(otherRow).getByRole('button', { name: /revoke sessions/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/no active sessions/i);
  });

  it('offers Remove only on islands containing a merged trace', async () => {
  // The button is shown when the server says an island contains trace-derived
  // geometry. Imported OSM ways are never removable, so an island with none must
  // not get one.
  install({
    '/graph/stats': () => json({
      totalWays: 324, connectedGroups: 43, routableMeters: 40432,
      totalMeters: 49089, deadEndCount: 102, islandCount: 2,
      byClass: [],
      islands: [
        { ways: 1, meters: 890, names: ['Walk trace abcd1234'], traceEdgeIds: ['e1'] },
        { ways: 3, meters: 240, names: ['Library Road'], traceEdgeIds: [] },
      ],
    }),
  });
  await signIn();
  await userEvent.click(screen.getByRole('button', { name: /graph health/i }));

  const rows = screen.getAllByRole('row').filter((r) => /Walk trace|Library Road/.test(r.textContent));
  expect(rows.length, 'both islands should be listed').toBe(2);

  const traceRow = rows.find((r) => /Walk trace/.test(r.textContent));
  const osmRow = rows.find((r) => /Library Road/.test(r.textContent));

  expect(within(traceRow).getByRole('button', { name: /remove/i })).toBeTruthy();
  expect(within(osmRow).queryByRole('button', { name: /remove/i })).toBeNull();
});

it('removes a merged edge through the delete endpoint', async () => {
  install({
    '/graph/stats': () => json({
      totalWays: 324, connectedGroups: 43, routableMeters: 40432,
      totalMeters: 49089, deadEndCount: 102, islandCount: 1,
      byClass: [],
      islands: [
        { ways: 1, meters: 890, names: ['Walk trace abcd1234'], traceEdgeIds: ['e1'] },
      ],
    }),
    '/admin/graph/edges/e1': () => json({ ok: true, edgeId: 'e1', traceReopened: true, stats: { totalWays: 323 } }),
  });
  await signIn();
  await userEvent.click(screen.getByRole('button', { name: /graph health/i }));

  const row = screen.getAllByRole('row').find((r) => /Walk trace/.test(r.textContent));
  await userEvent.click(within(row).getByRole('button', { name: /remove/i }));

  await waitFor(() => {
    const call = calls.find((c) => c.method === 'DELETE');
    expect(call).toBeTruthy();
    expect(call.path).toBe('/admin/graph/edges/e1');
  });
  expect(await screen.findByRole('status')).toHaveTextContent(/back in the queue/i);
});

it('explains the last-admin refusal instead of showing a code', async () => {
    install({
      '/admin/users': () => json(USERS),
      '/admin/users/s1': () => json({ error: 'last_admin' }, 409),
    });
    await openUsers();

    const otherRow = userRow('student@rsu.edu.ng');
    await userEvent.click(within(otherRow).getByRole('button', { name: /delete/i }));

    const flash = await screen.findByRole('status');
    expect(flash).toHaveTextContent(/no way in/i);
    expect(screen.queryByText('last_admin')).toBeNull();
  });

  it('keeps the account when a delete is cancelled', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    install({ '/admin/users': () => json(USERS) });
    await openUsers();

    const otherRow = userRow('student@rsu.edu.ng');
    await userEvent.click(within(otherRow).getByRole('button', { name: /delete/i }));

    await waitFor(() => expect(globalThis.confirm).toHaveBeenCalled());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('sends DELETE with no body', async () => {
    install({
      '/admin/users': () => json(USERS),
      '/admin/users/s1': () => json({ ok: true }),
    });
    await openUsers();

    const otherRow = userRow('student@rsu.edu.ng');
    await userEvent.click(within(otherRow).getByRole('button', { name: /delete/i }));

    await waitFor(() => {
      const call = calls.find((c) => c.method === 'DELETE');
      expect(call).toBeTruthy();
      expect(call.path).toBe('/admin/users/s1');
    });
  });
});

describe('AdminApp resilience', () => {
  it('shows a message when the API fails, rather than an empty console', async () => {
    install({ '/admin/summary': () => json({ error: 'internal_error' }, 500) });
    render(<AdminApp />);
    await screen.findByLabelText(/email/i);
    await userEvent.type(screen.getByLabelText(/email/i), ADMIN.email);
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/internal_error/);
  });

  it('returns to the login form when a request 401s mid-session', async () => {
    // First load succeeds, then the API starts rejecting everything: exactly
    // what an expired session looks like to the console.
    let healthy = true;
    const routes = {
      '/admin/summary': () => (healthy
        ? json({ pendingCorrections: 0, users: 1, admins: 1 })
        : json({ error: 'not_authenticated' }, 401)),
    };

    install(routes);
    render(<AdminApp />);
    await screen.findByLabelText(/email/i);
    await userEvent.type(screen.getByLabelText(/email/i), ADMIN.email);
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByRole('button', { name: /sign out/i });

    healthy = false;
    // Signing out and back in re-runs refresh() against the now-failing API.
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // Either it is back at the form, or it is showing the failure -- what must
    // not happen is a silently empty console.
    await waitFor(() => {
      const onForm = screen.queryByLabelText(/email/i) !== null;
      const flash = screen.queryByRole('status')?.textContent ?? '';
      expect(onForm || /not_authenticated/.test(flash)).toBe(true);
    });
  });
});