# Chess Coach

Play chess against the computer on your iPhone, at any strength from absolute beginner to
full-strength Stockfish, with a live evaluation bar and a coach that rates every move and explains
it in plain English. It is an installable web app (PWA): everything runs on the phone, there is no
account or server, and it works offline once it has been opened.

**Open it:** <https://atg-y2k.github.io/chess/> (see [Hosting](#hosting) if the link is not live yet).

## Features

- **Opponents from 100 to 3200 Elo.** 16 named bots (Pip 🐣 at 100 … Quasar 🌌 at 3200), a custom
  strength slider in steps of 50, and **Match my rating**, which always picks an opponent at your
  current rating.
- **Your rating.** Rated games update a tracked Elo rating (you start at 800). Your peak, win/draw/loss
  record and the last games (with accuracy after a review) are in the Menu.
- **Live scoring.** An evaluation bar next to the board slides as the position changes, and an
  evaluation graph under the coach shows the whole game. Tap or drag the graph to jump to a move.
- **Coach.** After each of your moves the coach classifies it (see the [legend](#move-classifications))
  and explains why: what it wins or hangs, the tactic you missed, the threat you allowed, and what
  the best move was. *Show best* puts the best move and your move on the board as arrows; *Retry*
  takes a bad move back so you can find a better one.
- **Hints and arrows.** *Hint* shows the best move with an arrow and a short reason. *Best-move
  arrows* (in the Menu or the New game sheet) show the engine's top three moves all the time.
- **Game review.** After the game: accuracy for both sides, a count of each kind of move, key moments
  you can tap, and step-by-step coaching for every move of both players.
- **Takebacks, flip, PGN export.** Undo (optional per game), flip the board, and export the game as
  PGN (with evaluations and move-quality marks) through the iOS share sheet or the clipboard.
- **Made for the iPhone.** Full-screen when added to the Home Screen, respects the Dynamic Island and
  home indicator, dark theme by default (Light and Automatic in the Menu), sounds that follow the
  silent switch, and it keeps your game if the app is closed mid-game.

Using takebacks, hints or best-move arrows makes a game **unrated**; your rating does not change.

## Install it on an iPhone

1. Open <https://atg-y2k.github.io/chess/> in **Safari** (iOS 16.4 or later).
2. Tap **⋯** next to the address bar, then **Share**. (On older iOS, or with Safari's *Bottom* tab
   layout, tap the **Share** button directly.)
3. Tap **Add to Home Screen**, leave **Open as Web App** switched on, and tap **Add**.
4. Start Chess Coach from its Home Screen icon. It opens full-screen, like an app.

Chrome and the other iOS browsers can also add it to the Home Screen from their share menu. The Home
Screen app keeps its own rating and saved game, separate from Safari's: progress made in a Safari tab
before installing does not carry over.

The first visit downloads everything, about 3 MB (most of it the chess engine and the opening book).
After that it works **offline** (flight mode included). Updates download in the background, and the
app switches to a new version only between games and when you are not using it: when you open it or
come back to it (before you touch anything), or while it is in the background. It never reloads in the
middle of a game or a review, or while you are choosing your next game.

## How the opponent strength works

The same Stockfish engine plays every level; the bots are weakened in JavaScript, not by the
engine's own strength limiter, so every level is consistent and each game is replayable.

- **100–1300 Elo:** the engine scores every legal move, and the bot then chooses like a weak human
  would: it prefers captures and checks, sometimes overlooks the reply to its move, and sometimes
  misses mates. The lower the Elo, the more often it goes wrong.
- **1350–3150 Elo:** Stockfish's own "Skill Level" method (choosing among its top lines with a
  strength-dependent error), with the level blended smoothly between whole steps.
- **3200 Elo:** the engine's best move.
- In the opening, every bot plays book moves from the lichess opening database, varied per game:
  weak bots leave the book after a move or two (and pick dubious lines more often), strong bots
  follow it for up to 14 moves.

**These are engine-scale ratings, not chess.com or FIDE ratings.** They follow Stockfish's
calibration against engine rating lists, which differs from human rating pools, especially at the
bottom of the scale (100–400 are close together). Use them as a relative ladder: if you beat a bot
comfortably, move up. The strongest levels are also limited by the phone's speed, so they play a
little below their label.

**Your rating** starts at 800 and uses the standard Elo formula against the bot's rating, with a
K-factor of 60 for your first 10 rated games, 32 until 30 games and 16 after that. **Match my
rating** sets the opponent to your rating (rounded to 50) at the start of each game, and a rematch
re-matches it to your new rating.

## Move classifications

Classifications compare your move with the engine's best move in terms of your **winning chances**
(the lichess win-probability model), so a pawn matters more in a close position than when you are
already a queen up.

| Icon | Class | Meaning |
|---|---|---|
| `!!` | **Brilliant** | A good piece sacrifice that is also (nearly) the best move. |
| `!` | **Great** | The only good move, or one that turns the game around. |
| `★` | **Best** | The engine's top choice. |
| 👍 | **Excellent** | Almost as good as the best move (loses under 2% winning chances). |
| `✓` | **Good** | A decent move (loses under 5%). |
| 📖 | **Book** | A known opening move. |
| `□` | **Forced** | The only legal move. |
| `?!` | **Inaccuracy** | A weaker move (loses 5–10%). |
| `?` | **Mistake** | Gives away a good part of your advantage (loses 10–20%). |
| `✕` | **Miss** | You did not punish your opponent's mistake. |
| `??` | **Blunder** | A serious mistake that loses material or the game (loses 20% or more). |

**Accuracy** is lichess's formula: a per-move accuracy from the drop in winning chances, averaged
over the game. The chess.com formulas are private, so the numbers are similar in spirit but will not
match chess.com exactly. The Brilliant and Great thresholds depend on your rating.

## Engine self-test

To check the engine on your own phone, open <https://atg-y2k.github.io/chess/?enginetest>. It starts
both engines, runs a set of searches (including a mate in 2 and both engines at once) and shows a
log with **PASS** or **FAIL**. *Copy log* copies it, for example to paste into a bug report.

If the app shows "The chess engine could not start", the phone probably runs iOS older than 16.4
(WebAssembly SIMD is needed). The error screen has *Try again* and a link to the self-test.

## Hosting

The app is a static site: `npm run build` writes it to `dist/`.

- **GitHub Pages (set up).** On every push to `main`, `.github/workflows/deploy.yml` runs the unit
  tests and the end-to-end tests (against a `BASE_PATH=/chess/` build), builds with
  `BASE_PATH=/chess/` and publishes; nothing is published if a test fails. One-time setup:
  repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. GitHub Pages on
  the **Free plan requires a public repository**; this repository is private, so either make it public, upgrade to GitHub Pro (or a
  paid organisation plan), or use one of the hosts below.
- **Cloudflare Pages or Netlify** (both free for private repositories): connect the repository,
  set the build command to `npm run build`, the output directory to `dist`, and the environment
  variable **`BASE_PATH=/`** (the site is served from the root there, not from `/chess/`). Use
  Node 24.
- A custom domain or a `<user>.github.io` repository also needs `BASE_PATH=/`.

Whatever the host, open the site once in Safari and add it to the Home Screen as above.

**A public site must offer its source code.** Everyone who opens the site receives GPL-3.0 code (the
app itself, chessground and Stockfish), so they must also be able to get the source. The app points
to <https://github.com/atg-y2k/chess> (in the Menu's About section and in `THIRD-PARTY-LICENSES.txt`
next to the app), which is enough once that repository is public; the GitHub Pages route needs that
anyway. To host publicly from a private repository instead, publish the source next to the app: use
the build command `npm run build && npm run build:source` (it adds `chess-coach-source.tar.gz`, the
source of the commit being deployed, to `dist/`) and set `VITE_SOURCE_URL=chess-coach-source.tar.gz`
so the app points there. Or keep the site to yourself (for example with Cloudflare Access or Netlify's
password protection), so that nobody else receives the app.

