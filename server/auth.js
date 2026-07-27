// server/auth.js
// No sign-in / password anymore. Players just pick a display name once;
// the browser remembers it (localStorage) and this issues a JWT tied to
// that name so the rest of the app (elo, puzzles solved, sockets) can
// still identify "who" is playing, same as before, just without a login step.

const express = require('express');
const jwt = require('jsonwebtoken');
const { run, get, all } = require('./db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'mythic-chess-super-secret-change-me';
const STARTING_ELO = 0;

// Middleware to verify JWT and attach req.user
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded; // { id, username }
    next();
  });
}

function sanitizeName(raw) {
  return (raw || '').trim().slice(0, 20);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC-based
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// POST /identify — the only "auth" step now. Body: { name }
// Creates a fresh lifetime identity the first time; the client is
// responsible for remembering the returned token/username afterwards.
router.post('/identify', async (req, res) => {
  try {
    const name = sanitizeName(req.body.name);
    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'Please enter a name (2+ characters)' });
    }

    const existing = await get('SELECT id FROM users WHERE username = ?', [name]);
    if (existing) {
      return res.status(409).json({ error: 'This name is not available. Please try another.' });
    }

    const result = await run(
      'INSERT INTO users (username, password_hash, elo, streak, last_active_date) VALUES (?, ?, ?, ?, ?)',
      [name, '', STARTING_ELO, 1, todayStr()]
    );

    const token = jwt.sign(
      { id: result.lastID, username: name },
      JWT_SECRET,
      { expiresIn: '3650d' } // effectively "lifetime" for this simple app
    );

    res.json({
      token,
      user: { id: result.lastID, username: name, elo: STARTING_ELO, streak: 1 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not set up your name, please try again' });
  }
});

// GET /me - returns current user info AND checks the daily streak.
// Called once per session load, so this doubles as the "check in for today" step:
// - same day as last visit -> streak unchanged
// - exactly one day since last visit -> streak +1
// - more than one day gap -> streak resets to 1 (they missed a day)
router.get('/me', authMiddleware, async (req, res) => {
  const user = await get('SELECT id, username, elo, streak, last_active_date FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const today = todayStr();
  let streak = user.streak || 0;

  if (user.last_active_date !== today) {
    const gap = user.last_active_date ? daysBetween(user.last_active_date, today) : 1;
    streak = gap === 1 ? streak + 1 : 1;
    await run('UPDATE users SET streak = ?, last_active_date = ? WHERE id = ?', [streak, today, user.id]);
  }

  res.json({ user: { id: user.id, username: user.username, elo: user.elo, streak } });
});

// GET /leaderboard - top 10 by elo
router.get('/leaderboard', async (req, res) => {
  const rows = await all('SELECT username, elo FROM users ORDER BY elo DESC LIMIT 10');
  res.json({ leaderboard: rows });
});

module.exports = { router, authMiddleware, JWT_SECRET };
