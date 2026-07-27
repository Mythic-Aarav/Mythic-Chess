// server/game.js
// Handles Socket.IO matchmaking queue and real-time chess games.
// Uses chess.js for legal move validation and FEN state.
// Timers: none — games are untimed. Elo: +20 win / -20 loss (0/0 on draw).
//
// TODO (deferred, larger scope — see ROADMAP.md):
// - Post-game "Game Review" (accuracy %, move classification: brilliant/
//   blunder/etc.) needs a real chess engine (e.g. Stockfish via a WASM
//   build or a separate analysis microservice) — not present yet.
// - Live evaluation bar during play would hook in here too, streamed
//   alongside boardUpdate events once an engine is wired up.
// - Spectator mode: would extend startGame() to let extra sockets join
//   a game's room read-only (io.to(gameId)) without being white/black.
// - Reconnect-after-disconnect: currently a disconnect ends the game as
//   a resignation. A grace-period/reconnect-token system would go here.

const { Chess } = require('chess.js');
const jwt = require('jsonwebtoken');
const { run, get } = require('./db');
const { JWT_SECRET } = require('./auth');

const ELO_DELTA = 20;
const BOT_MATCH_TIMEOUT_MS = 8000; // if no human opponent found within this window, pair with a bot
const BOT_MOVE_DELAY_MS = [600, 1600]; // randomized "thinking time" range for the bot

// Names used for the bot opponent so it reads as a person, not "Computer"/"CPU"
const BOT_NAMES = [
  'Aarav', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Sneha',
  'Karan', 'Divya', 'Aditya', 'Neha', 'Rahul', 'Ishita',
];

