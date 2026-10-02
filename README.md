# Chess Coach

Play chess against the computer on your iPhone, at any strength from absolute beginner to
full-strength Stockfish. An evaluation bar shows who is winning, and a coach rates every move you
make and explains it in plain English. Chess Coach is a web app that you install on your Home
Screen. Everything runs on the phone: there is no account and no server, and it works offline
after the first visit.

**Open it:** <https://atg-y2k.github.io/chess/> (see [Hosting](#hosting) if the link is not live yet).

## What you get

- **Opponents from 100 to 3200 Elo.** 16 named bots (Pip 🐣 at 100 … Quasar 🌌 at 3200), a custom
  strength slider in steps of 50, and **Match my rating**, which always picks an opponent at your
  current rating.
- **Your own rating.** Rated games update an Elo rating. You pick a starting level, and the Menu
  shows your rating, your peak, your wins, draws and losses, and your last games (with your accuracy
  once a game has been reviewed).
- **A live evaluation bar** next to the board, and a graph of the whole game under the coach.
- **A coach** that classifies each of your moves (Best, Mistake, Blunder…) and says why: what it
  wins or loses, the tactic or recapture you missed, the threat you allowed, and what the best move
  was.
- **Hints, Show best and Retry** to learn from your mistakes during the game.
- **Game Review** after the game: accuracy for both sides, key moments, and coaching for every move
  of both players.
- **Takebacks, board flip and PGN export** (with evaluations and move marks) through the iOS share
  sheet or the clipboard.
- **Made for the iPhone:** full screen when installed, fits around the Dynamic Island and the home
  indicator, dark theme by default (Light and Automatic in the Menu), sounds that follow the silent
  switch, and your game is kept if iOS closes the app.

## Install it on your iPhone

1. Open <https://atg-y2k.github.io/chess/> in **Safari** (iOS 16.4 or later).
2. Tap **⋯** next to the address bar, then **Share**. (On older iOS, or with Safari's *Bottom* tab
   layout, tap the **Share** button directly.)
3. Tap **Add to Home Screen**, leave **Open as Web App** switched on, and tap **Add**.
4. Start Chess Coach from its Home Screen icon. It opens full screen, like an app.

Chrome and the other iOS browsers can also add it to the Home Screen from their share menu. The Home
Screen app keeps its own rating and saved game, separate from Safari's, so progress made in a Safari
tab before installing does not carry over.

The first visit downloads about 3.3 MB (less if the site compresses it). Most of that is the chess
engine (1.8 MB) and the opening book (0.9 MB). On a slow connection, the start screen shows
"Downloading engine NN%…". Once a launch has finished that download while online, the app works
**offline**, in airplane mode too: it says **Available offline** once when the download is done,
and the Menu's Engine section keeps saying so. The Home Screen app keeps its own storage (see
above), so open it once while online after adding it. If the connection drops during that first
download, the app finishes it by itself the next time it is online.

**Updates** download in the background and switch over only when that cannot get in your way:

- **Never during a game or a review.** The new version starts the next time the app starts from
  scratch, for example after iOS has closed it in the background or after you swipe it away in the
  app switcher.
- **Before a game, or on a finished game**, the app reloads onto the new version when you open it
  or come back to it, or while it is in the background. A finished game comes back as it was, with
  its result, ready for review. While the game-over sheet (or another sheet) is open over a finished
  game, this happens only in the background.
- It normally waits until you are not using the app, so it does not reload while you are choosing
  an opponent.

## Playing a game

The first time you open the app, and whenever you tap **New**, the **New game** sheet asks you to:

- **Pick your level** (first game only): Beginner (400), Casual (800), Intermediate (1200),
  Advanced (1600) or Expert (2000). This sets your starting rating and switches the opponent to
  **Match my rating**, so your first game is against a bot of your level (unless you already picked
  an opponent in the sheet). You can change your level later in the Menu with **Set my level**.
- **Pick an opponent:** a named bot, **Custom** (the slider, 100 to 3200 in steps of 50) or
  **Match my rating** (an opponent at your rating, rounded to 50, chosen again for every game).
- **Pick a color:** White, Random or Black.
- **Choose options:** Coach, Evaluation bar, Best-move arrows, Takebacks and Sound.

