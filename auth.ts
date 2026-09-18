/**
 * auth.ts — REAL, deployable authentication backend for the Abingdon Library.
 *
 * Uses actual, documented libraries (not invented APIs):
 *   - bcrypt                for password hashing
 *   - express-session        for session cookies
 *   - google-auth-library    to verify Google Sign-In ID tokens server-side
 *   - @simplewebauthn/server for passkey (WebAuthn) registration + login
 *
 * To go live you need, from Abingdon's own accounts (I cannot generate these for you):
 *   - GOOGLE_CLIENT_ID           (Google Cloud Console → OAuth consent screen)
 *   - RP_ID / RP_NAME / ORIGIN   (your real domain, e.g. library.abingdon.org.uk)
 *   - A Postgres connection (see schema.sql) to replace the in-memory `db` stub below
 *   - SESSION_SECRET, served only over HTTPS, with `cookie.secure = true`
 *
 * Passkeys for the Head of Library (or any librarian) are registered once they're logged in
 * by another method (password or Google), then used for every login after that — this file
 * implements both halves (registration + authentication ceremonies) correctly.
 */

import express from 'express';
import bcrypt from 'bcrypt';
import session from 'express-session';
import { OAuth2Client } from 'google-auth-library';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

// ---- config (fill from real Abingdon accounts before deploying) ----
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!; // TODO: Abingdon's own Google OAuth client ID
const RP_ID = process.env.RP_ID || 'library.abingdon.org.uk'; // TODO: real domain
const RP_NAME = 'Abingdon School Library';
const ORIGIN = process.env.ORIGIN || `https://${RP_ID}`;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---- minimal user store contract — swap for real Postgres queries against schema.sql ----
interface StoredUser {
  id: string;
  email: string;
  passwordHash?: string;
  role: 'student' | 'staff' | 'librarian' | 'library_admin' | 'system_admin';
  googleSub?: string;
  passkeys: { credentialID: string; publicKey: Buffer; counter: number }[];
  currentChallenge?: string;
}
declare function findUserByEmail(email: string): Promise<StoredUser | null>;
declare function findUserById(id: string): Promise<StoredUser | null>;
declare function saveUser(user: StoredUser): Promise<void>;
// TODO: replace the three declarations above with real queries against the `user` table
// in schema.sql (never store plaintext email — hash it at rest per the GDPR data model).

export const authRouter = express.Router();

authRouter.use(
  session({
    secret: process.env.SESSION_SECRET!, // TODO: real secret from a secret manager, not .env in prod
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
  })
);

// ---------------------------------------------------------------------------
// 1. Username / password (staff & librarian fallback — students should use SSO where available)
// ---------------------------------------------------------------------------
authRouter.post('/login/password', async (req, res) => {
  const { email, password } = req.body;
  const user = await findUserByEmail(email);
  if (!user?.passwordHash) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' }); // never reveal which field was wrong
  req.session.userId = user.id;
  res.json({ role: user.role });
});

// ---------------------------------------------------------------------------
// 2. Google Sign-In — frontend gets an ID token from Google Identity Services,
//    this endpoint verifies it server-side. Never trust a client-asserted email.
// ---------------------------------------------------------------------------
authRouter.post('/login/google', async (req, res) => {
  const { idToken } = req.body;
  const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified) return res.status(401).json({ error: 'Google verification failed' });
  // TODO: restrict to Abingdon's Workspace domain, e.g. payload.hd === 'abingdon.org.uk'
  let user = await findUserByEmail(payload.email);
  if (!user) return res.status(403).json({ error: 'No Abingdon account found for this Google sign-in' });
  req.session.userId = user.id;
  res.json({ role: user.role });
});

// ---------------------------------------------------------------------------
// 3a. Passkey registration (user must already be authenticated by another method)
// ---------------------------------------------------------------------------
authRouter.post('/passkey/register/options', async (req, res) => {
  const user = await requireSession(req, res);
  if (!user) return;
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(user.id),
    userName: user.email,
    attestationType: 'none',
    excludeCredentials: user.passkeys.map((p) => ({ id: p.credentialID, type: 'public-key' })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  user.currentChallenge = options.challenge;
  await saveUser(user);
  res.json(options);
});

authRouter.post('/passkey/register/verify', async (req, res) => {
  const user = await requireSession(req, res);
  if (!user) return;
  const verification = await verifyRegistrationResponse({
    response: req.body,
    expectedChallenge: user.currentChallenge!,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Could not verify passkey' });
  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
  user.passkeys.push({ credentialID: Buffer.from(credentialID).toString('base64url'), publicKey: Buffer.from(credentialPublicKey), counter });
  await saveUser(user);
  res.json({ verified: true });
});

// ---------------------------------------------------------------------------
// 3b. Passkey login
// ---------------------------------------------------------------------------
authRouter.post('/passkey/login/options', async (req, res) => {
  const { email } = req.body;
  const user = await findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'No account found' });
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: user.passkeys.map((p) => ({ id: p.credentialID, type: 'public-key' })),
    userVerification: 'preferred',
  });
  user.currentChallenge = options.challenge;
  await saveUser(user);
  res.json(options);
});

authRouter.post('/passkey/login/verify', async (req, res) => {
  const { email, response } = req.body;
  const user = await findUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'No account found' });
  const passkey = user.passkeys.find((p) => p.credentialID === response.id);
  if (!passkey) return res.status(400).json({ error: 'Unrecognised passkey' });
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: user.currentChallenge!,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    authenticator: { credentialID: passkey.credentialID, credentialPublicKey: passkey.publicKey, counter: passkey.counter },
  });
  if (!verification.verified) return res.status(401).json({ error: 'Passkey verification failed' });
  passkey.counter = verification.authenticationInfo.newCounter;
  await saveUser(user);
  req.session.userId = user.id;
  res.json({ role: user.role });
});

authRouter.post('/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

async function requireSession(req: express.Request, res: express.Response): Promise<StoredUser | null> {
  const id = req.session.userId;
  const user = id ? await findUserById(id) : null;
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return null; }
  return user;
}

declare module 'express-session' { interface SessionData { userId: string } }
