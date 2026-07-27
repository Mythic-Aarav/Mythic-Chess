# MYTHIC CHESS — Roadmap

This tracks what's actually implemented vs. what's a known gap, so nothing
is silently missing. Built incrementally, each item tested before shipping.

## Built and working
- Name-only "lifetime" identity (no password), JWT-based
- Live matchmaking (Socket.IO), untimed games (no clocks)
- Bot fallback opponent (Indian human names) if no player found in 8s
- Move validation via chess.js (server-authoritative)
- Client-side legal-move dots, capture rings, check highlighting
  (client-side chess.js is a *hint* only — server still validates every move)
- Captured-piece tracking + material advantage display
- Promotion picker popup
- Sound effects (move/capture/check/game start/end) via Web Audio, no
  external audio files needed
- Flip board, mute toggle
- In-game chat (relayed via Socket.IO; bot sends canned replies)
- Daily login streak (resets if a day is missed)
- Puzzle mode (seeded puzzle set, solve tracking)
- Leaderboard (global, top 10 by Elo)
- Coach tab: static step-through tips (opening/tactics/endgame/mindset)
- **Draw offers** — back. Players can offer/accept a draw manually
  (`offerDraw`/`acceptDraw`). A bot opponent auto-accepts immediately
  rather than leaving the human waiting on a reply that'll never come.
- **Claimable vs. forced draws** — only checkmate, stalemate, and
  insufficient material end a game automatically (the position truly
  cannot continue). Threefold repetition and the 50-move rule — the
  two conditions that tend to surface in long games — no longer end
  the game by themselves; per real FIDE rules those are optional
  claims, so the game just keeps going unless a player offers/accepts
  a draw instead.
- PWA install prompt + manifest + minimal service worker
- Basic API rate limiting + payload size caps

## Explicitly deferred (not implemented — flagged, not faked)
These need real infrastructure/scope beyond an incremental pass:

- **Chess engine integration** (Stockfish or similar) — needed for:
  evaluation bar, post-game accuracy/move classification ("brilliant",
  "blunder", etc.), engine suggestions, analysis board with PV lines.
- **Friends / followers / social graph** — needs schema + UI for
  requests, friend lists, friend-only leaderboards.
- **Spectator mode** — needs read-only room joins in game.js.
- **Reconnect-after-disconnect** — currently disconnect = resignation;
  a grace period + reconnect token would change this.
- **PGN/FEN import-export, opening explorer/database** — no chess
  database wired up yet.
- **Achievements / XP / levels / daily missions / coins** — needs new
  schema and reward logic.
- **Notifications system** (friend online, invites, announcements) —
  needs a push/poll mechanism.
- **Admin panel** — needs role-based auth (currently no roles at all,
  since there's no password-based account system).
- **Email verification / password reset** — not applicable currently;
  the app deliberately has no passwords (see PROJECT NOTES below).
- **Private rooms / invite links** — matchmaking is currently
  queue-only, no room codes.
- **Time-control specific leaderboards** (bullet/blitz/rapid/classical)
  — doesn't apply: games are untimed, there's no time control at all.

## Project notes / deliberate tradeoffs
- **No passwords.** By design (explicit product decision earlier in
  this project): users just enter a name once, stored in a long-lived
  JWT in localStorage. This means no real account security — anyone
  with access to that browser's storage is "logged in" as that user.
  Fine for a casual app, not suitable if real money/identity is at stake.
- **In-memory game state.** Live games live in a `Map` in `game.js`,
  not the database. If the server restarts (e.g. Render's free tier
  spinning down from inactivity), in-progress games are lost. The
  client detects this ("Game not found") and resets gracefully rather
  than freezing, but the game itself can't be recovered.
- **Client-side chess.js is UI-only.** It's used to show legal-move
  dots and check highlights. It is never trusted for the actual game
  outcome — the server's copy of chess.js is the sole authority.
