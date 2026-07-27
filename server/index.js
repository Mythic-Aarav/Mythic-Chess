// server/index.js
// Express + Socket.IO server for MYTHIC CHESS

const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

require('./db'); // initializes SQLite tables on require
const { router: authRouter } = require('./auth');
const puzzlesRouter = require('./puzzles');
const { initSocket } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50kb' })); // small cap: this API never needs large payloads

// Basic abuse protection. TODO: for production scale, back this with a
// shared store (Redis) instead of in-memory, since this resets on restart
// and doesn't share state across multiple server instances.
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 requests/minute per IP is generous for normal use, blocks scripted abuse
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
const identifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // identity creation is more sensitive to abuse (spam accounts)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please wait a minute.' },
});
app.use('/api/', apiLimiter);
app.use('/api/auth/identify', identifyLimiter);

// API routes
app.use('/api/auth', authRouter);
app.use('/api', puzzlesRouter);

// Serve static client
app.use(express.static(path.join(__dirname, '..', 'client')));

// Fallback to index.html for any non-API GET (simple SPA-style routing)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

initSocket(io);

server.listen(PORT, () => {
  console.log(`♞ MYTHIC CHESS server running on http://localhost:${PORT}`);
});