function randomBotName() {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

const BOT_CHAT_REPLIES_EN = [
  'Good luck, have fun!', 'Nice move!', 'Hmm, let me think...',
  'gg so far', 'Interesting choice.', 'You\'re playing well.',
  'One sec, thinking...', 'This is a good game.',
];
const BOT_CHAT_GREETINGS_EN = ['Hey there!', 'Hi! Good luck.', 'Hello! Let\'s have a good game.'];
const BOT_CHAT_REPLIES_HI = [
  'Sahi khel rahe ho!', 'Accha move tha.', 'Ek min, soch raha hoon...',
  'Maza aa raha hai game mein.', 'Tumhari chaal achhi thi.',
];
const BOT_CHAT_GREETINGS_HI = ['Namaste! Best of luck.', 'Hii! Chalo shuru karte hain.'];

// Not real language understanding — just enough pattern-matching so the
// bot's chat feels like it's responding to you rather than firing off
// unrelated canned lines. TODO: swap this for a real chat model if/when
// one is available — see ROADMAP.md.
function chooseBotReply(userText) {
  const text = userText.toLowerCase();
  const isHindi = /[\u0900-\u097F]/.test(userText) ||
    /\b(hai|nahi|haan|kya|kaise|kaisa|namaste|acha|accha|bakwas|kar|raha|shabash|theek|thik)\b/.test(text);

  const greetingWords = ['hi', 'hello', 'hey', 'namaste', 'yo'];
  const isGreeting = greetingWords.some(w => text === w || text.startsWith(w + ' ') || text.startsWith(w + '!'));

  if (isGreeting) {
    return isHindi
      ? BOT_CHAT_GREETINGS_HI[Math.floor(Math.random() * BOT_CHAT_GREETINGS_HI.length)]
      : BOT_CHAT_GREETINGS_EN[Math.floor(Math.random() * BOT_CHAT_GREETINGS_EN.length)];
  }

  const pool = isHindi ? BOT_CHAT_REPLIES_HI : BOT_CHAT_REPLIES_EN;
  return pool[Math.floor(Math.random() * pool.length)];
}

// In-memory state
let waitingPlayer = null; // { socket, user }
const games = new Map(); // gameId -> gameState

function makeGameId() {
  return 'g_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function applyEloUpdate(winnerId, loserId, isDraw) {
  if (isDraw) return; // no elo change on draw in this simple model
  if (winnerId) await run('UPDATE users SET elo = elo + ? WHERE id = ?', [ELO_DELTA, winnerId]);
  if (loserId) await run('UPDATE users SET elo = MAX(0, elo - ?) WHERE id = ?', [ELO_DELTA, loserId]);
}

function clearBotTimeout(entry) {
  if (entry && entry.botTimeout) clearTimeout(entry.botTimeout);
}

// Creates and starts a live game between two players (either may be a bot).
// Games are untimed — no clocks, no time-based loss condition.
function startGame(io, playerA, playerB) {
  const gameId = makeGameId();
  const chess = new Chess();

  const flip = Math.random() < 0.5;
  const white = flip ? playerA : playerB;
  const black = flip ? playerB : playerA;

  const state = { id: gameId, chess, white, black, turn: 'w' };
  games.set(gameId, state);

  if (white.socket) white.socket.join(gameId);
  if (black.socket) black.socket.join(gameId);

  const payload = (color) => ({
    gameId,
    color,
    fen: chess.fen(),
    white: { username: white.user.username },
    black: { username: black.user.username },
  });

  if (white.socket) white.socket.emit('matchFound', payload('w'));
  if (black.socket) black.socket.emit('matchFound', payload('b'));

  // If the bot happens to be White, it makes the opening move.
  maybeTriggerBotMove(io, gameId);
}

// If it's currently the bot's turn in this game, make a random legal move
// after a short randomized delay, so it doesn't feel instantaneous/robotic.
function maybeTriggerBotMove(io, gameId) {
  const state = games.get(gameId);
  if (!state) return;

  const botSide = state.white.isBot ? 'w' : (state.black.isBot ? 'b' : null);
  if (!botSide || state.chess.turn() !== botSide) return;

  const delay = BOT_MOVE_DELAY_MS[0] + Math.random() * (BOT_MOVE_DELAY_MS[1] - BOT_MOVE_DELAY_MS[0]);
  setTimeout(() => {
    const s = games.get(gameId);
    if (!s || s.chess.turn() !== botSide) return; // game may have ended already

    const legalMoves = s.chess.moves({ verbose: true });
    if (legalMoves.length === 0) return; // game over, handled elsewhere

    const chosen = chooseBotMove(s.chess, legalMoves);
    const moveResult = s.chess.move({ from: chosen.from, to: chosen.to, promotion: chosen.promotion || 'q' });

    s.turn = s.chess.turn();

    io.to(gameId).emit('boardUpdate', {
      fen: s.chess.fen(),
      lastMove: { from: chosen.from, to: chosen.to },
      turn: s.turn,
      san: moveResult.san,
    });

    checkForcedGameEnd(io, gameId, s.chess, s.turn);
  }, delay);
}

// Simple, honest bot logic — NOT a real engine, no lookahead search.
// It just makes sure the bot doesn't ignore free material sitting in
// front of it, which is what made it look "noob" (missing captures).
// Priority: 1) take the highest-value free/safe capture available,
// 2) otherwise, prefer a move that gives check, 3) otherwise random.
// TODO: a real engine (Stockfish) would replace this entirely — see ROADMAP.md.
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function chooseBotMove(chess, legalMoves) {
  const captureMoves = legalMoves.filter(m => m.flags.includes('c') || m.flags.includes('e'));

  if (captureMoves.length > 0) {
    // Score each capture by (value gained) minus (value risked if the
    // capturing piece could immediately be recaptured) — a cheap 1-ply
    // safety check, not a full search, but enough to stop obviously
    // bad trades and to grab free pieces reliably.
    let best = null;
    let bestScore = -Infinity;
    for (const move of captureMoves) {
      const gained = PIECE_VALUE[(move.captured || 'p').toLowerCase()] || 1;
      const risked = wouldBeRecaptured(chess, move) ? (PIECE_VALUE[move.piece.toLowerCase()] || 1) : 0;
      const score = gained - risked;
      if (score > bestScore) { bestScore = score; best = move; }
    }
    if (bestScore >= 0) return best; // only take it if it's not a losing trade
  }

  // No good capture -> prefer a check if one's available, just for flavor.
  const checkMoves = legalMoves.filter(m => m.san && m.san.includes('+'));
  if (checkMoves.length > 0) return checkMoves[Math.floor(Math.random() * checkMoves.length)];

  return legalMoves[Math.floor(Math.random() * legalMoves.length)];
}

// After making `move`, would any opponent piece be able to capture on
// that same destination square? Cheap 1-ply check using a scratch board.
function wouldBeRecaptured(chess, move) {
  try {
    const scratch = new Chess(chess.fen());
    scratch.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
    const opponentMoves = scratch.moves({ verbose: true });
    return opponentMoves.some(m => m.to === move.to && (m.flags.includes('c') || m.flags.includes('e')));
  } catch (e) {
    return false;
  }
}


function initSocket(io) {
  io.on('connection', (socket) => {
    let authedUser = null; // { id, username }

    // --- Auth handshake over socket ---
    socket.on('auth', (token) => {
      const decoded = verifyToken(token);
      if (decoded) {
        authedUser = { id: decoded.id, username: decoded.username };
        socket.emit('authOk', authedUser);
      } else {
        socket.emit('authError', 'Invalid token');
      }
    });

    // --- Matchmaking ---
    socket.on('findMatch', async () => {
      if (!authedUser) return socket.emit('errorMsg', 'Login required to play');

      if (waitingPlayer && waitingPlayer.socket.id !== socket.id) {
        // A human opponent is already waiting -> pair them up immediately
        const opponent = waitingPlayer;
        clearBotTimeout(opponent);
        waitingPlayer = null;
        startGame(io, opponent, { socket, user: authedUser });
      } else {
        // No one waiting -> join queue, and start a timer that pairs us with
        // a bot opponent (shown under a random human name) if no real player
        // shows up in time.
        const entry = { socket, user: authedUser, botTimeout: null };
        entry.botTimeout = setTimeout(() => {
          if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
            waitingPlayer = null;
            const bot = {
              socket: null,
              user: { id: null, username: randomBotName() },
              isBot: true,
            };
            startGame(io, entry, bot);
          }
        }, BOT_MATCH_TIMEOUT_MS);

        waitingPlayer = entry;
        socket.emit('queued');
      }
    });

    socket.on('cancelFindMatch', () => {
      if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
        clearBotTimeout(waitingPlayer);
        waitingPlayer = null;
      }
    });


    // --- Making a move ---
    socket.on('move', ({ gameId, from, to, promotion }) => {
      const state = games.get(gameId);
      if (!state) return socket.emit('errorMsg', 'Game not found');

      const isWhite = state.white.socket && state.white.socket.id === socket.id;
      const isBlack = state.black.socket && state.black.socket.id === socket.id;
      if (!isWhite && !isBlack) return;

      const myColor = isWhite ? 'w' : 'b';
      if (state.chess.turn() !== myColor) {
        return socket.emit('errorMsg', 'Not your turn');
      }

      let moveResult;
      try {
        moveResult = state.chess.move({ from, to, promotion: promotion || 'q' });
      } catch (e) {
        moveResult = null;
      }

      if (!moveResult) {
        return socket.emit('errorMsg', 'Illegal move');
      }

      state.turn = state.chess.turn();

      io.to(gameId).emit('boardUpdate', {
        fen: state.chess.fen(),
        lastMove: { from, to },
        turn: state.turn,
        san: moveResult.san,
      });

      if (!checkForcedGameEnd(io, gameId, state.chess, state.turn)) {
        // Let the bot reply if it's now the bot's turn
        maybeTriggerBotMove(io, gameId);
      }
    });

    socket.on('chatMessage', ({ gameId, text }) => {
      const state = games.get(gameId);
      if (!state || !authedUser) return;
      const clean = String(text || '').trim().slice(0, 200);
      if (!clean) return;

      io.to(gameId).emit('chatMessage', { username: authedUser.username, text: clean });

      // Bots can't really read chat, but a reply that at least matches
      // greetings and Hindi-vs-English keeps it from feeling like the bot
      // is ignoring what you actually said.
      const botSide = state.white.isBot ? state.white : (state.black.isBot ? state.black : null);
      if (botSide) {
        setTimeout(() => {
          if (!games.has(gameId)) return;
          const reply = chooseBotReply(clean);
          io.to(gameId).emit('chatMessage', { username: botSide.user.username, text: reply });
        }, 900 + Math.random() * 1200);
      }
    });

    socket.on('resign', ({ gameId }) => {
      const state = games.get(gameId);
      if (!state) return;
      const isWhite = state.white.socket && state.white.socket.id === socket.id;
      const winnerColor = isWhite ? 'black' : 'white';
      endGame(io, gameId, winnerColor, 'Resignation');
    });

    socket.on('offerDraw', ({ gameId }) => {
      const state = games.get(gameId);
      if (!state) return;
      const isWhite = state.white.socket && state.white.socket.id === socket.id;
      const isBlack = state.black.socket && state.black.socket.id === socket.id;
      if (!isWhite && !isBlack) return;

      // A bot opponent can just auto-accept immediately rather than leaving
      // the human waiting on a reply that will never come.
      if (state.white.isBot || state.black.isBot) {
        endGame(io, gameId, 'draw', 'Draw agreed');
        return;
      }
      socket.to(gameId).emit('drawOffered');
    });

    socket.on('acceptDraw', ({ gameId }) => {
      const state = games.get(gameId);
      if (!state) return;
      endGame(io, gameId, 'draw', 'Draw agreed');
    });

    socket.on('disconnect', () => {
      if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
        clearBotTimeout(waitingPlayer);
        waitingPlayer = null;
      }
      // Find any active game this socket was part of and end it as a resignation
      for (const [gameId, state] of games.entries()) {
        if (state.white.socket && state.white.socket.id === socket.id) {
          endGame(io, gameId, 'black', 'Opponent disconnected');
        } else if (state.black.socket && state.black.socket.id === socket.id) {
          endGame(io, gameId, 'white', 'Opponent disconnected');
        }
      }
    });
  });
}

