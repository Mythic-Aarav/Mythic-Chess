import { io } from 'socket.io-client';

async function identify(name) {
  const res = await fetch('http://localhost:3000/api/auth/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.token;
}

function log(who, ...args) { console.log(`[${who}]`, ...args); }

async function main() {
  const tokenA = await identify('TestAlice' + Date.now());
  const tokenB = await identify('TestBob' + Date.now());

  const a = io('http://localhost:3000');
  const b = io('http://localhost:3000');

  let gameId, aColor, bColor;
  let gameEndedEarly = false;
  let moveCount = 0;

  a.on('connect', () => a.emit('auth', tokenA));
  b.on('connect', () => b.emit('auth', tokenB));

  a.on('authOk', () => a.emit('findMatch'));
  b.on('authOk', () => setTimeout(() => b.emit('findMatch'), 300));

  a.on('queued', () => log('A', 'queued'));

  a.on('matchFound', (p) => { gameId = p.gameId; aColor = p.color; log('A', 'matched as', aColor); startRepetition(); });
  b.on('matchFound', (p) => { bColor = p.color; log('B', 'matched as', bColor); });

  a.on('boardUpdate', (u) => { moveCount++; log('A sees', u.san, 'fen', u.fen); });
  b.on('boardUpdate', (u) => log('B sees', u.san));

  a.on('gameOver', (p) => { log('A', '*** GAME OVER (unexpected if before draw-offer phase) ***', p); gameEndedEarly = true; });
  b.on('gameOver', (p) => { log('B', '*** GAME OVER ***', p); });

  a.on('errorMsg', (m) => log('A ERROR', m));
  b.on('errorMsg', (m) => log('B ERROR', m));

  b.on('drawOffered', () => {
    log('B', 'received draw offer -> accepting');
    b.emit('acceptDraw', { gameId });
  });

  // Knight shuffle to trigger threefold repetition of the starting position:
  // white Nf3/Ng1, black Nf6/Ng8, repeated.
  const cycle = [
    { mover: 'w', from: 'g1', to: 'f3' },
    { mover: 'b', from: 'g8', to: 'f6' },
    { mover: 'w', from: 'f3', to: 'g1' },
    { mover: 'b', from: 'f6', to: 'g8' }
  ];
  let full = [];
  for (let i = 0; i < 3; i++) full = full.concat(cycle); // 3 cycles -> position repeats 3+ times

  let idx = 0;
  function startRepetition() {
    setTimeout(playNext, 500);
  }
  function playNext() {
    if (idx >= full.length) {
      afterRepetition();
      return;
    }
    const mv = full[idx];
    const sock = (aColor === mv.mover) ? a : b;
    sock.emit('move', { gameId, from: mv.from, to: mv.to });
    idx++;
    setTimeout(playNext, 200);
  }

  function afterRepetition() {
    setTimeout(() => {
      log('TEST', `moveCount=${moveCount}, gameEndedEarly=${gameEndedEarly}`);
      if (gameEndedEarly) {
        console.log('RESULT: FAIL - game auto-ended on threefold repetition (should NOT have)');
        process.exit(1);
      } else {
        console.log('RESULT: PASS - game did NOT auto-end after threefold repetition');
        log('TEST', 'now testing manual offer/accept draw...');
        a.emit('offerDraw', { gameId });
      }
    }, 800);
  }

  a.on('gameOver', (p) => {
    if (!gameEndedEarly) {
      // this fire only happens after our manual offerDraw in the pass case
      if (p.result === 'draw') {
        console.log('RESULT: PASS - manual draw offer/accept ended the game as a draw:', p.reason);
        process.exit(0);
      } else {
        console.log('RESULT: FAIL - unexpected game end:', p);
        process.exit(1);
      }
    }
  });

  setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);
}

main().catch(e => { console.error(e); process.exit(1); });
