// client/app.js
// MYTHIC CHESS — vanilla JS frontend. No frameworks.
// Handles: auth, view routing, live game board, puzzle board, leaderboard, sockets.

const API_BASE = '/api';

// Piece images: using the "cburnett" set (CC-BY-SA, the same family of
// piece art used by lichess and many open chess UIs) served via jsDelivr,
// since chess.com's own piece art is proprietary and can't be copied.
const PIECE_CDN = 'https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/cburnett/';
const PIECE_FILES = {
  p: 'bP.svg', n: 'bN.svg', b: 'bB.svg', r: 'bR.svg', q: 'bQ.svg', k: 'bK.svg',
  P: 'wP.svg', N: 'wN.svg', B: 'wB.svg', R: 'wR.svg', Q: 'wQ.svg', K: 'wK.svg',
};

// ---------- PWA install prompt ----------
let deferredInstallPrompt = null;
const installBtn = document.getElementById('installBtn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  installBtn.classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Non-fatal: app still works fully without offline support.
    });
  });
}

// ---------- App state ----------
const state = {
  token: localStorage.getItem('mc_token') || null,
  user: JSON.parse(localStorage.getItem('mc_user') || 'null'),
  socket: null,
  game: {
    gameId: null,
    color: null, // 'w' or 'b'
    fen: 'start',
    selected: null,
    legalTargets: [],
    legalCaptures: [],
    lastMove: null,
    manualFlip: false,
  },
  puzzle: {
    current: null,
    fen: null,
    selected: null,
    lastMove: null,
  },
};

// ---------- Helpers ----------
function authHeaders() {
  return state.token ? { 'Authorization': `Bearer ${state.token}` } : {};
}

async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('mc_token', token);
  localStorage.setItem('mc_user', JSON.stringify(user));
}

function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('mc_token');
  localStorage.removeItem('mc_user');
}

// ---------- View routing ----------
const views = ['auth', 'lobby', 'play', 'puzzles', 'rush', 'coach', 'leaderboard'];
function showView(name) {
  views.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'lobby') refreshLobbyStats();
  if (name === 'puzzles' && !state.puzzle.current) loadNewPuzzle();
}

document.getElementById('navTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  if (!state.token) return; // must be logged in to navigate
  showView(btn.dataset.view);
});

// ---------- Auth UI ----------
const nameForm = document.getElementById('nameForm');

nameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('nameInput').value.trim();
  const msg = document.getElementById('nameMsg');
  try {
    const data = await apiFetch('/auth/identify', { method: 'POST', body: JSON.stringify({ name }) });
    saveSession(data.token, data.user);
    onLoginSuccess();
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  if (!confirm('Change your name? You\'ll start fresh at 0 Elo and lose your current puzzle progress on this device.')) return;
  clearSession();
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  updateAccountUI();
  document.getElementById('nameInput').value = '';
  showView('auth');
});

function updateAccountUI() {
  const userInfo = document.getElementById('userInfo');
  const logoutBtn = document.getElementById('logoutBtn');
  if (state.user) {
    userInfo.textContent = `${state.user.username} · ${state.user.elo} Elo`;
    userInfo.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
  } else {
    userInfo.classList.add('hidden');
    logoutBtn.classList.add('hidden');
  }
}

function onLoginSuccess() {
  updateAccountUI();
  connectSocket();
  document.getElementById('lobbyUsername').textContent = state.user.username;
  document.getElementById('lobbyElo').textContent = state.user.elo;
  showView('lobby');
}

// Auto-login if token present
if (state.token && state.user) {
  onLoginSuccess();
} else {
  showView('auth');
}
updateAccountUI();

// ---------- Lobby ----------
async function refreshLobbyStats() {
  try {
    const me = await apiFetch('/auth/me');
    state.user.elo = me.user.elo;
    localStorage.setItem('mc_user', JSON.stringify(state.user));
    document.getElementById('lobbyElo').textContent = me.user.elo;
    document.getElementById('statElo').textContent = me.user.elo;
    document.getElementById('statStreak').textContent = me.user.streak;
    updateAccountUI();
  } catch (e) { /* ignore */ }
  try {
    const stats = await apiFetch('/puzzles/stats/me');
    document.getElementById('statSolved').textContent = stats.solved;
    document.getElementById('puzzleSolvedCount').textContent = stats.solved;
  } catch (e) { /* ignore */ }
}

document.getElementById('goPlayBtn').addEventListener('click', () => showView('play'));
document.getElementById('goPuzzleBtn').addEventListener('click', () => showView('puzzles'));