// Ends the game automatically only for outcomes that are truly forced —
// checkmate, stalemate, or insufficient material (the position literally
// cannot continue). Threefold repetition and the 50-move rule are, per FIDE
// rules, *claimable* rather than automatic, so a long game that hits either
// of those keeps going — a player has to actually offer/accept a draw
// (see 'offerDraw'/'acceptDraw' below) for the game to end that way.
function checkForcedGameEnd(io, gameId, chess, turnAfterMove) {
  if (chess.isCheckmate()) {
    const winnerColor = turnAfterMove === 'w' ? 'black' : 'white'; // side to move just got mated
    endGame(io, gameId, winnerColor, 'Checkmate');
    return true;
  }
  if (chess.isStalemate()) {
    endGame(io, gameId, 'draw', 'Stalemate');
    return true;
  }
  if (chess.isInsufficientMaterial()) {
    endGame(io, gameId, 'draw', 'Insufficient material');
    return true;
  }
  return false;
}

async function endGame(io, gameId, result, reason) {
  const state = games.get(gameId);
  if (!state) return;
  games.delete(gameId);

  const isDraw = result === 'draw';
  const winnerId = result === 'white' ? state.white.user.id : (result === 'black' ? state.black.user.id : null);
  const loserId = result === 'white' ? state.black.user.id : (result === 'black' ? state.white.user.id : null);

  try {
    // white_id/black_id are nullable, so a bot opponent (id: null) is fine here.
    await run(
      'INSERT INTO games (white_id, black_id, result, pgn) VALUES (?, ?, ?, ?)',
      [state.white.user.id, state.black.user.id, result, state.chess.pgn()]
    );
    // Elo only changes for real accounts; applyEloUpdate silently skips null ids,
    // so playing (and beating) the bot never grants or costs rating points.
    if (!isDraw) await applyEloUpdate(winnerId, loserId, isDraw);
  } catch (e) {
    console.error('Error saving game result', e);
  }

  const whiteEloRow = state.white.user.id ? await get('SELECT elo FROM users WHERE id = ?', [state.white.user.id]) : null;
  const blackEloRow = state.black.user.id ? await get('SELECT elo FROM users WHERE id = ?', [state.black.user.id]) : null;

  io.to(gameId).emit('gameOver', {
    result,
    reason,
    whiteElo: whiteEloRow ? whiteEloRow.elo : null,
    blackElo: blackEloRow ? blackEloRow.elo : null,
  });
}

module.exports = { initSocket };
