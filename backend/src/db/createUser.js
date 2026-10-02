/**
 * Create or update a user.
 *
 *   node src/db/createUser.js --email admin@rsu.edu.ng --role admin --password '...'
 *
 * Reads the password from the prompt when --password is omitted, so it does
 * not end up in shell history.
 */

import { createInterface } from 'node:readline';
import { getPool, closePool } from './pool.js';
import { hashPassword, checkPasswordStrength } from '../lib/auth.js';

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer;
}

const email = arg('email') ?? (await prompt('Email: '));
const role = arg('role') ?? 'admin';

if (!email.includes('@')) {
  console.error('That does not look like an email address.');
  process.exit(1);
}

let password = arg('password');
if (!password) {
  password = await prompt('Password (min 10 chars): ');
  const again = await prompt('Confirm: ');
  if (password !== again) {
    console.error('Passwords did not match.');
    process.exit(1);
  }
}

const issues = checkPasswordStrength(password);
if (issues.length > 0) {
  console.error(`Password rejected: ${issues.join('; ')}`);
  process.exit(1);
}

if (!['student', 'admin'].includes(role)) {
  console.error('Role must be "student" or "admin".');
  process.exit(1);
}

const pool = getPool();
const hash = await hashPassword(password);
const existing = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);

if (existing.rowCount > 0) {
  // Update rather than fail: this is also how a password reset works.
  await pool.query(
    `UPDATE users SET password_hash = $1, role = $2 WHERE id = $3`,
    [hash, role, existing.rows[0].id],
  );
  console.log(`updated ${email} (role: ${role})`);
} else {
  await pool.query(
    'INSERT INTO users (email, role, password_hash) VALUES ($1, $2, $3)',
    [email, role, hash],
  );
  console.log(`created ${email} (role: ${role})`);
}

await closePool();