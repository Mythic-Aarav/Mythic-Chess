// server/puzzles.js
// GET /api/puzzles -> random puzzle (without revealing solution)
// POST /api/puzzles/:id -> check submitted answer, record solve if correct & authed

const express = require('express');
const fs = require('fs');
const path = require('path');
const { run, all } = require('./db');
const { authMiddleware } = require('./auth');

const router = express.Router();

const PUZZLES_PATH = path.join(__dirname, '..', 'data', 'puzzles.json');

function loadPuzzles() {
  const raw = fs.readFileSync(PUZZLES_PATH, 'utf-8');
  return JSON.parse(raw);
}

// GET /api/puzzles -> a random puzzle, solution stripped
router.get('/puzzles', (req, res) => {
  const puzzles = loadPuzzles();
  const puzzle = puzzles[Math.floor(Math.random() * puzzles.length)];
  const { solution, ...safe } = puzzle;
  res.json({ puzzle: safe });
});

// GET /api/puzzles/all -> list all puzzles (no solutions), for a picker UI
router.get('/puzzles/all', (req, res) => {
  const puzzles = loadPuzzles();
  const safe = puzzles.map(({ solution, ...rest }) => rest);
  res.json({ puzzles: safe });
});

// POST /api/puzzles/:id -> body { from, to }, checks against solution
router.post('/puzzles/:id', authMiddleware, async (req, res) => {
  const puzzles = loadPuzzles();
  const puzzle = puzzles.find(p => p.id === req.params.id);
  if (!puzzle) return res.status(404).json({ error: 'Puzzle not found' });

  const { from, to } = req.body;
  const correct = puzzle.solution[0] === from && puzzle.solution[1] === to;

  if (correct) {
    await run(
      'INSERT INTO puzzles_solved (user_id, puzzle_id) VALUES (?, ?)',
      [req.user.id, puzzle.id]
    );
  }

  res.json({ correct, solution: correct ? puzzle.solution : undefined });
});

// GET /api/puzzles/stats/me -> how many puzzles the current user has solved
router.get('/puzzles/stats/me', authMiddleware, async (req, res) => {
  const rows = await all(
    'SELECT COUNT(*) as count FROM puzzles_solved WHERE user_id = ?',
    [req.user.id]
  );
  res.json({ solved: rows[0].count });
});

module.exports = router;