// ---------- Coach guided lesson carousel ----------
const COACH_STEPS = [
  { label: 'Opening — Tip 1', text: 'Control the center with a pawn (e4/d4/e5/d5) in your first few moves.' },
  { label: 'Opening — Tip 2', text: 'Develop knights before bishops — they have fewer good squares.' },
  { label: 'Opening — Tip 3', text: 'Castle early, usually within your first 6–8 moves.' },
  { label: 'Opening — Tip 4', text: "Don't move the same piece twice before finishing development." },
  { label: 'Tactics — Tip 1', text: 'Before every move, check: does this hang a piece?' },
  { label: 'Tactics — Tip 2', text: "Look for forks, pins, and skewers on your opponent's last move." },
  { label: 'Tactics — Tip 3', text: 'A piece that attacks two things at once is usually winning material.' },
  { label: 'Tactics — Tip 4', text: 'Practice daily in the Puzzles tab — pattern recognition compounds fast.' },
  { label: 'Endgame — Tip 1', text: 'King activity matters most once queens are off the board.' },
  { label: 'Endgame — Tip 2', text: 'Push passed pawns — they only get more dangerous with fewer pieces on the board.' },
  { label: 'Endgame — Tip 3', text: 'In king + pawn endings, opposition (facing kings with one square between) is key.' },
  { label: 'Endgame — Tip 4', text: "Rooks belong behind passed pawns — yours or your opponent's." },
  { label: 'Mindset — Tip 1', text: 'Slow down in critical positions — most blunders happen on "quick" moves.' },
  { label: 'Mindset — Tip 2', text: 'Review your losses. Losses teach more than wins.' },
  { label: 'Mindset — Tip 3', text: 'A daily streak beats a single long session — consistency builds intuition.' },
  { label: 'Mindset — Tip 4', text: "It's fine to lose to the practice bot — that's what it's there for." },
];
let coachIndex = 0;

function renderCoachStep() {
  const step = COACH_STEPS[coachIndex];
  document.getElementById('coachStepLabel').textContent = step.label;
  document.getElementById('coachStepText').textContent = step.text;
  document.getElementById('coachProgress').textContent = `${coachIndex + 1} / ${COACH_STEPS.length}`;
}
document.getElementById('coachPrevBtn').addEventListener('click', () => {
  coachIndex = (coachIndex - 1 + COACH_STEPS.length) % COACH_STEPS.length;
  renderCoachStep();
});
document.getElementById('coachNextBtn').addEventListener('click', () => {
  coachIndex = (coachIndex + 1) % COACH_STEPS.length;
  renderCoachStep();
});
renderCoachStep();

