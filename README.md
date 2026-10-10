# Chess Coach

Play chess against the computer on your iPhone, at any strength from absolute beginner to
full-strength Stockfish. An evaluation bar shows who is winning, and a coach rates every move you
make and explains it in plain English. Chess Coach is a web app that you install on your Home
Screen. Everything runs on the phone: there is no account and no server, and it works offline
after the first visit.

**Open it:** <https://atg-y2k.github.io/chess/> (see [Hosting](#hosting) if the link is not live yet).

**On the App Store (in preparation):** the same app as a native iPhone app, a free download with an
optional one-time "Pro" purchase for the coaching features. See [iOS app](#ios-app-app-store).

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
- **Rate opponent’s moves** (an option): see whether the computer found the best move, with the same
  ratings and explanations you get for yours.
- **An explorer** to try moves before you play them: move for both sides on the board, on your own
  (during a game the engine is off, so the game stays rated), or with the engine switched on: it rates
  each move, shows the evaluation and its best move, and can answer for the other side.
- **Draw on the board** with your finger: arrows and circles in four colors to sketch the moves you
  are thinking about, in your game, the explorer, Game Review and the Openings section. It is no help
  from the computer, so your game stays rated.
- **Game Review** after the game: accuracy for both sides, key moments, and coaching for every move
  of both players.
- **Openings** for beginners: 3,815 named lines (Italian Game, Sicilian Defense…) to search, browse
  and step through on a board, a "Start here" list for White and for Black, the move tree, guides that
  explain why each move is played, drills that test you move by move, and games against the computer
  that follow an opening.
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

The first visit downloads about 3.9 MB (less if the site compresses it). Most of that is the chess
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
- **Choose options:** Coach, Evaluation bar, Best-move arrows, Rate opponent’s moves, Takebacks and
  Sound.

Then tap **Play**. Move by dragging a piece or by tapping it and then its destination square.
**Draw**, on your strip under the board, lets you draw arrows and circles instead (see
[Drawing on the board](#drawing-on-the-board)). The bar at the bottom has **New** (a new game), **Undo** (take back your last move), **Hint**,
**Explore** (see [The explorer](#the-explorer)), **Flip** (turn the board around), **Coach** (coach
on or off) and **Menu**. When the game ends, a sheet shows the result the way chess players write
it, from White's side (1–0 when White won, 0–1 when Black won, ½–½ for a draw), with White on the
left, and your rating change. After the game the bar has **Review** and ‹ › to step through the
moves. Tap any move in the move list, or anywhere on the graph, to look at that position; **Back to
game** returns to the current one. (With the phone in landscape the bar is narrower: **New** is
then only in the Menu, and in Game Review **Flip** is.)

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

**Rate opponent’s moves** (an option, separate from the coach) does the same for the computer's
moves: you see whether it found the best move. Its last move gets its icon on the board and in the
move list (the same icons as yours), its big moments a dot on the graph, and the coach panel gives
the verdict and the explanation in the third person, for example "Pip’s 12… Nf6 is a mistake" with
"This leaves Black's knight on f6 undefended." **Show best** shows what it should have played, with
arrows on the position before its move. With the coach on too, the panel shows both moves, yours
always on top: one open, the other as a row ("You ★ 12. Nf3 Best"); tap the row to open it. Your move
stays open while it has something to fix (an inaccuracy or worse, with Retry and Show best at hand);
after a good move the computer's latest move is open. On a short phone (or in landscape) both fit in
one row ("You ★ Best | Pip ? Mistake"); tap a half to read it. With the coach off, the panel shows
only the computer's moves. The option is in the New game sheet and the Menu. It shows you when the
computer goes wrong, so it makes the game unrated, and it stays on for your next games until you
switch it off (see [Rated and unrated games](#your-rating-what-elo-means)).

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

## The explorer

**Explore** (in the bar at the bottom) lets you try moves before you make them. It opens at once on
the position on the board: the current one, or an earlier one you are looking at, also after the
game and in Game Review. A blue frame around the board, an **Exploring** tag and the blue explorer
panel show that this is not your game; tap the tag to go back to the game.

- **Move for both sides** on the board: tap a piece to see where it can go (the dots), then tap its
  square. The move list shows your line ("From 15… Nf6: 16. Nf3 Nc6 17. Bb5"); tap a move to go back
  to it.
- **The engine is off during a game**, so you work out the moves yourself and your game stays rated:
  no evaluation (the evaluation bar reads "Engine off"), no arrows, no move ratings, no best move and
  no Reply (its button stays in the bar, dimmed). The panel shows the move on the board and "Engine
  off: try moves for both sides. Your game stays rated." ("This game is already unrated." when it is).
  Checkmate, stalemate and draws still show: those are the rules, not the engine.
- **The Engine switch** in the panel turns the engine on (on a short phone, and in landscape when the
  panel is a single row, it sits beside the row). In a game that still counts for your rating it asks
  first ("Turn on the engine?": **Turn on** or **Keep off**), and turning it on makes the game
  unrated; switching it off again does not undo that. In an unrated game, after the game and in Game Review it turns on at once, and
  after the game and in Game Review the explorer opens with it on. Switched off again, everything the
  engine shows disappears at once (a game it made unrated stays unrated). Once you switch it on in a
  game, the explorer opens with it on for the rest of that game, until you switch it off.
- With the engine on:
  - The **evaluation bar** follows the explored position, and the engine's best moves for the side to
    move are drawn as arrows (**Arrows on** in the panel switches them off, **Arrows off** back on).
  - **Each move gets a rating** (also the moves you made before switching it on), like your moves in
    the game: an icon on the board and in the list, and in the panel the verdict, the evaluation and
    the coach's short explanation, for example "16. Nf3 — Excellent · +0.4". **Best here** names the
    engine's choice in the position. The position on the board comes first: when you switch the engine
    on after a long line, its evaluation, arrows and best move show before the earlier moves are rated.
  - **Reply** in the bar at the bottom plays the engine's best move for the side to move.
- The bar at the bottom has **Reset** (clears your line and goes back to where you started),
  **Flip**, **Back**, **Forward**, **Reply** (with the engine on) and **Exit**.
- A position that would end the game ends the line too: checkmate, stalemate, or a draw by
  repetition (counting your game's moves before it), the 50-move rule or too little material. The
  panel says so ("Threefold repetition: a draw."), and with the engine on the evaluation is 0.0.
- **Play 16. Nf3**: when you started on your turn in the game, this plays the first move of your
  line in the game, and closes the explorer.
- Your game never changes while you explore. If it was your opponent's turn, it plays on: the panel
  says so ("Pip played 15… Nf6 in your game.", on a short phone under the panel's row), and **Play** is
  no longer offered. A move you started (a piece you tapped, the promotion choice) is dropped when you
  go in or out of the explorer, so it never lands in the other one. **Exit** brings you back to the
  game as you left it. The explorer is not saved: if iOS closes the app, the game comes back without
  it.

## Drawing on the board

**Draw** (the pencil on the player strip under the board) lets you sketch the moves you are
thinking about, as with a pen on a real board: during your game (on your turn or your opponent's),
in the explorer, after the game, in Game Review, and on the boards of the Openings section (Learn
and Explore by moves).

- **Drag from one square to another** for an arrow; it shows while you drag, and lifting your finger
  on the square you started from, or off the board, draws nothing. **Tap a square** for a circle.
  Drawing the same arrow or circle again takes it off; in another color, it changes color. Your
  arrows are dashed, so they never look like the engine's arrows (which are solid) where both show.
  A drawing whose position changes before you lift your finger (your opponent moved) is not drawn.
- While Draw is on, the board moves no pieces: a frame in the color you draw with goes around it,
  and the strip under the board becomes the **Draw bar**: four colors (green, red, blue, orange),
  **Clear** (takes off the drawings on the position on the board) and **Done** (back to moving pieces;
  your drawings stay). When your opponent has moved and it is your turn, the bar shows the pulsing
  turn dot and **Done** pulses. Until your first drawing, a tip under the bar says how to draw.
- Drawings belong to a **position**: after a move the board shows that position's drawings (usually
  none), and going back to an earlier move shows its drawings again. The explorer shares them with the
  game, so an arrow drawn on your game's position is there when you explore from it, and the other way
  round. They last until you start a new game (they are not saved).
- Draw turns off when a sheet opens (the Menu, New game…), when you open or leave the explorer, start
  or end Game Review, take a move back, ask for a hint, or when the game ends (unless you are in the
  explorer: then it stays on until you leave it). **Escape** also leaves it (before leaving the
  explorer), and in the Openings section the **Done** at the top leaves Draw first (a second tap
  closes the section). Flip and stepping through the moves keep it on.
- Drawing is free (also in the App Store app) and never makes a game unrated: it is your own thinking,
  not the computer's.

## Openings

An **opening** is the first moves of a game. The **Openings** section (Menu → **Openings**, or
**Learn openings** in the New game sheet) teaches them from scratch: it opens full screen over your
game, and **Done** (or Back from its first page, Escape, or the phone's Back button) brings you back
to where you were, with your game as it was (your opponent may move meanwhile, as when the Menu is
open). A short card explains the words it uses (an opening, the main line, a variation, a book move)
the first time (a link at the bottom of the first page brings it back), and an ⓘ next to a term
explains it where it shows (ECO codes, book moves and "common in theory", the main line).

- **Search** by name ("najdorf", "Spanish", "caro"), by ECO code ("C50") or by moves ("1. e4 c5
  2.Nf3"). An opening the search names comes first (it opens the opening's page), then the matching
  lines with their variation and moves. Back from a result returns to the same search.
- **Start here:** pick **I play White** or **I play Black** for a list of good openings to start with,
  the easiest first (beginner-friendly openings, then intermediate, then advanced), each with its
  first moves (and, with the guides, how hard it is and what it is about). **All openings** lists all 141 openings, most studied first; **Explore by moves** is the
  move tree (below).
- **An opening's page** says who plays it ("An opening for Black: you choose it when White starts
  1. e4"), its first moves, its guide (what it is about, your plans and the other side's, the traps
  to know with **Show me**, and its key variations), all its variations, and related openings. Its
  buttons: **Learn the main line**, **Drill it** and **Play it vs computer**.
- **Learn** (stepping through a line): the board with the evaluation bar (the app's own engine, a
  quick look at each position), the opening's name at each move, and the guide's note on why each move
  is played. Step with the buttons (start, back, play, forward, end), by tapping the left or right
  half of the note card, by swiping it, with the arrow keys, or let it play by itself. **Other moves
  here** lists the other book moves at that point, how common they are in opening theory (not how
  often people play them), the main move (★) and known mistakes (⚠, moves that give the other side
  the better game); tap one to follow its line (Back returns). Moving a piece on the board follows
  the book too; any other move says that it leaves the opening book, with the engine's verdict and
  **Back to the line**. The last move of a line says what to do next (drill it, play it, or try the
  other moves). A trap (**Show me** on an opening's page) marks the mistake it is about.
- **Explore by moves:** the book moves from the starting position, with the opening each one leads
  to; tap a move, or play it on the board, to go deeper, and tap the trail of moves to go back. **Learn
  this line** and **Play** take it from there.
- **Drill** a line: the computer plays one side's moves (you pick yours; a trap is drilled from the
  side that sets it; **Strict** counts any other
  book move as a mistake, **Allow them** does not, but either way you play the line's move to go on)
  and you find yours on the board. A wrong move is shown, then taken back; **Hint** names the piece,
  then its square, then the move; **Show me** plays it. The end shows your score, the moves to review
  with their notes, and your progress: New, Learning (drilled), Familiar (a clean run: every move
  found first time, no hints) and Mastered (clean runs on three different days). Only drills of the
  side that plays the opening count towards it; the other side's are practice. **Next variation**
  goes on with a line that adds something new. Lines due for practice and your latest drills show on
  the first page, and your progress on the openings' cards.
- **Play it vs computer** asks which side you play (the opening's, or "face it" while the computer
  plays it; after a drill, the side you drilled), where to start (see
  [Playing an opening](#playing-an-opening)) and which opponent, and starts the game. The game follows
  exactly the line you were looking at, including an opening's main line from its guide. It warns when
  your side plays a known mistake in the line, and a line that ends in checkmate starts from move 1.
  These games are unrated, and your New game choices (side, opponent) stay as they were.
- **From a game:** while the game's position has an opening name, a chip at the end of the move list
  ("📖 Italian Game") opens it in the Openings section; in a game that plays an opening, so does the
  coach's banner, at the game's move.
- **During a rated game** the section shows no engine evaluation (that would be live help, which makes
  a game unrated): the names, the book moves and the guides are all there. If your game ends while the
  section is open, its result shows when you close the section.

In the App Store app, the guides (the notes on each move, the plans, the traps and the key
variations) and the drills with their saved progress are part of Pro; searching, browsing, stepping
through any line, the move tree and playing openings are free. The section and its data (about
110 KB compressed) load the first time it opens; once the app is cached it works offline.

## Playing an opening

**Play** on a line in the Openings section starts a game that follows that opening (for example the
Italian Game) against the opponent you pick, with your usual options (coach, evaluation bar…):

- **From move 1:** the game starts from the beginning, and while the game is on the line, the
  computer plays the line's moves for its side. With **Show the line’s moves as I play** on, a light
  brown arrow shows the line's next move on your turn, and the coach says "Line move: 3. Bc4 — Italian
  Game" (and, for a move the line plays on purpose to show how it gets punished, that it is a known
  mistake). Another move leaves the line: the coach says so once ("You left the line at 3. Nc3 (the line
  continues 3. Bc4) — the game goes on normally"), and the computer then plays its own moves. Without
  the arrow, the coach still says when someone leaves the line. Reaching the same position by another
  move order counts as being on the line, and taking back a move that left it puts you back on it.
  Once the line's last move is played, the coach says the line is complete and you are on your own.
- **After the line:** the game starts with the line's moves already on the board, marked as "book"
  moves (📖: well-known opening moves that players have studied for years), and you play on from
  there. If it is the computer's move, it replies at once. A line that would end the game (the Fool's
  Mate) stops before that, on your move.

A banner at the top of the coach panel names the opening and where the game is: "Move 3 of 5" while
on the line, "Line complete", or "Left at 3. Nc3" (on a narrow screen the variation's name gives way
first, never the opening's). Tap it to open the line in the Openings section at the game's move (your
game stays as it is). The computer's first moves are chosen for it, so these games never change
your rating (the Unrated tag shows from the start), and the game-over sheet says "Opening practice:
Italian Game". **Rematch** plays the same opening again; **New game** starts a normal game. The
opening is saved with the game, so it goes on after iOS closes the app. Game Review leaves the moves
that were on the board from the start out of the accuracy and the move counts, and the exported PGN
is a normal game from the start position (its Event tag says "Opening practice: …").

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

- A **takeback** (Undo), a **hint**, **Retry**, **best-move arrows**, the **engine in the explorer**
  or **Rate opponent’s moves** make the game unrated. The coach, the evaluation bar, the explorer
  with its engine off and drawing on the board are fine in rated games.
- In a rated game, the first hint, takeback or Retry asks you to confirm, and so does switching on
  the explorer's engine or Rate opponent’s moves in the Menu. While a takeback or Retry is waiting for
  your answer, your opponent holds its reply; if you cancel, it plays on (it also plays on while you
  explore or answer about the explorer's engine or Rate opponent’s moves). Switching best-move
  arrows on (in the Menu, or when starting the game) makes it unrated at once, and a game started
  with best-move arrows or Rate opponent’s moves on is unrated from the start. Both are settings: they
  stay on for your next games (a Rematch too) until you switch them off.
- A game that plays an opening (see [Playing an opening](#playing-an-opening)) is unrated from the
  start: the computer's first moves are scripted.
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
- **Openings:** the Openings section (see [Openings](#openings)).
- **Chess Coach Pro** (App Store app only): Unlock, or "Unlocked ✓", and **Restore Purchases**.
- **While playing:** Coach, Evaluation bar, Best-move arrows (makes the game unrated), Rate opponent’s
  moves (asks first in a rated game, then makes it unrated) and Sound.
- **Appearance:** Dark, Light or Automatic (follows iOS).
- **Your stats:** rating, peak, games, wins/draws/losses and **Set my level**; then your
  **Recent games** (the last 10).
- **Engine:** "Stockfish 19" with "2 workers", or "1 worker (compatibility mode, until …)";
  **Available offline** once the app and the engine are saved on the phone; and **Run engine
  self-test**. See below.
- **About:** the license notice, a link to the source code, the credits, and the third-party
  licenses and the engine's source and license (shown in the app).

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
  the Free plan needs a public repository, which this one is.
- **Cloudflare Pages or Netlify** (both free, also for private repositories): connect the repository,
  set the build command to `npm run build`, the output directory to `dist`, and the environment
  variable **`BASE_PATH=/`** (the site is served from the root there, not from `/chess/`). Use
  Node 24.
- A custom domain or a `<user>.github.io` repository also needs `BASE_PATH=/`.

Whatever the host, open the site once in Safari and add it to the Home Screen as above.

The site also serves the pages the App Store app needs: `privacy.html` (privacy policy), `terms.html`
(the license agreement) and `support.html`, from `public/`. They are static, self-contained pages that
also open offline, and the app's purchase screen links to them at
`https://atg-y2k.github.io/chess/…`. Keep them online even if you stop hosting the web app (see
[`docs/APP_STORE.md`](docs/APP_STORE.md), "The free web version").

**A public site must offer its source code.** Everyone who opens the site receives GPL-3.0 code (the
app itself, chessground and Stockfish), so they must also be able to get the source. The app points
to <https://github.com/atg-y2k/chess> (the Menu's About section, the self-test page and
`THIRD-PARTY-LICENSES.txt` next to the app). The repository is public, so that is enough; keep it
public, also because the App Store app links to its release tags. To host publicly from a private
repository instead (a fork, say), publish
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
npm test               # unit tests (Vitest: about 1,090 tests in 57 files; the calibration test is skipped)
npm run typecheck      # tsc --noEmit
npm run build          # typecheck + production build into dist/
npm run build:source   # add the committed source (dist/chess-coach-source.tar.gz) for hosting
npm run preview        # serve dist/
npm run e2e            # Playwright: builds, serves and runs e2e/ on an emulated iPhone 15 Pro (the
                       #   paywall tests run against a second, VITE_PAYWALL=1 build)
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

## iOS app (App Store)

The App Store app is this same web app, built for a native shell with `VITE_NATIVE=1` and wrapped by
[Capacitor 8](https://capacitorjs.com/). Every file, the engine included, ships inside the app, so it
works offline from the first launch and updates only through the App Store: no service worker, no
update logic, no web manifest. It adds native touches: a haptic with each game sound, the iOS share
sheet for PGN export, a status bar that follows the theme, a launch screen, and a backup of your
rating, games and settings in the app's own settings storage (iOS may clear a web view's storage when
the device runs low on space). iPhone only, portrait, iOS 16.4 or later.

**Free and Pro.** The App Store app is a free download with one in-app purchase, **Pro**: one-time
(non-consumable), shared through Family Sharing, and bought and checked on the device with StoreKit 2
(no server, no account; the check works offline).

- **Free:** every opponent at any level, your rating, the evaluation bar and graph, the move ratings
  and badges (also of the opponent's moves, with Rate opponent’s moves), accuracy, takebacks and
  Retry, the explorer with its engine off (trying moves for both sides), drawing on the board, PGN
  export, and in the Openings section searching, browsing, stepping through any line, the move tree
  and playing openings.
- **Pro:** the coach's explanations (the "why", also of the opponent's moves), Hint, Show best, the
  engine in the explorer (its evaluation, arrows, move ratings and Reply; its switch shows a lock),
  best-move arrows, Game Review's key moments and per-move comments, and the Openings section's guides
  (why each move is played, plans, traps) and drills with saved progress.

The split is `FEATURE_TIERS` in `src/game/entitlements.ts`. The web app has no paywall: everything in
it is unlocked. A web build made with `VITE_PAYWALL=1` locks Pro behind a mock store, for testing the
paywall in a browser (`VITE_PAYWALL=1 npm run dev`; `window.__mockStore` steers it, see
`ios/README-native.md`).

**Build it on a Mac** (Xcode 26 or later, Node 24):

```sh
npm ci
npm run build:native   # tsc, then VITE_NATIVE=1 vite build into dist-native/
npm run cap:sync       # copy dist-native/ into the Xcode project in ios/App
npm run ios:open       # open it in Xcode; pick your team under Signing & Capabilities, then Run
```

Run `build:native` and `cap:sync` again after every change to the web app.

- [`ios/README-native.md`](ios/README-native.md): the Xcode project, where each setting lives (bundle
  ID, name, version, minimum iOS), the StoreKit plugin, and testing purchases in Xcode, in the sandbox
  and in a browser.
- [`docs/APP_STORE.md`](docs/APP_STORE.md): the whole path from the Apple Developer account to the
  release: the in-app purchase, TestFlight, privacy, age rating, screenshots, metadata, App Review
  notes and the GPL steps for every release. [`docs/EULA-draft.md`](docs/EULA-draft.md) is the draft
  license agreement for the store.
- `.github/workflows/ios-build.yml`: builds the iOS app without signing on a macOS runner for every
  push and pull request that touches it, which shows that the Swift code and the Xcode project compile.
- `.github/workflows/ios-release.yml`: builds, signs and uploads to TestFlight when a tag
  `v<version>` is pushed (or when run by hand). It needs an App Store Connect API key and a certificate
  key as repository secrets (listed at its top).
- `node scripts/appstore-screenshots.mjs`: App Store screenshots (1320 × 2868) of the real app, in
  `appstore/screenshots/`.
- `npm run check:legal`: lists placeholders (and "Draft" notices) still in the privacy policy, terms
  and support pages; the release workflow refuses a `v*` release while there are any.

**Releases and the GPL.** Every App Store build links, in its About section and its
`THIRD-PARTY-LICENSES.txt`, to the exact commit it was built from. Builds for upload are made with
`npm run build:native:release`, which refuses uncommitted changes, and each one's commit is tagged
`ios-v<version>-b<build number>` (the release workflow does both). The released version is also
tagged `v<version>`. Never delete or move those tags.

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
- [Workbox](https://github.com/GoogleChrome/workbox) (the web app's service worker and its
  registration): MIT.
- [Capacitor](https://capacitorjs.com/) (the iOS app's native shell, and its haptics, share, status
  bar, splash screen and preferences plugins): MIT. Its Cordova compatibility layer includes code from
  Apache Cordova: Apache-2.0.
- Win-probability and accuracy formulas follow lichess's published ones. Move-classification names
  are inspired by chess.com's; this app is not affiliated with chess.com or lichess.org, and its bots
  are original characters.

The build writes the license texts of every package it includes to `THIRD-PARTY-LICENSES.txt` next to
the app (the engine's are in `engine/`), and keeps the packages' license comments in the minified code.
The iOS app ships the same notices (Menu → About shows them). Its license agreement on the App Store
will say that the GPL governs the software and does not restrict your rights under it (see the draft,
[`docs/EULA-draft.md`](docs/EULA-draft.md), still to be reviewed by a lawyer).