## Development

Requires Node 24 (chessground declares `engines.node >= 24`).

```sh
npm ci                 # install
npm run dev            # dev server with hot reload (http://localhost:5173)
npm test               # unit tests (Vitest, ~420 tests)
npm run typecheck      # tsc --noEmit
npm run build          # typecheck + production build into dist/
npm run build:source   # add the committed source (dist/chess-coach-source.tar.gz) for hosting
npm run preview        # serve dist/
npm run e2e            # Playwright: builds, serves and runs e2e/ on an emulated iPhone 15 Pro
npm run build:openings # regenerate src/data/openings.json from the lichess chess-openings data
npm run calibrate      # play bot-vs-bot matches with the real engine to check the Elo ladder
```

- `E2E_REQUIRE_APP_SW=1 npm run e2e` makes the PWA test fail if the app does not register its
  service worker itself (CI sets it). `BASE_PATH=/chess/ npm run e2e` tests the GitHub Pages layout.
  Set `PW_CHROMIUM_PATH` to use a specific Chromium.
- `?engines=1` forces a single shared engine worker (the fallback for devices that cannot run two).
- The dev-only component gallery is at `/gallery.html` (`npm run dev`).
- In the browser console, `__chessCoach.controller` is the game controller
  (e.g. `await __chessCoach.controller.idle()`).
- `ARCHITECTURE.md` describes the modules, the contracts between them and the screen layout.

## Credits and licences

Chess Coach is free software under the **GNU General Public License v3.0 or later** (see
[`LICENSE`](LICENSE)); it has to be, because it includes GPL-3.0 components.

- [Stockfish](https://stockfishchess.org/) via [Stockfish.js 19](https://github.com/nmrugg/stockfish.js)
  (lite, single-threaded WebAssembly build) by Nathan Rugg and the Stockfish developers:
  **GPL-3.0**. The unmodified engine files, their checksums and the source links are in
  [`public/engine/`](public/engine/README.md).
- [chessground](https://github.com/lichess-org/chessground) (the board) by lichess.org: **GPL-3.0**.
  The piece set is cburnett's, as shipped with chessground.
- [chess.js](https://github.com/jhlywa/chess.js) (move rules): **BSD-2-Clause**.
- [lichess chess-openings](https://github.com/lichess-org/chess-openings) (opening names and book):
  **CC0**.
- [Preact](https://preactjs.com/) and [@preact/signals](https://github.com/preactjs/signals): MIT.
- [Workbox](https://github.com/GoogleChrome/workbox) (the service worker and its registration): MIT.
- Win-probability and accuracy formulas follow lichess's published ones. Move-classification names
  are inspired by chess.com's; this app is not affiliated with chess.com or lichess.org, and its bots
  are original characters.

The build writes the licence texts of every package it includes to `THIRD-PARTY-LICENSES.txt` next to
the app (the engine's are in `engine/`), and keeps the packages' licence comments in the minified code.