Then tap **Play**. Move by dragging a piece or by tapping it and then its destination square. The
bar at the bottom has **New** (a new game), **Undo** (take back your last move), **Hint**, **Flip**
(turn the board around), **Coach** (coach on or off) and **Menu**. When the game ends, a sheet
shows the result the way chess players write it, from White's side (1–0 when White won, 0–1 when
Black won, ½–½ for a draw), with White on the left, and your rating change. After the game the bar
has **Review** and ‹ › to step through the moves. Tap any move in the move list, or anywhere on the graph, to look
at that position; **Back to game** returns to the current one.

If iOS closes the app (it often does in the background), your game is still there when you open it
again, and a finished game comes back with its result, ready for review, until you start the next
one.

## The coach

After each of your moves the coach names the kind of move (see [Move classifications](#move-classifications))
and explains it. For example, "14. Qg4 is a blunder" with "This hangs your queen on g4."

- **Show best** puts the engine's best move and the move you played on the board as arrows, and
  explains the best move. It appears when the engine preferred a different move. After the app has
  been closed and reopened, it may take a moment: the coach looks at the position again first.
- **Retry** (after a mistake, miss or blunder, when takebacks are on) takes your move back so you
  can look for a better one. While Retry is on offer, the coach does not give away the answer. The
  "Try again" prompt is still there if iOS closes the app in the meantime.
- **Hint** shows the best move with an arrow and a short reason, and how it compares with the other
  good moves, for example "c4 keeps a small edge. g3 and Bf4 are about as good." You can still
  step back through the moves while a hint is open; the hint comes back when you return to the game.
- **Best-move arrows** (an option) show the engine's top three moves all the time.

If you don't take back a piece your opponent just captured, the coach says so, for example "You
didn't recapture the bishop on c6."

**Good moves that give something away.** When the game is already decided, a move can hardly change
your winning chances, so it can count as Good or Excellent even if it gives up material. The coach
does not praise such a move: it says, for example, "10… Kd8 doesn't change the result" (the game
was already lost) or "25. Rd1 still wins, but gives up material", explains what the move gives away,
and shows no move icon for it. Game Review lists it among the key moments.

The coach needs a moment to check each move, a few seconds at most: in the rare, very sharp
position where a deeper look would take the engine minutes, it settles for a slightly shallower
one. If the check fails (rarely), it says "Couldn't check …" with a **Try again** button.

When it is your move right after your opponent took one of your pieces and you can take back
without losing material, the coach's tip says so, for example "Rocco just took your bishop on c1.
Can you recapture?"

## The evaluation bar

The bar next to the board shows who is better. The white part is White's share of the winning
chances and the dark part is Black's, so a bar that is half white means the game is even. The
number sits at the end of the side that is ahead. It is in pawns: **1.3** means that side is about
a pawn and a third better. **M3** means that side can force checkmate in 3 moves. While a new
position is being analyzed, the last number stays and pulses. The engine looks at each position
for a fixed amount of work (about 10 seconds on an iPhone at most), then stops to save battery.

The graph under the coach shows the same thing for the whole game, with colored dots at the big
moments. The Evaluation bar option hides both.

## Game Review

After the game, tap **Review** (or **Game Review** in the coach panel). The engine goes through
every move of both players. You then see each side's **accuracy**, a count of each kind of move,
and the **key moments**: brilliant and great moves, mistakes, misses and blunders, and good moves
that gave something away (inaccuracies too when there are few). Tap a moment or step through the
moves with ‹ › to read the coach's comment on each move, with **Show best** for the better move.
**Report** returns to the summary.

## Your rating (what Elo means)

**Elo** is a number that measures playing strength. The gap between two ratings predicts the
result: a player rated 200 points higher is expected to score about 76% (counting a draw as half a
point), and one rated 400 points higher about 91%. After each rated game your rating goes up if you
did better than expected against that bot and down if you did worse, so beating a stronger bot
gains more than beating a weaker one.

- **Starting level.** You start at the level you picked (Casual, 800, if you skip it). **Set my
  level** in the Menu sets a new level at any time; your game history stays.
- **New ratings move fast.** Your rating is uncertain at first, so your first rated game moves it
  by about 175 points against an equal bot, and by up to about 350 if you beat a much stronger bot
  or lose to a much weaker one. The steps shrink as you play: about ±30 after 10 games, about ±11
  after 30, and ±8 from about 40 games on. (The step size follows the Glicko rating system.) If a
  new rating starts off wrong, **Set my level** in the Menu resets it at any time, and the rating
  moves fast again after that.
- **Catching up.** If your last 6 rated games together went much better, or much worse, than
  expected (by 2.5 points or more), the rating speeds up again as if you had played only 8 games,
  so it can catch up with a player who has improved.
- **Match my rating** follows your rating. A rematch matches your new rating.

**Rated and unrated games.** A game counts for your rating unless you use help:

- A **takeback** (Undo), a **hint**, **Retry** or **best-move arrows** make the game unrated. The
  coach and the evaluation bar are fine in rated games.
- In a rated game, the first hint, takeback or Retry asks you to confirm. While a takeback or Retry
  is waiting for your answer, your opponent holds its reply; if you cancel, it plays on. Switching
  best-move arrows on (in the Menu, or when starting the game) makes it unrated at once.
- An **Unrated** tag on your player strip shows when a game no longer counts.
- **Resigning** counts as a loss, rated unless the game was already unrated. Resigning before you
  have made a move does not change your rating.
- **Starting a new game** while one is going, after you have made a move, also counts as a loss
  ("Abandoned"), rated unless the game was already unrated. The New game sheet warns you and its
  button reads **Resign & play** (with **Match my rating**, you play the opponent the sheet showed).
  Before your first move, the old game is simply dropped.

Unrated games still appear in your history and in your win, draw and loss record.

## How the opponents play

The same Stockfish engine plays every level. The bots are weakened by the app, not by the engine's
own strength limiter, so every level is consistent and each game can be replayed.

- **100–1300 Elo:** the engine scores every legal move, and the bot then chooses like a weak human
  would. It likes captures and checks, sometimes overlooks the reply to its move, and sometimes
  misses a mate. The lower the Elo, the more often it goes wrong.
- **1350–3150 Elo:** Stockfish's own "Skill Level" method (choosing among its top moves with a
  strength-dependent error), blended smoothly between whole levels.
- **3200 Elo:** the engine's best move.
- **Openings:** every bot plays moves from the lichess opening book, varied from game to game. Weak
  bots leave the book after a move or two and pick dubious lines more often; the strongest follow it
  for up to about 19 moves.
- **Winning endings:** bots finish off a won game. From 1350 up, a bot always plays a forced mate it
  finds. In a clearly won ending against a bare king (or a king with pawns or one minor piece), the
  bot searches deeper to make progress toward mate. Weaker bots do this only part of the time, but
  they never hang their queen or rook there, and never stalemate you.
- **Repetitions:** the bot knows the moves of the game, so it knows when a move would repeat a
  position for the third time (a draw). When it is clearly winning, it avoids moves that would let
  the game end in a draw by repetition.

**These are engine-scale ratings, not chess.com or FIDE ratings.** They follow Stockfish's
calibration against engine rating lists, which differs from human rating pools, especially at the
bottom of the scale (100–400 are close together). Use them as a ladder: if you beat a bot
comfortably, move up. The strongest levels are also limited by the phone's speed, so they play a
little below their label.

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

**Accuracy** uses lichess's formula: a per-move accuracy from the drop in winning chances, averaged
over the game. The chess.com formulas are private, so the numbers are similar in spirit but will not
match chess.com exactly. The Brilliant and Great thresholds depend on your rating.

## The Menu

- **Flip board, Export PGN, New game and Resign** (Resign asks first).
- **While playing:** Coach, Evaluation bar, Best-move arrows (makes the game unrated) and Sound.
- **Appearance:** Dark, Light or Automatic (follows iOS).
- **Your stats:** rating, peak, games, wins/draws/losses and **Set my level**; then your
  **Recent games** (the last 10).
- **Engine:** "Stockfish 19" with "2 workers", or "1 worker (compatibility mode, until …)";
  **Available offline** once the app and the engine are saved on the phone; and **Run engine
  self-test**. See below.
- **About:** the license notice, a link to the source code, the credits, and links to the
  third-party licenses and the engine's source and license.

## If something goes wrong

- **"The chess engine could not start."** The screen says what to do:
  - "Your browser may not support WebAssembly SIMD": the phone needs iOS 16.4 or later.
  - "Couldn't download the chess engine. Check your connection and tap Try again.": the first
    download failed. The app also tries again by itself once the phone is back online.
  - Otherwise: tap **Try again**, and if it keeps happening, close and reopen the app.
- **"The chess engine stopped working."** Tap **Try again**. Your game is saved and continues.
- **Compatibility mode.** Running two engines (one for your opponent, one for the coach) uses a lot
  of memory. If the second engine cannot start, or iOS closes the app while it is starting both, the
  app switches to one shared engine for 14 days and then tries two again. In this mode the coach pauses while your opponent thinks. The
  Menu's Engine section shows the mode and offers **Try two engines again**.
- **Engine self-test.** Menu → Engine → **Run engine self-test**, or open
  <https://atg-y2k.github.io/chess/?enginetest>. It starts both engines, runs a set of searches
  (including a mate in 2 and both engines at once) and shows a log with **PASS** or **FAIL**. *Copy
  log* copies it, for example to paste into a bug report.

---

## Hosting

The app is a static site: `npm run build` writes it to `dist/`.

- **GitHub Pages (set up).** On every push to `main`, `.github/workflows/deploy.yml` runs the unit
  tests and the end-to-end tests (against a `BASE_PATH=/chess/` build), builds with
  `BASE_PATH=/chess/` and publishes. Nothing is published if a test fails. One-time setup:
  repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. GitHub Pages on
  the **Free plan requires a public repository**. This repository is private, so either make it
  public, upgrade to GitHub Pro (or a paid organization plan), or use one of the hosts below.
- **Cloudflare Pages or Netlify** (both free for private repositories): connect the repository,
  set the build command to `npm run build`, the output directory to `dist`, and the environment
  variable **`BASE_PATH=/`** (the site is served from the root there, not from `/chess/`). Use
  Node 24.
- A custom domain or a `<user>.github.io` repository also needs `BASE_PATH=/`.

Whatever the host, open the site once in Safari and add it to the Home Screen as above.

**A public site must offer its source code.** Everyone who opens the site receives GPL-3.0 code (the
app itself, chessground and Stockfish), so they must also be able to get the source. The app points
to <https://github.com/atg-y2k/chess> (the Menu's About section, the self-test page and
`THIRD-PARTY-LICENSES.txt` next to the app), which is enough once that repository is public; the
GitHub Pages route needs that anyway. To host publicly from a private repository instead, publish
the source next to the app: use the build command `npm run build && npm run build:source` (it adds
`chess-coach-source.tar.gz`, a `git archive` of the committed source of the commit being deployed,
to `dist/`) and set `VITE_SOURCE_URL=chess-coach-source.tar.gz` so the app points there. Or keep the
site to yourself (for example with Cloudflare Access or Netlify's password protection), so that
nobody else receives the app.

## Development

Requires Node 24 (chessground declares `engines.node >= 24`).

```sh
npm ci                 # install
npm run dev            # dev server with hot reload (http://localhost:5173)
npm test               # unit tests (Vitest: 676 tests in 30 files; the calibration test is skipped)
npm run typecheck      # tsc --noEmit
npm run build          # typecheck + production build into dist/
npm run build:source   # add the committed source (dist/chess-coach-source.tar.gz) for hosting
npm run preview        # serve dist/
npm run e2e            # Playwright (20 tests): builds, serves and runs e2e/ on an emulated iPhone 15 Pro
npm run build:openings # regenerate src/data/openings.json from the lichess chess-openings data
npm run calibrate      # play bot-vs-bot matches with the real engine to check the Elo ladder
```

- Some unit tests run the real Stockfish WASM in node (engine, bot conversion and repetition tests).
- `E2E_REQUIRE_APP_SW=1 npm run e2e` makes the PWA test fail if the app does not register its
  service worker itself (CI sets it). `BASE_PATH=/chess/ npm run e2e` tests the GitHub Pages layout.
  Set `PW_CHROMIUM_PATH` to use a specific Chromium.
- `?engines=1` forces one shared engine worker for that visit (the fallback for devices that cannot
  run two). A remembered compatibility mode lasts 14 days; `?engines=2` (or the Menu's *Try two
  engines again*) clears it.
- The dev-only component gallery is at `/gallery.html?g=<board|panels|sheets|engine>` (`npm run dev`).
- In the browser console, `__chessCoach.controller` is the game controller
  (e.g. `await __chessCoach.controller.idle()`).
- `ARCHITECTURE.md` describes the modules, the contracts between them and the screen layout.

## Credits and licenses

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

The build writes the license texts of every package it includes to `THIRD-PARTY-LICENSES.txt` next to
the app (the engine's are in `engine/`), and keeps the packages' license comments in the minified code.