// ---------- Leaderboard ----------
async function loadLeaderboard() {
  const body = document.getElementById('leaderboardBody');
  body.innerHTML = '<tr><td colspan="3">Loading...</td></tr>';
  try {
    const data = await apiFetch('/auth/leaderboard');
    body.innerHTML = '';
    data.leaderboard.forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(row.username)}</td><td class="gold-text">${row.elo}</td>`;
      body.appendChild(tr);
    });
    if (data.leaderboard.length === 0) {
      body.innerHTML = '<tr><td colspan="3">No champions yet — be the first!</td></tr>';
    }
  } catch (e) {
    body.innerHTML = '<tr><td colspan="3">Failed to load leaderboard.</td></tr>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==========================================================
// FEN PARSING + BOARD RENDERING (shared by Play & Puzzle boards)
// ==========================================================

function parseFen(fen) {
  const boardPart = fen.split(' ')[0];
  const rows = boardPart.split('/');
  const grid = []; // grid[0] = rank 8 ... grid[7] = rank 1
  for (const row of rows) {
    const cells = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < parseInt(ch, 10); i++) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    grid.push(cells);
  }
  return grid;
}

function squareName(fileIdx, rankIdx, flipped) {
  // fileIdx/rankIdx are 0-7 as displayed (0,0 = top-left of DOM)
  const file = flipped ? 7 - fileIdx : fileIdx;
  const rank = flipped ? rankIdx : 7 - rankIdx;
  return String.fromCharCode(97 + file) + (rank + 1);
}

/**
 * Renders a board into containerEl based on fen.
 * flipped: true if black is at the bottom (viewer plays black)
 * onSquareClick(squareName): callback for click interaction
 */
function renderBoard(containerEl, fen, flipped, options = {}) {
  const { selected, legalTargets = [], legalCaptures = [], lastMove, checkSquare } = options;
  const grid = parseFen(fen);
  containerEl.innerHTML = '';

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const displayRank = r;
      const displayFile = f;
      const sq = squareName(displayFile, displayRank, flipped);

      const gridRank = flipped ? 7 - displayRank : displayRank;
      const gridFile = flipped ? 7 - displayFile : displayFile;
      const piece = grid[gridRank][gridFile];

      const isLight = (gridRank + gridFile) % 2 === 0;
      const div = document.createElement('div');
      div.className = `square ${isLight ? 'light' : 'dark'}`;
      div.dataset.square = sq;

      if (selected === sq) div.classList.add('selected');
      if (legalCaptures.includes(sq)) div.classList.add('legal-capture');
      else if (legalTargets.includes(sq)) div.classList.add('legal-move');
      if (lastMove && (lastMove.from === sq || lastMove.to === sq)) div.classList.add('last-move');
      if (checkSquare && checkSquare === sq) div.classList.add('in-check');

      // Coordinate labels along the edge, like chess.com
      if (displayFile === 0) {
        const rankLabel = document.createElement('span');
        rankLabel.className = 'board-coord rank';
        rankLabel.textContent = flipped ? String(displayRank + 1) : String(8 - displayRank);
        div.appendChild(rankLabel);
      }
      if (displayRank === 7) {
        const fileLabel = document.createElement('span');
        fileLabel.className = 'board-coord file';
        fileLabel.textContent = String.fromCharCode(97 + (flipped ? 7 - displayFile : displayFile));
        div.appendChild(fileLabel);
      }

      if (piece) {
        const img = document.createElement('img');
        img.className = 'piece';
        img.draggable = false;
        img.alt = piece;
        img.src = PIECE_CDN + (PIECE_FILES[piece] || '');
        img.onerror = () => {
          // CDN unreachable -> fall back to a plain letter so the board
          // still functions instead of showing broken image icons.
          img.replaceWith(Object.assign(document.createElement('span'), {
            className: 'piece piece-fallback',
            textContent: piece,
          }));
        };
        div.appendChild(img);
      }

      containerEl.appendChild(div);
    }
  }
}

// Finds which square the side-to-move's king sits on, given a FEN, so we
// can highlight it when in check. Pure string parsing — no chess logic.
function findKingSquare(fen, color) {
  const grid = parseFen(fen);
  const target = color === 'w' ? 'K' : 'k';
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      if (grid[rank][file] === target) {
        return String.fromCharCode(97 + file) + (8 - rank);
      }
    }
  }
  return null;
}

// Tallies captured material from a FEN by comparing piece counts to a
// full starting set, so we can show captured-piece rows + material edge.
const FULL_SET = { p: 8, n: 2, b: 2, r: 2, q: 1 };
function computeCaptured(fen) {
  const grid = parseFen(fen);
  const counts = { p: 0, n: 0, b: 0, r: 0, q: 0, P: 0, N: 0, B: 0, R: 0, Q: 0 };
  for (const row of grid) for (const cell of row) if (cell && counts[cell] !== undefined) counts[cell]++;

  const capturedByWhite = []; // black pieces White has captured
  const capturedByBlack = []; // white pieces Black has captured
  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let whiteValue = 0, blackValue = 0;

  for (const type of ['p', 'n', 'b', 'r', 'q']) {
    const blackMissing = FULL_SET[type] - counts[type];
    const whiteMissing = FULL_SET[type] - counts[type.toUpperCase()];
    for (let i = 0; i < blackMissing; i++) { capturedByWhite.push(type); whiteValue += VALUES[type]; }
    for (let i = 0; i < whiteMissing; i++) { capturedByBlack.push(type.toUpperCase()); blackValue += VALUES[type]; }
  }
  return { capturedByWhite, capturedByBlack, advantage: whiteValue - blackValue };
}

function renderCapturedRow(el, pieces, advantageText) {
  el.innerHTML = '';
  pieces.forEach((p) => {
    const img = document.createElement('img');
    img.src = PIECE_CDN + (PIECE_FILES[p] || '');
    img.alt = p;
    img.onerror = () => img.remove();
    el.appendChild(img);
  });
  if (advantageText) {
    const span = document.createElement('span');
    span.className = 'captured-advantage';
    span.textContent = advantageText;
    el.appendChild(span);
  }
}

// ---------- Sound effects (Web Audio, no external files needed) ----------
let soundEnabled = true;
let audioCtx = null;
function playTone(freq, duration, type = 'sine', gain = 0.15) {
  if (!soundEnabled) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start();
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) { /* audio unsupported, fail silently */ }
}
function playSound(kind) {
  if (kind === 'move') playTone(440, 0.09, 'triangle', 0.12);
  else if (kind === 'capture') playTone(300, 0.12, 'square', 0.1);
  else if (kind === 'check') { playTone(660, 0.1, 'sawtooth', 0.12); setTimeout(() => playTone(880, 0.12, 'sawtooth', 0.1), 90); }
  else if (kind === 'start') playTone(520, 0.15, 'sine', 0.1);
  else if (kind === 'end') { playTone(392, 0.15, 'sine', 0.12); setTimeout(() => playTone(262, 0.25, 'sine', 0.12), 150); }
}

document.getElementById('soundToggleBtn').addEventListener('click', (e) => {
  soundEnabled = !soundEnabled;
  e.target.textContent = soundEnabled ? '🔊 Sound' : '🔇 Muted';
});

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ==========================================================
// SOCKET.IO — connection + live game
// ==========================================================

function connectSocket() {
  if (state.socket) return;
  state.socket = io();

  state.socket.on('connect', () => {
    state.socket.emit('auth', state.token);
  });

  state.socket.on('authError', () => {
    clearSession();
    updateAccountUI();
    showView('auth');
  });

  state.socket.on('queued', () => {
    setMatchStatus('Searching for an opponent...');
    document.getElementById('findMatchBtn').classList.add('hidden');
    document.getElementById('cancelFindBtn').classList.remove('hidden');
  });

  state.socket.on('matchFound', (payload) => {
    state.game.gameId = payload.gameId;
    state.game.color = payload.color;
    state.game.fen = payload.fen;
    state.game.selected = null;
    state.game.legalTargets = [];
    state.game.lastMove = null;
    state.game.manualFlip = false;

    const youAreWhite = payload.color === 'w';
    document.getElementById('topPlayerName').textContent = youAreWhite ? payload.black.username : payload.white.username;
    document.getElementById('bottomPlayerName').textContent = youAreWhite ? payload.white.username : payload.black.username;

    setMatchStatus(`Game started! You are playing ${youAreWhite ? 'White' : 'Black'}.`);
    document.getElementById('moveLog').innerHTML = '';
    document.getElementById('chatLog').innerHTML = '';

    document.getElementById('findMatchBtn').classList.add('hidden');
    document.getElementById('cancelFindBtn').classList.add('hidden');
    document.getElementById('resignBtn').classList.remove('hidden');
    document.getElementById('offerDrawBtn').classList.remove('hidden');

    playSound('start');
    updateCapturedDisplay();
    drawPlayBoard();
  });

  state.socket.on('boardUpdate', (payload) => {
    const wasCapture = payload.san && payload.san.includes('x');
    state.game.fen = payload.fen;
    state.game.lastMove = payload.lastMove;
    state.game.selected = null;
    state.game.legalTargets = [];
    appendMoveLog(payload.san);
    updateCapturedDisplay();

    const isCheck = payload.san && payload.san.includes('+');
    const isMate = payload.san && payload.san.includes('#');
    if (isMate) playSound('end');
    else if (isCheck) playSound('check');
    else if (wasCapture) playSound('capture');
    else playSound('move');

    drawPlayBoard();
    if (payload.lastMove) {
      animateSlide(document.getElementById('chessboard'), payload.lastMove.from, payload.lastMove.to, isBoardFlipped());
    }
  });

  state.socket.on('errorMsg', (msg) => {
    setMatchStatus('⚠ ' + msg);
    if (msg === 'Game not found') {
      // Server lost this game's memory (e.g. it restarted). Reset the
      // board back to a clean "ready to search" state instead of leaving
      // a frozen, unusable board on screen.
      state.game.gameId = null;
      state.game.color = null;
      state.game.fen = 'start';
      state.game.selected = null;
      state.game.lastMove = null;
      document.getElementById('resignBtn').classList.add('hidden');
      document.getElementById('offerDrawBtn').classList.add('hidden');
      document.getElementById('findMatchBtn').classList.remove('hidden');
      document.getElementById('cancelFindBtn').classList.add('hidden');
      document.getElementById('topPlayerName').textContent = 'Opponent';
      document.getElementById('bottomPlayerName').textContent = 'You';
      setMatchStatus('⚠ Connection reset — please press "Find Match" again.');
      drawPlayBoard();
    }
  });

  state.socket.on('gameOver', (payload) => showGameOverModal(payload));

  state.socket.on('drawOffered', () => {
    if (!state.game.gameId) return;
    if (confirm('Your opponent is offering a draw. Accept?')) {
      state.socket.emit('acceptDraw', { gameId: state.game.gameId });
    } else {
      setMatchStatus('Draw offer declined.');
    }
  });

  state.socket.on('chatMessage', ({ username, text }) => appendChatLine(username, text));
}

function appendChatLine(username, text) {
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = 'chat-line';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'chat-name';
  nameSpan.textContent = username + ': ';
  div.appendChild(nameSpan);
  div.appendChild(document.createTextNode(text));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

document.getElementById('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !state.game.gameId || !state.socket) return;
  state.socket.emit('chatMessage', { gameId: state.game.gameId, text });
  // Not appending locally here: the server echoes every chatMessage back
  // to the whole room, sender included, so appending here too would show
  // your own message twice.
  input.value = '';
});

function setMatchStatus(text) {
  const el = document.getElementById('matchStatus');
  if (el) el.textContent = text;
}

function appendMoveLog(san) {
  if (!san) return;
  const log = document.getElementById('moveLog');
  const li = document.createElement('li');
  li.textContent = san;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function showGameOverModal(payload) {
  document.getElementById('resignBtn').classList.add('hidden');
  document.getElementById('offerDrawBtn').classList.add('hidden');
  document.getElementById('findMatchBtn').classList.remove('hidden');
  document.getElementById('cancelFindBtn').classList.add('hidden');
  playSound('end');

  const title = payload.result === 'draw' ? 'Draw!' : (isMyWin(payload.result) ? 'Victory!' : 'Defeat');
  document.getElementById('gameOverTitle').textContent = title;
  document.getElementById('gameOverReason').textContent = payload.reason || '';
  const whiteEloText = payload.whiteElo != null ? `${payload.whiteElo} Elo` : 'unrated';
  const blackEloText = payload.blackElo != null ? `${payload.blackElo} Elo` : 'unrated';
  document.getElementById('gameOverElo').textContent =
    `White: ${whiteEloText}   ·   Black: ${blackEloText}`;
  document.getElementById('gameOverModal').classList.remove('hidden');
  setMatchStatus('Game finished. Press "Find Match" to play again.');
}

function isMyWin(result) {
  return (result === 'white' && state.game.color === 'w') || (result === 'black' && state.game.color === 'b');
}

document.getElementById('closeModalBtn').addEventListener('click', () => {
  document.getElementById('gameOverModal').classList.add('hidden');
});

// ---------- Play controls ----------
document.getElementById('findMatchBtn').addEventListener('click', () => {
  if (!state.socket) return;
  state.socket.emit('findMatch');
});
document.getElementById('cancelFindBtn').addEventListener('click', () => {
  if (!state.socket) return;
  state.socket.emit('cancelFindMatch');
  document.getElementById('findMatchBtn').classList.remove('hidden');
  document.getElementById('cancelFindBtn').classList.add('hidden');
  setMatchStatus('Search cancelled.');
});
document.getElementById('resignBtn').addEventListener('click', () => {
  if (!state.game.gameId) return;
  state.socket.emit('resign', { gameId: state.game.gameId });
});
document.getElementById('offerDrawBtn').addEventListener('click', () => {
  if (!state.game.gameId) return;
  state.socket.emit('offerDraw', { gameId: state.game.gameId });
  setMatchStatus('Draw offer sent.');
});

// ---------- Play board rendering + click-to-move ----------
function updateCapturedDisplay() {
  const fen = state.game.fen === 'start' ? STARTING_FEN : state.game.fen;
  const { capturedByWhite, capturedByBlack, advantage } = computeCaptured(fen);
  const youAreWhite = state.game.color !== 'b';
  const topPieces = youAreWhite ? capturedByBlack : capturedByWhite;
  const bottomPieces = youAreWhite ? capturedByWhite : capturedByBlack;
  const topAdv = (youAreWhite ? -advantage : advantage) > 0 ? `+${Math.abs(advantage)}` : '';
  const bottomAdv = (youAreWhite ? advantage : -advantage) > 0 ? `+${Math.abs(advantage)}` : '';
  renderCapturedRow(document.getElementById('topCaptured'), topPieces, topAdv);
  renderCapturedRow(document.getElementById('bottomCaptured'), bottomPieces, bottomAdv);
}

function isBoardFlipped() {
  const base = state.game.color === 'b';
  return state.game.manualFlip ? !base : base;
}

function drawPlayBoard() {
  const container = document.getElementById('chessboard');
  const fen = state.game.fen === 'start' ? STARTING_FEN : state.game.fen;
  const flipped = isBoardFlipped();

  let checkSquare = null;
  if (window.Chess) {
    try {
      const c = new Chess(fen);
      if (c.in_check && c.in_check()) checkSquare = findKingSquare(fen, c.turn());
    } catch (e) { /* ignore parse issues, just skip check highlight */ }
  }

  renderBoard(container, fen, flipped, {
    selected: state.game.selected,
    legalTargets: state.game.legalTargets,
    legalCaptures: state.game.legalCaptures || [],
    lastMove: state.game.lastMove,
    checkSquare,
  });
}

document.getElementById('flipBoardBtn').addEventListener('click', () => {
  state.game.manualFlip = !state.game.manualFlip;
  drawPlayBoard();
});

// Compute legal destination squares for a clicked piece, purely for
// visual hints — the server is still the sole authority on legality.
function computeLegalTargets(sq) {
  if (!window.Chess) return { targets: [], captures: [] };
  try {
    const c = new Chess(state.game.fen === 'start' ? STARTING_FEN : state.game.fen);
    const moves = c.moves({ square: sq, verbose: true });
    return {
      targets: moves.map(m => m.to),
      captures: moves.filter(m => m.flags.includes('c') || m.flags.includes('e')).map(m => m.to),
    };
  } catch (e) {
    return { targets: [], captures: [] };
  }
}

function isPromotionMove(from, to) {
  const fen = state.game.fen === 'start' ? STARTING_FEN : state.game.fen;
  const grid = parseFen(fen);
  const fromFile = from.charCodeAt(0) - 97;
  const fromRank = 8 - parseInt(from[1], 10);
  const piece = grid[fromRank] && grid[fromRank][fromFile];
  if (!piece || piece.toLowerCase() !== 'p') return false;
  const toRank = to[1];
  return toRank === '8' || toRank === '1';
}

function showPromotionPicker(from, to, onPick) {
  const isWhite = state.game.color !== 'b';
  const pieces = isWhite ? ['Q', 'R', 'B', 'N'] : ['q', 'r', 'b', 'n'];
  const overlay = document.createElement('div');
  overlay.className = 'promotion-overlay';
  const box = document.createElement('div');
  box.className = 'promotion-box';
  pieces.forEach((p) => {
    const btn = document.createElement('button');
    const img = document.createElement('img');
    img.src = PIECE_CDN + (PIECE_FILES[p] || '');
    img.alt = p;
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      overlay.remove();
      onPick(p.toLowerCase());
    });
    box.appendChild(btn);
  });
  overlay.appendChild(box);
  document.querySelector('#chessboard').parentElement.style.position = 'relative';
  document.querySelector('#chessboard').parentElement.appendChild(overlay);
}

// ==========================================================
// SHARED BOARD INTERACTION: click-to-move AND real drag-and-drop,
// unified via the Pointer Events API (works for mouse, touch, and pen).
// ==========================================================
function squareToXY(sq, flipped) {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const x = flipped ? 7 - file : file;
  const y = flipped ? rank : 7 - rank;
  return { x, y };
}

// Smoothly slides the piece that just landed on `toSq` in from `fromSq`'s
// direction (a lightweight FLIP animation) instead of it just popping in.
function animateSlide(containerEl, fromSq, toSq, flipped) {
  const toEl = containerEl.querySelector(`.square[data-square="${toSq}"] .piece`);
  if (!toEl || !fromSq) return;
  const squareSize = containerEl.clientWidth / 8;
  const fromCoord = squareToXY(fromSq, flipped);
  const toCoord = squareToXY(toSq, flipped);
  const dx = (fromCoord.x - toCoord.x) * squareSize;
  const dy = (fromCoord.y - toCoord.y) * squareSize;
  toEl.style.transition = 'none';
  toEl.style.transform = `translate(${dx}px, ${dy}px)`;
  requestAnimationFrame(() => {
    toEl.style.transition = 'transform 0.18s ease';
    toEl.style.transform = 'translate(0,0)';
  });
}

/**
 * Wires up a board container for both click-to-move and drag-and-drop.
 * `hooks` = {
 *   canInteract(): bool,
 *   getSelected(): string|null, setSelected(sq),
 *   redraw(): void,
 *   onDrop(from, to): void   // called on a completed move attempt
 * }
 */
function setupBoardInteraction(containerEl, hooks) {
  let drag = null; // { fromSq, startX, startY, moved, ghost, reselect }

  function squareAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const sqEl = el && el.closest('.square');
    return sqEl ? sqEl.dataset.square : null;
  }

  function selectSquare(sq) {
    hooks.setSelected(sq);
    hooks.redraw();
  }

  function attemptMove(from, to) {
    hooks.setSelected(null);
    hooks.onDrop(from, to);
  }

  containerEl.addEventListener('pointerdown', (e) => {
    if (!hooks.canInteract()) return;
    const sqEl = e.target.closest('.square');
    if (!sqEl) return;
    const sq = sqEl.dataset.square;
    const pieceImg = sqEl.querySelector('.piece');
    const alreadySelected = hooks.getSelected();

    if (alreadySelected && alreadySelected !== sq) {
      // A piece was already selected from a prior tap -> this press on a
      // different square (empty, or an opponent's piece to capture) is
      // the completing half of a two-tap move. Fire immediately; no drag
      // tracking needed for this path.
      attemptMove(alreadySelected, sq);
      return;
    }

    if (!pieceImg) return; // nothing selected, tapped an empty square: no-op

    // Either starting a brand-new selection, or pressing down again on the
    // square that's already selected (which a plain tap should toggle off,
    // but which we still want to allow dragging from).
    drag = { fromSq: sq, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, pieceSrc: pieceImg.src, reselect: alreadySelected === sq };
    if (!alreadySelected) selectSquare(sq); // only (re)draw highlights on a fresh selection
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* not all targets support this */ }
  });

  containerEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      drag.ghost = document.createElement('img');
      drag.ghost.src = drag.pieceSrc;
      drag.ghost.className = 'piece drag-ghost';
      document.body.appendChild(drag.ghost);
    }
    if (drag.moved && drag.ghost) {
      const size = containerEl.getBoundingClientRect().width / 8;
      drag.ghost.style.width = size + 'px';
      drag.ghost.style.height = size + 'px';
      drag.ghost.style.left = (e.clientX - size / 2) + 'px';
      drag.ghost.style.top = (e.clientY - size / 2) + 'px';
    }
  });

  function endDrag(e) {
    if (!drag) return;
    const wasDrag = drag.moved;
    const fromSq = drag.fromSq;
    const wasReselectPress = drag.reselect;
    if (drag.ghost) drag.ghost.remove();
    const dropSq = wasDrag ? squareAtPoint(e.clientX, e.clientY) : null;
    drag = null;

    if (wasDrag && dropSq && dropSq !== fromSq) {
      attemptMove(fromSq, dropSq);
    } else if (!wasDrag && wasReselectPress) {
      // A plain second tap on the already-selected square -> deselect it.
      hooks.setSelected(null);
      hooks.redraw();
    }
    // Otherwise: this was either the very first tap that just started a
    // fresh selection (leave it selected and wait for the next tap), or a
    // drag that ended back on its own square (also leave it selected).
  }
  containerEl.addEventListener('pointerup', endDrag);
  containerEl.addEventListener('pointercancel', endDrag);
}

// ---------- Board zoom (shared) ----------
function applyZoom(frameEl, deltaPx) {
  const current = parseInt(frameEl.dataset.size || '560', 10);
  const next = Math.max(320, Math.min(720, current + deltaPx));
  frameEl.dataset.size = next;
  const boardEl = frameEl.querySelector('.chessboard');
  if (boardEl) {
    boardEl.style.width = `min(${next}px, 92vw)`;
    boardEl.style.height = `min(${next}px, 92vw)`;
  }
}

setupBoardInteraction(document.getElementById('chessboard'), {
  canInteract: () => !!state.game.gameId,
  getSelected: () => state.game.selected,
  setSelected: (sq) => {
    state.game.selected = sq;
    if (sq) {
      const { targets, captures } = computeLegalTargets(sq);
      state.game.legalTargets = targets;
      state.game.legalCaptures = captures;
    } else {
      state.game.legalTargets = [];
      state.game.legalCaptures = [];
    }
  },
  redraw: drawPlayBoard,
  onDrop: (from, to) => {
    const sendMove = (promotion) => {
      state.socket.emit('move', { gameId: state.game.gameId, from, to, promotion: promotion || 'q' });
      drawPlayBoard();
    };
    if (isPromotionMove(from, to)) { drawPlayBoard(); showPromotionPicker(from, to, sendMove); }
    else sendMove('q');
  },
});

document.getElementById('zoomInBtn').addEventListener('click', () => applyZoom(document.querySelector('#view-play .board-frame'), 40));
document.getElementById('zoomOutBtn').addEventListener('click', () => applyZoom(document.querySelector('#view-play .board-frame'), -40));

// Draw an empty/starting board immediately so the Play tab isn't blank before a match
drawPlayBoard();

// ==========================================================
// PUZZLE MODE
// ==========================================================

async function loadNewPuzzle() {
  document.getElementById('puzzleFeedback').textContent = '';
  document.getElementById('puzzleHint').classList.add('hidden');
  try {
    const data = await apiFetch('/puzzles');
    state.puzzle.current = data.puzzle;
    state.puzzle.fen = data.puzzle.fen;
    state.puzzle.selected = null;
    state.puzzle.lastMove = null;
    document.getElementById('puzzleTitle').textContent = data.puzzle.title;
    document.getElementById('puzzleRating').textContent = data.puzzle.rating;
    document.getElementById('puzzleHint').textContent = data.puzzle.hint;
    drawPuzzleBoard();
  } catch (e) {
    document.getElementById('puzzleFeedback').textContent = 'Failed to load puzzle.';
  }
}

function drawPuzzleBoard() {
  const container = document.getElementById('puzzleBoard');
  renderBoard(container, state.puzzle.fen, false, {
    selected: state.puzzle.selected,
    legalTargets: [],
    lastMove: state.puzzle.lastMove,
  });
}

async function attemptPuzzleMove(from, to) {
  try {
    const result = await apiFetch(`/puzzles/${state.puzzle.current.id}`, {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
    const feedback = document.getElementById('puzzleFeedback');
    if (result.correct) {
      feedback.textContent = '✓ Correct! Well played.';
      state.puzzle.lastMove = { from, to };
      refreshLobbyStats();
      playSound('capture');
    } else {
      feedback.textContent = '✗ Not quite — try again or view the hint.';
      playSound('move');
    }
    drawPuzzleBoard();
  } catch (err) {
    document.getElementById('puzzleFeedback').textContent = err.message;
  }
}

setupBoardInteraction(document.getElementById('puzzleBoard'), {
  canInteract: () => !!state.puzzle.current,
  getSelected: () => state.puzzle.selected,
  setSelected: (sq) => { state.puzzle.selected = sq; },
  redraw: drawPuzzleBoard,
  onDrop: (from, to) => attemptPuzzleMove(from, to),
});

document.getElementById('newPuzzleBtn').addEventListener('click', loadNewPuzzle);
document.getElementById('hintBtn').addEventListener('click', () => {
  document.getElementById('puzzleHint').classList.toggle('hidden');
});
document.getElementById('puzzleZoomInBtn').addEventListener('click', () => applyZoom(document.querySelector('#view-puzzles .board-frame'), 40));
document.getElementById('puzzleZoomOutBtn').addEventListener('click', () => applyZoom(document.querySelector('#view-puzzles .board-frame'), -40));

// ==========================================================
// PUZZLE RUSH — solve as many puzzles as possible in 3 minutes,
// ends early after 3 mistakes. Reuses the same puzzle API endpoints
// as normal Puzzle mode; no new server routes needed.
// ==========================================================
const RUSH_DURATION_S = 180;
const RUSH_MAX_MISTAKES = 3;
const rush = {
  active: false,
  timeLeft: RUSH_DURATION_S,
  solved: 0,
  mistakes: 0,
  current: null,
  fen: null,
  selected: null,
  lastMove: null,
  timerHandle: null,
};

function drawRushBoard() {
  const container = document.getElementById('rushBoard');
  renderBoard(container, rush.fen || STARTING_FEN, false, {
    selected: rush.selected,
    legalTargets: [],
    lastMove: rush.lastMove,
  });
}

function updateRushHud() {
  const m = Math.floor(rush.timeLeft / 60);
  const s = rush.timeLeft % 60;
  document.getElementById('rushTimer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
  document.getElementById('rushScore').textContent = rush.solved;
  document.getElementById('rushMistakes').textContent = `${rush.mistakes} / ${RUSH_MAX_MISTAKES}`;
}

async function rushLoadNext() {
  const data = await apiFetch('/puzzles');
  rush.current = data.puzzle;
  rush.fen = data.puzzle.fen;
  rush.selected = null;
  rush.lastMove = null;
  drawRushBoard();
}

async function startRush() {
  rush.active = true;
  rush.timeLeft = RUSH_DURATION_S;
  rush.solved = 0;
  rush.mistakes = 0;
  document.getElementById('rushFeedback').textContent = '';
  document.getElementById('rushStartBtn').textContent = '⏳ Rush in progress...';
  document.getElementById('rushStartBtn').disabled = true;
  updateRushHud();
  await rushLoadNext();
  playSound('start');

  rush.timerHandle = setInterval(() => {
    rush.timeLeft--;
    updateRushHud();
    if (rush.timeLeft <= 0) endRush('Time\'s up!');
  }, 1000);
}

function endRush(reason) {
  rush.active = false;
  clearInterval(rush.timerHandle);
  document.getElementById('rushStartBtn').textContent = '▶ Start Rush (3 min)';
  document.getElementById('rushStartBtn').disabled = false;
  document.getElementById('rushFeedback').textContent = `${reason} You solved ${rush.solved} puzzle${rush.solved === 1 ? '' : 's'}.`;
  playSound('end');
}

async function rushAttemptMove(from, to) {
  if (!rush.active || !rush.current) return;
  try {
    const result = await apiFetch(`/puzzles/${rush.current.id}`, {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
    if (result.correct) {
      rush.solved++;
      playSound('capture');
      updateRushHud();
      await rushLoadNext();
    } else {
      rush.mistakes++;
      playSound('move');
      updateRushHud();
      if (rush.mistakes >= RUSH_MAX_MISTAKES) {
        endRush('3 mistakes reached.');
      } else {
        rush.selected = null;
        drawRushBoard();
      }
    }
  } catch (err) {
    document.getElementById('rushFeedback').textContent = err.message;
  }
}

setupBoardInteraction(document.getElementById('rushBoard'), {
  canInteract: () => rush.active,
  getSelected: () => rush.selected,
  setSelected: (sq) => { rush.selected = sq; },
  redraw: drawRushBoard,
  onDrop: (from, to) => rushAttemptMove(from, to),
});

document.getElementById('rushStartBtn').addEventListener('click', startRush);
drawRushBoard();
