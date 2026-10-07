/**
 * Opening guides: short, beginner-friendly explanations of the openings club players meet most
 * (summary, both sides' ideas, typical plans, key variations, traps and per-move notes for a main
 * line). Original text; every move list is checked against chess.js and the opening dataset in
 * tests/openings/guides.test.ts, and the claims were sanity-checked with Stockfish.
 *
 * This is Pro content (see OPENINGS_FEATURE_TIERS in src/openings/index.ts): it has no imports, so
 * a gated screen can lazy-load it on its own (`await import('../data/opening-guides')`).
 *
 * - `family` is the exact family name of the lichess chess-openings dataset (the part of an
 *   opening name before ':'), so `guideFor(openingAt(fen)?.name)` finds the guide for a position.
 * - Key variation names are exact dataset names, and each `uci` line ends on a position the
 *   dataset gives that name.
 * - Trap lines run from the initial position through the mistake to its punishment.
 * - `moveNotes` keys are numbered SAN lines from the initial position ("1. e4 e5 2. Nf3", see
 *   `moveNoteKey`); each note explains the last move of its key.
 */

/** A named line inside a guide. */
export interface OpeningGuideVariation {
  /** Exact dataset name ("Sicilian Defense: Najdorf Variation"). */
  name: string;
  /** UCI moves from the initial position. */
  uci: string[];
  note: string;
}

/** A trap: a short line in which one side blunders and gets punished. */
export interface OpeningGuideTrap {
  title: string;
  /** UCI moves from the initial position, through the punishment. */
  uci: string[];
  /** What happens and how to avoid it. */
  note: string;
  /** Who benefits. */
  side: 'white' | 'black';
  /**
   * The losing side's mistakes in `uci` (0-based plies, the ones the note marks "?" or "??"), so a
   * screen can flag them: the opening book only knows some of them.
   */
  mistakes: number[];
}

export interface OpeningGuide {
  /** Exact family name as in the dataset's "Family: Variation" names ("Sicilian Defense"). */
  family: string;
  /** Other names, plus dataset families or full names this guide also covers. */
  aka?: string[];
  /** Who chooses the opening. */
  side: 'white' | 'black';
  level: 'beginner' | 'intermediate' | 'advanced';
  /** Two or three sentences. */
  summary: string;
  ideasWhite: string[];
  ideasBlack: string[];
  typicalPlans?: string[];
  keyVariations?: OpeningGuideVariation[];
  traps?: OpeningGuideTrap[];
  /** Short notes on the main line's moves, keyed by numbered SAN line (see `moveNoteKey`). */
  moveNotes?: Record<string, string>;
  /**
   * The `moveNotes` key of the main line, when it is not the longest annotated line (e.g. the
   * King's Pawn Game guide annotates an early queen raid further than its main road 2.Nf3 Nc6).
   */
  mainLine?: string;
}

export const OPENING_GUIDES: OpeningGuide[] = [
  {
    family: "King's Pawn Game",
    aka: ["King's Knight Opening", "King's Pawn Opening", 'Open Game', 'Center Game'],
    side: 'white',
    level: 'beginner',
    summary:
      "1.e4 grabs the center and opens lines for the queen and the light-squared bishop. After 1...e5 both sides race to develop, and f7 and f2 are the early targets. The lines named King's Pawn Game are the rarer second moves, including the early queen raids beginners often meet.",
    ideasWhite: [
      'Develop knights and bishops quickly, then castle.',
      '2.Nf3 attacks e5 and is the most flexible second move.',
      'Keep an eye on f7: at the start only the king defends it.',
    ],
    ideasBlack: [
      'Defend e5 with ...Nc6 and develop as fast as White.',
      'Meet an early queen with developing moves that chase it.',
      'Never leave f7 guarded by the king alone against Qh5 plus Bc4.',
    ],
    typicalPlans: [
      'White: Nf3, Bc4 or Bb5, castle, then c3 and d4 for a big center.',
      'Black: ...Nc6, ...Nf6 or ...Bc5, castle, then ...d5 when it is safe.',
    ],
    keyVariations: [
      {
        name: "King's Knight Opening: Normal Variation",
        // 1. e4 e5 2. Nf3 Nc6
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
        note: 'The main road: 3.Bc4 is the Italian, 3.Bb5 the Ruy Lopez and 3.d4 the Scotch.',
      },
      {
        name: "King's Pawn Game: Wayward Queen Attack",
        // 1. e4 e5 2. Qh5
        uci: ['e2e4', 'e7e5', 'd1h5'],
        note: '2.Qh5 hits e5 and f7. Defend with 2...Nc6, then block with ...g6 (or defend f7 with ...Qe7) if the bishop comes to c4.',
      },
      {
        name: "Bishop's Opening",
        // 1. e4 e5 2. Bc4
        uci: ['e2e4', 'e7e5', 'f1c4'],
        note: 'The bishop aims at f7 right away; it often transposes to the Italian or the Vienna.',
      },
      {
        name: 'Center Game',
        // 1. e4 e5 2. d4 exd4 3. Qxd4
        uci: ['e2e4', 'e7e5', 'd2d4', 'e5d4', 'd1d4'],
        note: 'White recaptures with the queen, but 3...Nc6 gains time by attacking it.',
      },
    ],
    traps: [
      {
        title: "Scholar's Mate",
        // 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#
        uci: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'],
        note: 'Queen and bishop both hit f7. 3...Nf6?? attacks the queen but allows Qxf7 mate. Block with 3...g6 (or defend f7 with 3...Qe7); after 3...g6 4.Qf3 Nf6 Black is comfortable.',
        side: 'white',
        mistakes: [5],
      },
    ],
    moveNotes: {
      '1. e4': 'Grabs the center and opens lines for the queen and the f1 bishop.',
      '1. e4 e5': 'Black claims an equal share of the center.',
      '1. e4 e5 2. Nf3': 'Develops with a threat: the knight attacks e5.',
      '1. e4 e5 2. Nf3 Nc6': 'Defends e5 while developing a piece.',
      '1. e4 e5 2. Qh5': 'An early queen raid: it attacks e5 and f7, but it can be chased.',
      '1. e4 e5 2. Qh5 Nc6': 'Defends e5 first.',
      '1. e4 e5 2. Qh5 Nc6 3. Bc4': 'Now Qxf7 would be mate, so Black must react.',
      '1. e4 e5 2. Qh5 Nc6 3. Bc4 g6': "Blocks the queen's path to f7 and kicks it.",
      '1. e4 e5 2. Qh5 Nc6 3. Bc4 g6 4. Qf3': 'Renews the threat on f7.',
      '1. e4 e5 2. Qh5 Nc6 3. Bc4 g6 4. Qf3 Nf6': 'Shields f7 and develops. Black is already comfortable.',
    },
    mainLine: '1. e4 e5 2. Nf3 Nc6',
  },
  {
    family: "Bishop's Opening",
    side: 'white',
    level: 'beginner',
    summary:
      "After 1.e4 e5, 2.Bc4 develops the bishop at once and aims it at f7, Black's weakest point. White keeps the g1 knight and the f-pawn flexible, so the game can turn into an Italian Game, a Vienna Game or a quiet setup with d3. It is simple to play and hard to go badly wrong with.",
    ideasWhite: [
      'Develop the bishop first, then d3, Nf3 (or Nc3) and castle.',
      'Keep an eye on f7, and on a later f2-f4 break.',
      'If Black strikes with ...d5, retreat the bishop to b3, where it still aims at f7.',
    ],
    ideasBlack: [
      '2...Nf6 attacks e4 at once and is the main answer.',
      '...c6 and ...d5 take the center while the bishop is on c4.',
      'Develop and castle quickly, so f7 never becomes a target.',
    ],
    typicalPlans: [
      'White: Bc4, d3, Nf3, O-O, then c3 and a slow build-up, as in the Italian Game.',
      'Black: ...Nf6, ...c6 and ...d5, or a solid ...Bc5 and ...d6.',
    ],
    keyVariations: [
      {
        name: "Bishop's Opening: Berlin Defense",
        // 1. e4 e5 2. Bc4 Nf6
        uci: ['e2e4', 'e7e5', 'f1c4', 'g8f6'],
        note: 'The main answer: the knight develops and attacks e4.',
      },
      {
        name: "Bishop's Opening: Paulsen Defense",
        // 1. e4 e5 2. Bc4 Nf6 3. d3 c6
        uci: ['e2e4', 'e7e5', 'f1c4', 'g8f6', 'd2d3', 'c7c6'],
        note: 'Black prepares ...d5 to take the center.',
      },
      {
        name: "Bishop's Opening: Boi Variation",
        // 1. e4 e5 2. Bc4 Bc5
        uci: ['e2e4', 'e7e5', 'f1c4', 'f8c5'],
        note: 'Black copies the bishop move. Simple development is fine for both sides.',
      },
      {
        name: "Bishop's Opening: Urusov Gambit",
        // 1. e4 e5 2. Bc4 Nf6 3. d4 exd4 4. Nf3
        uci: ['e2e4', 'e7e5', 'f1c4', 'g8f6', 'd2d4', 'e5d4', 'g1f3'],
        note: 'White gives a pawn for quick development and attacking chances.',
      },
    ],
    moveNotes: {
      '1. e4': 'Grabs the center and opens lines for the queen and the f1 bishop.',
      '1. e4 e5': 'Black claims an equal share of the center.',
      '1. e4 e5 2. Bc4': "Develops the bishop at once and aims it at f7, the square only Black's king defends.",
      '1. e4 e5 2. Bc4 Nf6': 'The main answer: develops and attacks the e4 pawn.',
      '1. e4 e5 2. Bc4 Nf6 3. d3': 'Defends e4 calmly and opens the way for the c1 bishop.',
      '1. e4 e5 2. Bc4 Nf6 3. d3 c6': 'Prepares ...d5, to take the center while the bishop is on c4.',
      '1. e4 e5 2. Bc4 Nf6 3. d3 c6 4. Nf3': 'Develops with a threat: the knight attacks e5.',
      '1. e4 e5 2. Bc4 Nf6 3. d3 c6 4. Nf3 d5': 'Strikes in the center and attacks the bishop.',
      '1. e4 e5 2. Bc4 Nf6 3. d3 c6 4. Nf3 d5 5. Bb3':
        'The bishop steps back but still aims at f7. Black usually defends e5 with ...Bd6, and both sides castle soon.',
    },
  },
  {
    family: 'Italian Game',
    aka: ['Giuoco Piano', 'Two Knights Defense', 'Evans Gambit'],
    side: 'white',
    level: 'beginner',
    summary:
      "After 1.e4 e5 2.Nf3 Nc6 3.Bc4, the bishop aims at f7, Black's weakest point. It is one of the oldest openings and a great first choice: quick development, early castling, and either a direct c3-d4 plan or a slow build-up with d3.",
    ideasWhite: [
      'Castle early and keep the bishop on the a2-g8 diagonal.',
      'Prepare d4 with c3, or play d3 for a slow, safe build-up.',
      'In the slow lines, bring the b1 knight to g3 via d2 and f1.',
    ],
    ideasBlack: [
      '3...Bc5 (Giuoco Piano) copies White; 3...Nf6 (Two Knights) hits e4.',
      "Don't let a bishop and a knight gang up on f7 too early.",
      "Hit back with ...d5 when White's center is not ready.",
    ],
    typicalPlans: [
      'Giuoco Pianissimo: d3, c3, O-O, Re1 and Nbd2-f1-g3, a slow kingside build-up.',
      'Center attack: c3 and d4 to gain space; Black must hit back at e4 at once.',
      'Black often plays ...a6 and ...Ba7 to keep the bishop safe from d4 and b4.',
    ],
    keyVariations: [
      {
        name: 'Italian Game: Giuoco Piano',
        // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'],
        note: 'The "quiet game": both bishops aim at the enemy f-pawn.',
      },
      {
        name: 'Italian Game: Classical Variation, Giuoco Pianissimo',
        // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d3'],
        note: "Today's main line: White keeps the center solid and maneuvers.",
      },
      {
        name: 'Italian Game: Two Knights Defense, Knight Attack',
        // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5'],
        note: '4.Ng5 hits f7 twice. Black answers 4...d5, and after 5.exd5 the safe move is 5...Na5.',
      },
      {
        name: "Italian Game: Two Knights Defense, Modern Bishop's Opening",
        // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3'],
        note: 'The modern quiet choice: 4.d3 defends e4 and keeps every option.',
      },
      {
        name: 'Italian Game: Evans Gambit Accepted',
        // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'b2b4', 'c5b4'],
        note: 'White gives a pawn to win time for c3 and d4. Sharp and fun.',
      },
    ],
    traps: [
      {
        title: 'Fried Liver Attack',
        // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7 Kxf7 7. Qf3+ Ke6 8. Nc3
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5', 'f6d5', 'g5f7',
          'e8f7', 'd1f3', 'f7e6', 'b1c3',
        ],
        note: "After 5.exd5, retaking with 5...Nxd5? lets White sacrifice on f7 and drag the king to e6. White's attack is worth more than the piece. Play 5...Na5 instead.",
        side: 'white',
        mistakes: [9],
      },
      {
        title: 'Blackburne Shilling Trap',
        // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3#
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'c6d4', 'f3e5', 'd8g5', 'e5f7', 'g5g2', 'h1f1',
          'g2e4', 'c4e2', 'd4f3',
        ],
        note: '3...Nd4 is a cheap trap: 4.Nxe5? Qg5! hits e5 and g2, and 5.Nxf7?? loses to a quick mate with ...Nf3. Just play 4.Nxd4 exd4 5.O-O and White is better.',
        side: 'black',
        mistakes: [6, 8],
      },
    ],
    moveNotes: {
      '1. e4 e5 2. Nf3': 'Develops and attacks e5.',
      '1. e4 e5 2. Nf3 Nc6': 'Defends e5.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4': 'The Italian bishop: it eyes f7 and controls d5.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5': 'Black copies: the bishop eyes f2.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3': 'Prepares d4 and gives the bishop a retreat on c2 later.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6': 'Develops and attacks e4.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3': 'Defends e4 and keeps the center closed: the Giuoco Pianissimo.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6': 'Supports e5 and opens the c8 bishop.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. O-O': 'King safety first.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. O-O O-O': 'Both kings are safe; now the maneuvering starts.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. O-O O-O 7. Re1': 'Supports a later d4 and frees f1 for the knight (Nbd2-f1-g3).',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6': 'The Two Knights Defense: counterattacks e4 instead of copying.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5': 'Attacks f7 with knight and bishop.',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5': "The standard defense: block the bishop's line to f7.",
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5': 'Wins a pawn, and the d5 pawn now attacks the c6 knight (dxc6 is threatened).',
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Na5': 'Hits the bishop instead of retaking; this avoids the Fried Liver.',
    },
  },
  {
    family: 'Ruy Lopez',
    aka: ['Spanish Game', 'Spanish Opening'],
    side: 'white',
    level: 'intermediate',
    summary:
      '3.Bb5 attacks the knight that defends e5 and builds slow, lasting pressure. It is the most deeply studied 1.e4 e5 opening: White aims for a strong center with c3 and d4, while Black seeks solid equality or queenside counterplay.',
    ideasWhite: [
      'Pressure e5 indirectly by hitting its defender on c6.',
      'Castle, play Re1 and c3, then push d4.',
      'When kicked, the bishop retreats to a4, b3 or c2 and stays dangerous.',
    ],
    ideasBlack: [
      '3...a6 (Morphy Defense) asks the bishop to decide right away.',
      'Keep e5 firm; ...b5 and ...d6 make room for the pieces.',
      '3...Nf6 (Berlin) is rock-solid and often leads to an early endgame.',
    ],
    typicalPlans: [
      'Closed Ruy: White plays c3, h3, d4 and Nbd2-f1-g3; Black expands with ...Na5 and ...c5.',
      'Exchange (4.Bxc6): White plays for the endgame with a healthier pawn majority; Black uses the two bishops.',
    ],
    keyVariations: [
      {
        name: 'Ruy Lopez: Morphy Defense',
        // 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'],
        note: 'The main move. 4.Ba4 keeps the pressure; 4.Bxc6 is the Exchange Variation.',
      },
      {
        name: 'Ruy Lopez: Closed',
        // 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1',
          'b7b5', 'a4b3', 'd7d6', 'c2c3', 'e8g8', 'h2h3',
        ],
        note: 'The classical main line: h3 stops ...Bg4 so d4 can follow. Long maneuvering games.',
      },
      {
        name: 'Ruy Lopez: Berlin Defense, Berlin Wall',
        // 1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Nxe4 5. d4 Nd6 6. Bxc6 dxc6 7. dxe5 Nf5 8. Qxd8+ Kxd8 9. Nc3 Bd7
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'g8f6', 'e1g1', 'f6e4', 'd2d4', 'e4d6', 'b5c6',
          'd7c6', 'd4e5', 'd6f5', 'd1d8', 'e8d8', 'b1c3', 'c8d7',
        ],
        note: 'Queens come off early. Black can no longer castle, but the position is very solid.',
      },
      {
        name: 'Ruy Lopez: Exchange Variation',
        // 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5c6'],
        note: "White gives up the bishop to damage Black's pawns; Black gets the bishop pair.",
      },
      {
        name: 'Ruy Lopez: Marshall Attack',
        // 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. c3 d5
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1',
          'b7b5', 'a4b3', 'e8g8', 'c2c3', 'd7d5',
        ],
        note: 'Black gives a pawn for a fierce kingside attack; many White players avoid it with 8.a4 or 8.h3.',
      },
    ],
    traps: [
      {
        title: "Noah's Ark Trap",
        // 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 d6 5. d4 b5 6. Bb3 Nxd4 7. Nxd4 exd4 8. Qxd4 c5 9. Qd5 Be6 10. Qc6+ Bd7 11. Qd5 c4 12. Bxc4 bxc4 13. Qxc4
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'd7d6', 'd2d4', 'b7b5', 'a4b3',
          'c6d4', 'f3d4', 'e5d4', 'd1d4', 'c7c5', 'd4d5', 'c8e6', 'd5c6', 'e6d7', 'c6d5', 'c5c4',
          'b3c4', 'b5c4', 'd5c4',
        ],
        note: 'After ...a6, ...b5 and ...d6, retaking on d4 with the queen (8.Qxd4??) lets ...c5 and ...c4 trap the bishop on b3. White gets only two pawns for it. 8.c3 is a normal gambit instead.',
        side: 'black',
        mistakes: [14],
      },
    ],
    moveNotes: {
      '1. e4 e5 2. Nf3 Nc6 3. Bb5': 'Attacks the knight that guards e5.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6': 'Asks the bishop what it wants right away.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4': 'Keeps the pressure; Bxc6 stays possible later.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6': 'Develops and attacks e4.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O': 'Castles first. If ...Nxe4, White wins the pawn back with d4 or Re1.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7': 'Prepares to castle: the Closed Ruy Lopez.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1': 'Now e4 is defended, so Bxc6 and Nxe5 becomes a real threat.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5': 'Ends that threat by chasing the bishop.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3': 'The bishop keeps aiming at f7.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6': 'Supports e5 and opens the c8 bishop.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3': 'Prepares d4 and keeps c2 as a retreat for the bishop.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O': 'Black completes development.',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3': 'Stops ...Bg4 so that d4 can follow without a pin.',
    },
  },
  {
    family: 'Scotch Game',
    side: 'white',
    level: 'beginner',
    summary:
      '3.d4 opens the center at once. After 3...exd4 4.Nxd4 White has free development and a bit more space, without the long maneuvering of the Ruy Lopez. Kasparov brought it back to the top level.',
    ideasWhite: [
      'Trade the d-pawn for e5 and occupy the center with pieces.',
      'Use the e4 pawn and the open d-file for space and activity.',
      'Against 4...Nf6, 5.Nxc6 bxc6 6.e5 gains space with tempo.',
    ],
    ideasBlack: [
      'Take on d4 (3...exd4); holding e5 with ...d6 is passive.',
      'Hit back fast: ...Bc5 attacks the d4 knight, ...Nf6 attacks e4.',
      'Free the game with ...d5 when possible.',
    ],
    typicalPlans: [
      'Classical (4...Bc5): White trades on c6 or plays Be3 and c3; Black develops with ...Qf6 and ...Nge7.',
      'Schmidt (4...Nf6): after 5.Nxc6 bxc6 6.e5 Black has damaged pawns but active pieces.',
    ],
    keyVariations: [
      {
        name: 'Scotch Game: Classical Variation',
        // 1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Bc5
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'f3d4', 'f8c5'],
        note: 'Black attacks the d4 knight right away.',
      },
      {
        name: 'Scotch Game: Schmidt Variation',
        // 1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'f3d4', 'g8f6'],
        note: 'Black attacks e4; 5.Nxc6 bxc6 6.e5 is the main reply.',
      },
      {
        name: 'Scotch Game: Mieses Variation',
        // 1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 5. Nxc6 bxc6 6. e5
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'f3d4', 'g8f6', 'd4c6', 'b7c6', 'e4e5',
        ],
        note: 'White gains space and kicks the knight.',
      },
      {
        name: 'Scotch Game: Scotch Gambit',
        // 1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'f1c4'],
        note: 'White develops instead of recapturing; 4...Nf6 leads to Two Knights positions.',
      },
      {
        name: 'Scotch Game: Göring Gambit',
        // 1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. c3
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'c2c3'],
        note: 'White offers a pawn for fast development.',
      },
    ],
    traps: [
      {
        title: 'Sea-Cadet Mate',
        // 1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. c3 dxc3 5. Nxc3 d6 6. Bc4 Bg4 7. O-O Ne5 8. Nxe5 Bxd1 9. Bxf7+ Ke7 10. Nd5#
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4', 'c2c3', 'd4c3', 'b1c3', 'd7d6', 'f1c4',
          'c8g4', 'e1g1', 'c6e5', 'f3e5', 'g4d1', 'c4f7', 'e8e7', 'c3d5',
        ],
        note: 'In the Göring Gambit, the pin ...Bg4 plus 7...Ne5?? fails to 8.Nxe5! If 8...Bxd1??, Bxf7+ and Nd5 mate. Even 8...dxe5 9.Qxg4 leaves White a piece for a pawn ahead.',
        side: 'white',
        mistakes: [13, 15],
      },
    ],
    moveNotes: {
      '1. e4 e5 2. Nf3 Nc6 3. d4': 'Challenges e5 at once and opens the center.',
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4': "The usual reply: Black trades the e5 pawn for White's d-pawn instead of defending e5.",
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4': 'Recaptures with a centralized knight.',
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6': 'Counterattacks the e4 pawn.',
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 5. Nxc6': 'Trades knights so that e5 comes with tempo.',
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 5. Nxc6 bxc6': "Capturing toward the center; the b-file opens for Black's rook.",
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 5. Nxc6 bxc6 6. e5': 'Gains space and kicks the f6 knight.',
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 5. Nxc6 bxc6 6. e5 Qe7': 'Attacks e5; White must defend it.',
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 5. Nxc6 bxc6 6. e5 Qe7 7. Qe2': 'Defends e5 and blocks the e-file.',
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 5. Nxc6 bxc6 6. e5 Qe7 7. Qe2 Nd5': 'The knight finds a central square.',
      '1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 5. Nxc6 bxc6 6. e5 Qe7 7. Qe2 Nd5 8. c4': 'Kicks the knight again and grabs more space.',
    },
  },
  {
    family: 'Vienna Game',
    aka: ['Vienna Gambit'],
    side: 'white',
    level: 'beginner',
    summary:
      "2.Nc3 develops a knight and keeps the f-pawn free, so White can play f4 like a delayed King's Gambit. It is flexible and full of tactical chances at club level.",
    ideasWhite: [
      'Prepare f4 while the knight guards e4 and d5.',
      'Bc4 aims at f7; with f4 it can become a fast attack.',
      'g3 and Bg2 is a calmer setup that avoids theory.',
    ],
    ideasBlack: [
      '2...Nf6 is the most active reply and answers f4 with ...d5.',
      'Strike in the center with ...d5 whenever White plays f4.',
      'Watch f7: the c4 bishop and an early Qh5 can combine.',
    ],
    typicalPlans: [
      'Vienna Gambit: 3.f4 d5 4.fxe5 Nxe4 gives White space and an open f-file.',
      'With 3.Bc4 Nxe4 4.Qh5 the game becomes tactical very quickly.',
    ],
    keyVariations: [
      {
        name: 'Vienna Game: Falkbeer Variation',
        // 1. e4 e5 2. Nc3 Nf6
        uci: ['e2e4', 'e7e5', 'b1c3', 'g8f6'],
        note: 'The main reply: Black develops and eyes e4.',
      },
      {
        name: 'Vienna Game: Vienna Gambit',
        // 1. e4 e5 2. Nc3 Nf6 3. f4
        uci: ['e2e4', 'e7e5', 'b1c3', 'g8f6', 'f2f4'],
        note: "White pushes f4 like a King's Gambit; 3...d5 is the best answer.",
      },
      {
        name: 'Vienna Game: Stanley Variation',
        // 1. e4 e5 2. Nc3 Nf6 3. Bc4
        uci: ['e2e4', 'e7e5', 'b1c3', 'g8f6', 'f1c4'],
        note: 'The bishop points at f7 and invites tactics.',
      },
      {
        name: 'Vienna Game: Frankenstein-Dracula Variation',
        // 1. e4 e5 2. Nc3 Nf6 3. Bc4 Nxe4
        uci: ['e2e4', 'e7e5', 'b1c3', 'g8f6', 'f1c4', 'f6e4'],
        note: 'Black grabs e4; after 4.Qh5 Nd6 5.Bb3 the game gets wild.',
      },
      {
        name: 'Vienna Game: Max Lange Defense',
        // 1. e4 e5 2. Nc3 Nc6
        uci: ['e2e4', 'e7e5', 'b1c3', 'b8c6'],
        note: 'Solid: Black mirrors White with the knight.',
      },
    ],
    traps: [
      {
        title: 'The wrong knight retreat',
        // 1. e4 e5 2. Nc3 Nf6 3. Bc4 Nxe4 4. Qh5 Nf6 5. Qxf7#
        uci: ['e2e4', 'e7e5', 'b1c3', 'g8f6', 'f1c4', 'f6e4', 'd1h5', 'e4f6', 'h5f7'],
        note: 'After 3...Nxe4 4.Qh5 the knight must go back to d6 to cover f7. 4...Nf6?? attacks the queen but allows Qxf7 mate.',
        side: 'white',
        mistakes: [7],
      },
    ],
    moveNotes: {
      '1. e4 e5 2. Nc3': 'Develops and guards e4 and d5; f4 can come next.',
      '1. e4 e5 2. Nc3 Nf6': 'Develops and gets ready to answer f4 with ...d5.',
      '1. e4 e5 2. Nc3 Nf6 3. f4': 'The Vienna Gambit: attacks e5 and opens the f-file.',
      '1. e4 e5 2. Nc3 Nf6 3. f4 d5': 'The best reply: strike back in the center.',
      '1. e4 e5 2. Nc3 Nf6 3. f4 d5 4. fxe5': 'Takes on e5 and gains space.',
      '1. e4 e5 2. Nc3 Nf6 3. f4 d5 4. fxe5 Nxe4': 'The knight jumps to a strong central square.',
      '1. e4 e5 2. Nc3 Nf6 3. f4 d5 4. fxe5 Nxe4 5. Nf3': 'Develops and guards the e5 pawn.',
    },
  },
  {
    family: "King's Gambit",
    aka: ["King's Gambit Accepted", "King's Gambit Declined"],
    side: 'white',
    level: 'intermediate',
    summary:
      "2.f4 offers a pawn to pull Black's e5 pawn away, open the f-file and build a big center with d4. It was the romantic favorite of the 1800s: risky, but full of attacking chances.",
    ideasWhite: [
      'Open the f-file for the rook, aiming at f7.',
      'Build the center with d4 and develop fast.',
      'Mind your king: f4 weakens the e1-h4 diagonal.',
    ],
    ideasBlack: [
      'Accepting with 2...exf4 and then ...d5 or ...d6 is fine.',
      'Use the weakened diagonals: ...Qh4+ along e1-h4, and ...Bc5 along a7-g1 to stop White castling.',
      'Giving the pawn back for fast development is often the safest path.',
    ],
    typicalPlans: [
      'After 2...exf4 3.Nf3, White aims for d4, Bc4 or Bd3, castles, then wins back f4.',
      'Black can hold f4 with ...g5 or return the pawn with ...d5 for free development.',
    ],
    keyVariations: [
      {
        name: "King's Gambit Accepted",
        // 1. e4 e5 2. f4 exf4
        uci: ['e2e4', 'e7e5', 'f2f4', 'e5f4'],
        note: 'Black takes; White gets the center and the f-file.',
      },
      {
        name: "King's Gambit Accepted: Fischer Defense",
        // 1. e4 e5 2. f4 exf4 3. Nf3 d6
        uci: ['e2e4', 'e7e5', 'f2f4', 'e5f4', 'g1f3', 'd7d6'],
        note: 'Black stops Ne5 and prepares ...g5 to keep the pawn.',
      },
      {
        name: "King's Gambit Accepted: Modern Defense",
        // 1. e4 e5 2. f4 exf4 3. Nf3 d5 4. exd5
        uci: ['e2e4', 'e7e5', 'f2f4', 'e5f4', 'g1f3', 'd7d5', 'e4d5'],
        note: 'Black strikes in the center and develops quickly instead of clinging to material.',
      },
      {
        name: "King's Gambit Declined: Falkbeer Countergambit",
        // 1. e4 e5 2. f4 d5
        uci: ['e2e4', 'e7e5', 'f2f4', 'd7d5'],
        note: 'Black answers with a counter-gambit in the center.',
      },
      {
        name: "King's Gambit Declined: Classical Variation",
        // 1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. c3
        uci: ['e2e4', 'e7e5', 'f2f4', 'f8c5', 'g1f3', 'd7d6', 'c2c3'],
        note: 'The c5 bishop keeps White from castling short.',
      },
    ],
    traps: [
      {
        title: 'Greedy 3.fxe5',
        // 1. e4 e5 2. f4 Bc5 3. fxe5 Qh4+ 4. g3 Qxe4+ 5. Qe2 Qxh1
        uci: ['e2e4', 'e7e5', 'f2f4', 'f8c5', 'f4e5', 'd8h4', 'g2g3', 'h4e4', 'd1e2', 'e4h1'],
        note: 'Against 2...Bc5, grabbing 3.fxe5?? loses: 3...Qh4+ 4.g3 Qxe4+ forks king and rook (4.Ke2 Qxe4 is mate). Play 3.Nf3 instead.',
        side: 'black',
        mistakes: [4],
      },
    ],
    moveNotes: {
      '1. e4 e5 2. f4': 'Offers a pawn to pull e5 away and open the f-file.',
      '1. e4 e5 2. f4 exf4': 'Accepts the gambit.',
      '1. e4 e5 2. f4 exf4 3. Nf3': 'Develops and stops ...Qh4+.',
      '1. e4 e5 2. f4 exf4 3. Nf3 d5': "Strikes in the center so Black's pieces come out fast.",
      '1. e4 e5 2. f4 exf4 3. Nf3 d5 4. exd5': 'Removes the central pawn.',
      '1. e4 e5 2. f4 exf4 3. Nf3 d5 4. exd5 Nf6': 'Develops and attacks d5.',
    },
  },
  {
    family: 'Four Knights Game',
    aka: ['Three Knights Opening'],
    side: 'white',
    level: 'beginner',
    summary:
      'All four knights come out: 1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6. It is a solid, classical opening built on simple development, ideal for learning sound principles. White usually continues 4.Bb5 (Spanish) or 4.d4 (Scotch).',
    ideasWhite: [
      'Develop quickly and castle; there are few early traps.',
      '4.Bb5 pressures the c6 knight; 4.d4 opens the center.',
      'Use the d5 square for a knight when it is safe.',
    ],
    ideasBlack: [
      'Copying White works for a while, but watch for pins on c6 and f6.',
      'Against 4.Bb5, 4...Nd4 (Rubinstein) is an active, respected answer.',
      'Free the game with ...d5 when White plays slowly.',
    ],
    typicalPlans: [
      'Spanish Four Knights: Bb5, O-O, d3 and Bg5 to pin the f6 knight.',
      'Scotch Four Knights: d4 and Nxd4 for an open game with active pieces.',
    ],
    keyVariations: [
      {
        name: 'Four Knights Game: Spanish Variation',
        // 1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6', 'f1b5'],
        note: 'The main line: the bishop pressures c6.',
      },
      {
        name: 'Four Knights Game: Spanish Variation, Rubinstein Variation',
        // 1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Nd4
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6', 'f1b5', 'c6d4'],
        note: 'Black counters with a knight jump; it is sound and annoying for White.',
      },
      {
        name: 'Four Knights Game: Scotch Variation',
        // 1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. d4
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6', 'd2d4'],
        note: 'White opens the center; 4...exd4 5.Nxd4 gives open, active play.',
      },
      {
        name: 'Four Knights Game: Halloween Gambit',
        // 1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Nxe5
        uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'b1c3', 'g8f6', 'f3e5'],
        note: 'A wild knight sacrifice for the center. Unsound, but dangerous in fast games.',
      },
    ],
    moveNotes: {
      '1. e4 e5 2. Nf3 Nc6 3. Nc3': 'Develops the other knight and guards e4.',
      '1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6': 'The fourth knight: the Four Knights Game.',
      '1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5': 'The Spanish Four Knights: pressure on c6.',
      '1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bb4': "Black copies, pressuring White's c3 knight in turn.",
      '1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bb4 5. O-O O-O': 'Both kings are safe.',
      '1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bb4 5. O-O O-O 6. d3': 'Opens the c1 bishop and solidifies e4.',
      '1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bb4 5. O-O O-O 6. d3 d6': 'Black does the same.',
      '1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bb4 5. O-O O-O 6. d3 d6 7. Bg5': 'Pins the f6 knight; the symmetry must break soon.',
    },
  },
  {
    family: "Petrov's Defense",
    aka: ['Russian Game', 'Petroff Defense', "Petroff's Defense"],
    side: 'black',
    level: 'beginner',
    summary:
      'Black answers 2.Nf3 by counterattacking e4 with 2...Nf6 instead of defending e5. It is one of the most solid replies to 1.e4 and a favorite of players who want safe equality.',
    ideasWhite: [
      'After 3.Nxe5 d6, retreat the knight to f3 before anything else.',
      'Use the small lead in development: d4, Bd3, O-O and c4.',
      'The Nimzowitsch Attack (5.Nc3) avoids the most symmetrical lines.',
    ],
    ideasBlack: [
      'Play 3...d6 first, then take on e4.',
      'Develop quickly and castle; the symmetrical position is sound.',
      'Support the e4 knight with ...d5 and ...Bd6.',
    ],
    typicalPlans: [
      'Classical Attack: 5.d4 d5 6.Bd3 with symmetrical development; White plays c4 to undermine the e4 knight.',
      'Nimzowitsch Attack: 5.Nc3 Nxc3 6.dxc3 and often opposite-side castling, a sharper try.',
    ],
    keyVariations: [
      {
        name: "Petrov's Defense: Classical Attack",
        // 1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. d4
        uci: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3e5', 'd7d6', 'e5f3', 'f6e4', 'd2d4'],
        note: 'The main line; Black follows with ...d5 and ...Bd6 or ...Be7.',
      },
      {
        name: "Petrov's Defense: Nimzowitsch Attack",
        // 1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. Nc3
        uci: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3e5', 'd7d6', 'e5f3', 'f6e4', 'b1c3'],
        note: 'White trades knights and often castles long for an attack.',
      },
      {
        name: "Petrov's Defense: Modern Attack",
        // 1. e4 e5 2. Nf3 Nf6 3. d4
        uci: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'd2d4'],
        note: "3.d4 opens the center at once; 3...Nxe4 is Black's main reply.",
      },
      {
        name: "Petrov's Defense: Three Knights Game",
        // 1. e4 e5 2. Nf3 Nf6 3. Nc3
        uci: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'b1c3'],
        note: 'White declines the symmetry; 3...Nc6 transposes to the Four Knights.',
      },
      {
        name: "Petrov's Defense: Stafford Gambit",
        // 1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nc6
        uci: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3e5', 'b8c6'],
        note: 'A trappy gambit popular online. With careful play White stays a pawn up and better.',
      },
    ],
    traps: [
      {
        title: 'Copycat 3...Nxe4',
        // 1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nxe4 4. Qe2 Nf6 5. Nc6+ Qe7 6. Nxe7 Bxe7
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3e5', 'f6e4', 'd1e2', 'e4f6', 'e5c6', 'd8e7', 'c6e7',
          'f8e7',
        ],
        note: 'Taking back on e4 at once is the classic mistake: 3...Nxe4? 4.Qe2! and 4...Nf6?? 5.Nc6+ wins the queen with a discovered check. Play 3...d6 first.',
        side: 'white',
        mistakes: [5, 7],
      },
      {
        title: 'Stafford Gambit mate',
        // 1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nc6 4. Nxc6 dxc6 5. d3 Bc5 6. Bg5 Nxe4 7. Bxd8 Bxf2+ 8. Ke2 Bg4#
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3e5', 'b8c6', 'e5c6', 'd7c6', 'd2d3', 'f8c5', 'c1g5',
          'f6e4', 'g5d8', 'c5f2', 'e1e2', 'c8g4',
        ],
        note: 'What Stafford players hope for: 6.Bg5?? Nxe4! and taking the queen allows ...Bxf2+ and ...Bg4 mate. As White, play 6.Be2 and stay a pawn up.',
        side: 'black',
        mistakes: [10],
      },
    ],
    moveNotes: {
      '1. e4 e5 2. Nf3': 'Develops and attacks e5.',
      '1. e4 e5 2. Nf3 Nf6': 'Counterattacks e4 instead of defending e5.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5': 'Takes the pawn; Black must not copy at once.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6': 'Kicks the knight first.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3': 'The knight retreats to its best square.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4': 'Now Black wins the pawn back safely.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. d4': 'Takes the center: the Classical Attack.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. d4 d5': 'Supports the e4 knight.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. d4 d5 6. Bd3': 'Develops with pressure on e4.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. d4 d5 6. Bd3 Bd6': 'Develops and prepares to castle.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. d4 d5 6. Bd3 Bd6 7. O-O O-O': 'Both sides castle.',
      '1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. d4 d5 6. Bd3 Bd6 7. O-O O-O 8. c4': "Undermines d5, the e4 knight's support.",
    },
  },
  {
    family: 'Philidor Defense',
    side: 'black',
    level: 'beginner',
    summary:
      '2...d6 defends e5 with a pawn. It is solid and easy to learn but a bit passive: Black builds a sturdy pawn chain and aims for ...Nf6, ...Be7 and ...O-O.',
    ideasWhite: [
      'Grab space with d4 and develop freely.',
      "Use Bc4 and pressure on f7, but don't overpress.",
      'If Black gives up the center with ...exd4, use the extra space.',
    ],
    ideasBlack: [
      'Either hold e5 (...Nf6 and ...Nbd7) or trade with ...exd4 and play actively.',
      'Avoid an early ...Bg4 pin when Nxe5 tactics work.',
      'Castle quickly, then ...c6 and ...b5, or ...Re8 against e4.',
    ],
    typicalPlans: [
      'Exchange line: 3.d4 exd4 4.Nxd4 Nf6 5.Nc3 Be7: Black castles, plays ...Re8 and targets e4.',
      'Lion setup: ...Nf6, ...Nbd7, ...Be7 and ...c6, a compact wall that keeps e5.',
    ],
    keyVariations: [
      {
        name: 'Philidor Defense: Exchange Variation',
        // 1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Nxd4 Nf6
        uci: ['e2e4', 'e7e5', 'g1f3', 'd7d6', 'd2d4', 'e5d4', 'f3d4', 'g8f6'],
        note: 'Black gives up the center for free piece play.',
      },
      {
        name: 'Philidor Defense: Lion Variation',
        // 1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3 Nbd7
        uci: ['e2e4', 'e7e5', 'g1f3', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'b8d7'],
        note: 'Black keeps the pawn on e5 behind a solid wall.',
      },
      {
        name: 'Philidor Defense: Hanham Variation',
        // 1. e4 e5 2. Nf3 d6 3. d4 Nd7
        uci: ['e2e4', 'e7e5', 'g1f3', 'd7d6', 'd2d4', 'b8d7'],
        note: 'Holds e5 with the knight; solid but cramped.',
      },
      {
        name: 'Philidor Defense: Philidor Countergambit',
        // 1. e4 e5 2. Nf3 d6 3. d4 f5
        uci: ['e2e4', 'e7e5', 'g1f3', 'd7d6', 'd2d4', 'f7f5'],
        note: 'A risky counter-gambit; usually good for White.',
      },
    ],
    traps: [
      {
        title: "Légal's Mate",
        // 1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5#
        uci: [
          'e2e4', 'e7e5', 'g1f3', 'd7d6', 'f1c4', 'c8g4', 'b1c3', 'g7g6', 'f3e5', 'g4d1', 'c4f7',
          'e8e7', 'c3d5',
        ],
        note: 'After 4...g6?, 5.Nxe5! offers the queen. 5...Bxd1?? allows mate with three minor pieces, and 5...dxe5 6.Qxg4 still leaves White a pawn up.',
        side: 'white',
        mistakes: [7, 9],
      },
    ],
    moveNotes: {
      '1. e4 e5 2. Nf3': 'Attacks e5.',
      '1. e4 e5 2. Nf3 d6': 'The Philidor: defends e5 with a pawn.',
      '1. e4 e5 2. Nf3 d6 3. d4': 'Takes the center and challenges e5.',
      '1. e4 e5 2. Nf3 d6 3. d4 Nf6': 'Develops and attacks e4.',
      '1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3': 'Defends e4.',
      '1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3 Nbd7': 'The Lion setup: e5 is held by a knight.',
      '1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3 Nbd7 5. Bc4': 'Aims at f7.',
      '1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3 Nbd7 5. Bc4 Be7': 'Prepares to castle.',
      '1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3 Nbd7 5. Bc4 Be7 6. O-O O-O': 'Black is solid; ...c6 and ...b5 are typical next.',
    },
  },
  {
    family: 'Sicilian Defense',
    side: 'black',
    level: 'intermediate',
    summary:
      "1...c5 fights for d4 from the side and creates an unbalanced game. In the Open Sicilian (2.Nf3 and 3.d4) Black trades a wing pawn for White's center pawn and gets a half-open c-file and long-term chances. It is the most popular answer to 1.e4 among strong players.",
    ideasWhite: [
      'Open Sicilian: 2.Nf3, 3.d4 and fast development, often with a kingside attack.',
      'Use the extra space; the d5 square is a key outpost.',
      'Anti-Sicilians (Alapin 2.c3, Closed 2.Nc3, Smith-Morra) avoid heavy theory.',
    ],
    ideasBlack: [
      'Use the half-open c-file: rooks and queen go to c8 and c7.',
      'Expand on the queenside with ...a6 and ...b5.',
      'Break with ...d5 when it works; it often equalizes at once.',
    ],
    typicalPlans: [
      'Opposite-side castling races: White storms the kingside, Black the queenside.',
      'Najdorf (5...a6) and Scheveningen (...e6 and ...d6): a flexible small center. Dragon (5...g6): the bishop on the long diagonal.',
      'Sveshnikov (...e5): Black accepts a hole on d5 for active pieces.',
    ],
    keyVariations: [
      {
        name: 'Sicilian Defense: Najdorf Variation',
        // 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6
        uci: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'],
        note: '5...a6 controls b5 and prepares ...e5 or ...e6. The most famous Sicilian.',
      },
      {
        name: 'Sicilian Defense: Dragon Variation',
        // 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6
        uci: ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'g7g6'],
        note: 'Black fianchettoes; the Yugoslav Attack (Be3, f3, Qd2, O-O-O) is the sharpest reply.',
      },
      {
        name: 'Sicilian Defense: Lasker-Pelikan Variation, Sveshnikov Variation',
        // 1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e5 6. Ndb5 d6 7. Bg5 a6 8. Na3 b5
        uci: [
          'e2e4', 'c7c5', 'g1f3', 'b8c6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'e7e5', 'd4b5',
          'd7d6', 'c1g5', 'a7a6', 'b5a3', 'b7b5',
        ],
        note: 'Black accepts a weak d5 square (and, after Bxf6, doubled f-pawns) for active pieces and the bishop pair.',
      },
      {
        name: 'Sicilian Defense: Alapin Variation',
        // 1. e4 c5 2. c3
        uci: ['e2e4', 'c7c5', 'c2c3'],
        note: 'White prepares d4 to keep a full pawn center; 2...Nf6 and 2...d5 are good replies.',
      },
      {
        name: 'Sicilian Defense: Smith-Morra Gambit',
        // 1. e4 c5 2. d4 cxd4 3. c3
        uci: ['e2e4', 'c7c5', 'd2d4', 'c5d4', 'c2c3'],
        note: 'White gives a pawn for fast development. Accepting and developing calmly is fine for Black.',
      },
    ],
    traps: [
      {
        title: 'Magnus Smith Trap',
        // 1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 d6 6. Bc4 g6 7. Nxc6 bxc6 8. e5 dxe5 9. Bxf7+ Kxf7 10. Qxd8
        uci: [
          'e2e4', 'c7c5', 'g1f3', 'b8c6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'd7d6', 'f1c4',
          'g7g6', 'd4c6', 'b7c6', 'e4e5', 'd6e5', 'c4f7', 'e8f7', 'd1d8',
        ],
        note: 'After 8.e5, the natural 8...dxe5?? loses the queen to Bxf7+ and Qxd8. Move the knight instead, for example 8...Ng4.',
        side: 'white',
        mistakes: [15],
      },
      {
        title: 'Siberian Trap',
        // 1. e4 c5 2. d4 cxd4 3. c3 dxc3 4. Nxc3 Nc6 5. Nf3 e6 6. Bc4 Qc7 7. Qe2 Nf6 8. O-O Ng4 9. h3 Nd4 10. Nxd4 Qh2#
        uci: [
          'e2e4', 'c7c5', 'd2d4', 'c5d4', 'c2c3', 'd4c3', 'b1c3', 'b8c6', 'g1f3', 'e7e6', 'f1c4',
          'd8c7', 'd1e2', 'g8f6', 'e1g1', 'f6g4', 'h2h3', 'c6d4', 'f3d4', 'c7h2',
        ],
        note: 'In the Smith-Morra, the routine 9.h3?? fails to 9...Nd4!: the queen is attacked and 10.Nxd4 allows ...Qh2 mate, so White loses the queen. 9.Rd1 is correct.',
        side: 'black',
        mistakes: [16],
      },
    ],
    moveNotes: {
      '1. e4 c5': 'Fights for d4 from the side and unbalances the game.',
      '1. e4 c5 2. Nf3': 'Prepares d4.',
      '1. e4 c5 2. Nf3 d6': 'Controls e5 and opens the c8 bishop.',
      '1. e4 c5 2. Nf3 d6 3. d4': 'Opens the center: the Open Sicilian.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4': 'Trades a wing pawn for a center pawn.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4': 'White leads in development and has more space.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6': 'Attacks e4; White defends it with Nc3.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3': 'Defends e4 and develops.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6': 'The Najdorf: covers b5 and prepares ...e5 or ...e6.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be2': 'A calm, classical setup: castle and fight for d5.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be2 e5': 'Kicks the knight and gains space, leaving a hole on d5.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be2 e5 7. Nb3': 'The knight retreats to safety.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be2 e5 7. Nb3 Be7': 'Prepares to castle; ...Be6 will cover d5.',
      '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be2 e5 7. Nb3 Be7 8. O-O O-O': 'Both kings are safe; the fight is about d5.',
    },
  },
  {
    family: 'French Defense',
    side: 'black',
    level: 'intermediate',
    summary:
      "1...e6 and 2...d5 challenge e4 with a pawn. Black gets a solid but slightly cramped position, often with a locked pawn chain; the c8 bishop is the usual problem piece. The plan is to attack White's center with ...c5 and ...f6.",
    ideasWhite: [
      "Advance with e5 to gain space and cramp Black's kingside.",
      'Attack on the kingside, where the extra space is.',
      'Keep d4, the base of the pawn chain, well defended.',
    ],
    ideasBlack: [
      "Hit the base of White's chain with ...c5 and its head with ...f6.",
      'Pile up on d4 with ...Nc6, ...Qb6 and a knight on f5.',
      'Find work for the c8 bishop (...b6 and ...Ba6, or ...Bd7).',
    ],
    typicalPlans: [
      'Advance: 3.e5 c5 4.c3 Nc6 5.Nf3 Qb6, all aimed at d4.',
      "Winawer: 3.Nc3 Bb4 pins the knight; Black often trades it to double White's pawns.",
      'Classical: 3.Nc3 Nf6 4.Bg5 or 4.e5, a central fight.',
    ],
    keyVariations: [
      {
        name: 'French Defense: Advance Variation',
        // 1. e4 e6 2. d4 d5 3. e5
        uci: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'e4e5'],
        note: 'White grabs space; Black hits back with ...c5 at once.',
      },
      {
        name: 'French Defense: Winawer Variation',
        // 1. e4 e6 2. d4 d5 3. Nc3 Bb4
        uci: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1c3', 'f8b4'],
        note: 'Black pins the knight and pressures e4; 4.e5 c5 5.a3 is sharp.',
      },
      {
        name: 'French Defense: Classical Variation',
        // 1. e4 e6 2. d4 d5 3. Nc3 Nf6
        uci: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1c3', 'g8f6'],
        note: 'Black develops and attacks e4; 4.Bg5 and 4.e5 are the main tries.',
      },
      {
        name: 'French Defense: Tarrasch Variation',
        // 1. e4 e6 2. d4 d5 3. Nd2
        uci: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'b1d2'],
        note: 'The d2 knight avoids the Winawer pin but blocks the c1 bishop for a while.',
      },
      {
        name: 'French Defense: Exchange Variation',
        // 1. e4 e6 2. d4 d5 3. exd5
        uci: ['e2e4', 'e7e6', 'd2d4', 'd7d5', 'e4d5'],
        note: "Symmetrical and quiet; Black's c8 bishop is free after ...exd5.",
      },
    ],
    traps: [
      {
        title: 'Queen lost on d4',
        // 1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Nf3 Qb6 6. Bd3 cxd4 7. cxd4 Nxd4 8. Nxd4 Qxd4 9. Bb5+ Kd8 10. Qxd4
        uci: [
          'e2e4', 'e7e6', 'd2d4', 'd7d5', 'e4e5', 'c7c5', 'c2c3', 'b8c6', 'g1f3', 'd8b6', 'f1d3',
          'c5d4', 'c3d4', 'c6d4', 'f3d4', 'b6d4', 'd3b5', 'e8d8', 'd1d4',
        ],
        note: "With White's bishop on d3, grabbing 7...Nxd4?? loses: 8.Nxd4 Qxd4?? 9.Bb5+ uncovers the d1 queen. Play 7...Bd7 first to cover b5.",
        side: 'white',
        mistakes: [13, 15],
      },
    ],
    moveNotes: {
      '1. e4 e6': 'Prepares ...d5 so Black can challenge e4 with a pawn.',
      '1. e4 e6 2. d4 d5': 'Attacks e4: White must defend, trade or advance.',
      '1. e4 e6 2. d4 d5 3. e5': 'The Advance: space now, but the d4 base needs care.',
      '1. e4 e6 2. d4 d5 3. e5 c5': 'Strikes at the base of the chain.',
      '1. e4 e6 2. d4 d5 3. e5 c5 4. c3': 'Supports d4 with a pawn.',
      '1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6': 'More pressure on d4.',
      '1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Nf3': 'Defends d4 again.',
      '1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Nf3 Qb6': 'A third attacker on d4, also eyeing b2.',
      '1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Nf3 Qb6 6. a3': 'Prepares b4 to grab queenside space.',
    },
  },
  {
    family: 'Caro-Kann Defense',
    side: 'black',
    level: 'beginner',
    summary:
      "1...c6 prepares ...d5 with a pawn chain that is very hard to break. Unlike in the French, Black's light-squared bishop gets out before ...e6. The result is a solid, reliable defense with a healthy structure and good endgames.",
    ideasWhite: [
      'Gain space with e5, or trade on d5 and play for piece activity.',
      'In the Classical, chase the f5 bishop with Ng3 and h4.',
      'Castle long and attack in the main lines.',
    ],
    ideasBlack: [
      'Develop the c8 bishop to f5 or g4 before playing ...e6.',
      'Challenge the center with ...c5 at the right moment.',
      'Aim for a solid structure; Black is happy in the endgame.',
    ],
    typicalPlans: [
      'Advance: 3.e5 Bf5, then ...e6, ...c5 and ...Nc6 against d4.',
      'Classical: 4...Bf5 5.Ng3 Bg6 6.h4 h6: Black stays solid and castles later.',
      'Exchange and Panov: symmetrical or isolated-pawn structures with open lines.',
    ],
    keyVariations: [
      {
        name: 'Caro-Kann Defense: Advance Variation',
        // 1. e4 c6 2. d4 d5 3. e5
        uci: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5'],
        note: 'White takes space; Black develops 3...Bf5 and plays ...e6 and ...c5.',
      },
      {
        name: 'Caro-Kann Defense: Classical Variation',
        // 1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5
        uci: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'c8f5'],
        note: 'The bishop comes out first; White gains time on it with Ng3 and h4.',
      },
      {
        name: 'Caro-Kann Defense: Karpov Variation',
        // 1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nd7
        uci: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'b8d7'],
        note: 'Prepares ...Ngf6 without allowing doubled pawns.',
      },
      {
        name: 'Caro-Kann Defense: Exchange Variation',
        // 1. e4 c6 2. d4 d5 3. exd5 cxd5
        uci: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4d5', 'c6d5'],
        note: 'Symmetrical and calm; White usually follows with Bd3 and c3.',
      },
      {
        name: 'Caro-Kann Defense: Panov Attack',
        // 1. e4 c6 2. d4 d5 3. exd5 cxd5 4. c4
        uci: ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4d5', 'c6d5', 'c2c4'],
        note: "White plays for an isolated queen's pawn and active pieces.",
      },
    ],
    traps: [
      {
        title: 'Smothered mate on d6',
        // 1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nd7 5. Qe2 Ngf6 6. Nd6#
        uci: [
          'e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4', 'b8d7', 'd1e2', 'g8f6', 'e4d6',
        ],
        note: 'In the Karpov line, 5.Qe2 sets a trap: 5...Ngf6?? 6.Nd6 is smothered mate. The queen on e2 pins the e7 pawn, and the d7 knight blocks the king. Play 5...Ndf6 instead.',
        side: 'white',
        mistakes: [9],
      },
    ],
    moveNotes: {
      '1. e4 c6': 'Prepares ...d5 while keeping the c8 bishop free.',
      '1. e4 c6 2. d4 d5': 'Challenges e4 with a well-supported pawn.',
      '1. e4 c6 2. d4 d5 3. Nc3': 'Defends e4 with a piece.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4': 'Trades in the center; next Black develops with tempo on the e4 knight (4...Bf5).',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4': "White's knight is centralized.",
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5': 'The Classical: the bishop develops with tempo.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3': 'Attacks the bishop.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6': 'Keeps the bishop on its active diagonal.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4': "Threatens h5, which would trap the bishop: its retreat to h7 is blocked by Black's own pawn.",
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6': 'Gives the bishop a retreat on h7.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3': 'Develops; h5 is coming.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7': 'Prepares ...Ngf6 and stops Ne5.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7 8. h5': "Gains space and fixes Black's kingside.",
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7 8. h5 Bh7': 'The bishop steps back.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7 8. h5 Bh7 9. Bd3': 'Offers a trade of light-squared bishops.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7 8. h5 Bh7 9. Bd3 Bxd3': 'Black happily trades.',
      '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7 8. h5 Bh7 9. Bd3 Bxd3 10. Qxd3': 'White keeps a little space; Black is solid.',
    },
  },
  {
    family: 'Scandinavian Defense',
    aka: ['Center Counter Defense', 'Center Counter Game'],
    side: 'black',
    level: 'beginner',
    summary:
      '1...d5 attacks e4 at once. After 2.exd5 Qxd5 the queen comes out early, but the plan is simple: retreat it to a5 or d6, develop quickly, and build a solid Caro-Kann-like setup with ...c6.',
    ideasWhite: [
      'Gain time by attacking the queen with Nc3.',
      'Build a center with d4 and develop smoothly.',
      'Use the lead in development before Black finishes castling.',
    ],
    ideasBlack: [
      'After 3.Nc3, put the queen on a5 or d6, away from more kicks.',
      'Develop the c8 bishop to f5 or g4, then play ...e6 and ...c6.',
      '2...Nf6 (Modern) wins the pawn back later with the knight instead.',
    ],
    typicalPlans: [
      'Main line: ...Qa5, ...Nf6, ...Bf5, ...e6 and ...c6, a solid setup.',
      '3...Qd6: the queen is less exposed; Black follows with ...Nf6, ...a6 or ...c6, and a bishop to f5 or g4.',
    ],
    keyVariations: [
      {
        name: 'Scandinavian Defense: Mieses-Kotroc Variation',
        // 1. e4 d5 2. exd5 Qxd5
        uci: ['e2e4', 'd7d5', 'e4d5', 'd8d5'],
        note: 'The queen recaptures; 3.Nc3 will gain a tempo on it.',
      },
      {
        name: 'Scandinavian Defense: Main Line',
        // 1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5
        uci: ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5a5'],
        note: 'The classical retreat: the queen stays active and pins c3 once White plays d4.',
      },
      {
        name: 'Scandinavian Defense: Gubinsky-Melts Defense',
        // 1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd6
        uci: ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5d6'],
        note: 'The modern choice; the queen is safer on d6.',
      },
      {
        name: 'Scandinavian Defense: Modern Variation',
        // 1. e4 d5 2. exd5 Nf6
        uci: ['e2e4', 'd7d5', 'e4d5', 'g8f6'],
        note: 'Black regains the pawn with the knight a move later.',
      },
    ],
    moveNotes: {
      '1. e4 d5': 'Challenges e4 immediately.',
      '1. e4 d5 2. exd5': 'White takes and will gain time on the queen.',
      '1. e4 d5 2. exd5 Qxd5': 'Regains the pawn; the queen is exposed but central.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3': 'Develops with tempo on the queen.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5': 'A safe square; once White plays d4, the queen also pins the c3 knight.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4': 'Takes the center.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6': 'Develops and controls e4.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6 5. Nf3': 'Develops.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6 5. Nf3 Bf5': 'The bishop gets out before ...e6 and ...c6.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6 5. Nf3 Bf5 6. Bc4': 'Aims at f7 and e6.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6 5. Nf3 Bf5 6. Bc4 e6': 'Solid: blunts the c4 bishop.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6 5. Nf3 Bf5 6. Bc4 e6 7. Bd2': 'Breaks the pin; a knight move from c3 would now uncover an attack on the queen.',
      '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6 5. Nf3 Bf5 6. Bc4 e6 7. Bd2 c6': 'Covers d5 and b5 and gives the queen a way back.',
    },
  },
  {
    family: 'Pirc Defense',
    side: 'black',
    level: 'intermediate',
    summary:
      'Black lets White build a big center (1...d6, 2...Nf6, 3...g6) and then attacks it with pieces and pawn breaks; the g7 bishop is the key piece. The closely related Modern Defense (1...g6) holds back ...Nf6 to stay even more flexible.',
    ideasWhite: [
      'Build the center with e4 and d4, and often f4 (Austrian Attack).',
      'Attack with Be3, Qd2 and Bh6, sometimes castling long.',
      'Push e5 if Black is slow to challenge the center.',
    ],
    ideasBlack: [
      'Fianchetto (...g6, ...Bg7) and castle short.',
      'Hit the center with ...e5 or ...c5 at the right moment.',
      "Don't wait too long: give White's center a target.",
    ],
    typicalPlans: [
      'Austrian Attack: 4.f4 Bg7 5.Nf3 O-O; Black usually strikes back with ...c5.',
      "150 Attack: Be3, Qd2, Bh6 and sometimes h4 aim straight at Black's king.",
    ],
    keyVariations: [
      {
        name: 'Pirc Defense',
        // 1. e4 d6 2. d4 Nf6 3. Nc3 g6
        uci: ['e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6'],
        note: 'The basic Pirc position.',
      },
      {
        name: 'Pirc Defense: Austrian Attack',
        // 1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. f4 Bg7 5. Nf3 O-O
        uci: ['e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6', 'f2f4', 'f8g7', 'g1f3', 'e8g8'],
        note: 'The sharpest try: White builds a huge pawn center.',
      },
      {
        name: 'Pirc Defense: Classical Variation',
        // 1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7
        uci: ['e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6', 'g1f3', 'f8g7'],
        note: 'Calm development; White keeps a modest space edge.',
      },
      {
        name: 'Pirc Defense: 150 Attack',
        // 1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Be3 c6 5. Qd2
        uci: ['e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6', 'c1e3', 'c7c6', 'd1d2'],
        note: 'White aims for Bh6 and a kingside attack.',
      },
      {
        name: 'Modern Defense: Standard Defense',
        // 1. e4 g6 2. d4 Bg7 3. Nc3 d6
        uci: ['e2e4', 'g7g6', 'd2d4', 'f8g7', 'b1c3', 'd7d6'],
        note: 'The Modern move order: ...Nf6 is held back.',
      },
    ],
    moveNotes: {
      '1. e4 d6': 'Controls e5 and prepares ...Nf6.',
      '1. e4 d6 2. d4 Nf6': 'Attacks e4.',
      '1. e4 d6 2. d4 Nf6 3. Nc3': 'Defends e4.',
      '1. e4 d6 2. d4 Nf6 3. Nc3 g6': 'Prepares the fianchetto: the bishop will hit the center from g7.',
      '1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3': 'The Classical setup: simple development.',
      '1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7': 'The bishop takes the long diagonal.',
      '1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7 5. Be2': 'Prepares to castle.',
      '1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7 5. Be2 O-O': "Black's king is safe; now ...c6, ...c5, ...e5 or ...Bg4 can follow.",
      '1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7 5. Be2 O-O 6. O-O Bg4': 'Pressures the f3 knight, a defender of d4, before ...Nc6 or ...e5.',
    },
  },
  {
    family: 'Modern Defense',
    aka: ['Robatsch Defense'],
    side: 'black',
    level: 'intermediate',
    summary:
      'Black answers 1.e4 with 1...g6, lets White build a big pawn center, and then attacks it with the g7 bishop and pawn breaks such as ...c5 or ...e5. Black keeps ...Nf6 in reserve to stay flexible; played early, it turns the game into a Pirc Defense.',
    ideasWhite: [
      'Take the whole center with e4 and d4, and develop Nc3 and Nf3.',
      'Be3, Qd2 and Bh6 can trade off the strong g7 bishop.',
      'Push d5 or e5 when Black is slow to challenge the center.',
    ],
    ideasBlack: [
      'Fianchetto at once: ...g6 and ...Bg7 aim at d4.',
      'Strike at the center with ...c5, or with ...e5 after ...d6.',
      '...c6 and ...b5 can gain space on the queenside.',
    ],
    typicalPlans: [
      'Black: ...g6, ...Bg7, ...d6, then ...c6 and ...b5, or ...Nf6 and castling.',
      'White: Nc3, Nf3 and Be2 behind a solid center, or Be3 and Qd2 for an attack.',
    ],
    keyVariations: [
      {
        name: 'Modern Defense: Standard Defense',
        // 1. e4 g6 2. d4 Bg7 3. Nc3 d6
        uci: ['e2e4', 'g7g6', 'd2d4', 'f8g7', 'b1c3', 'd7d6'],
        note: 'The basic setup: ...d6 controls e5 and keeps ...Nf6 for later.',
      },
      {
        name: 'Modern Defense: Modern Pterodactyl',
        // 1. e4 g6 2. d4 Bg7 3. Nc3 c5
        uci: ['e2e4', 'g7g6', 'd2d4', 'f8g7', 'b1c3', 'c7c5'],
        note: 'Black hits d4 at once with ...c5, and the game gets sharp quickly.',
      },
      {
        name: 'Modern Defense: Three Pawns Attack',
        // 1. e4 g6 2. d4 Bg7 3. f4
        uci: ['e2e4', 'g7g6', 'd2d4', 'f8g7', 'f2f4'],
        note: 'White grabs even more space with f4; Black must hit back at the center soon.',
      },
      {
        name: 'Pirc Defense',
        // 1. e4 d6 2. d4 Nf6 3. Nc3 g6
        uci: ['e2e4', 'd7d6', 'd2d4', 'g8f6', 'b1c3', 'g7g6'],
        note: 'With an early ...Nf6 the game becomes a Pirc.',
      },
    ],
    moveNotes: {
      '1. e4 g6': 'Prepares ...Bg7. Black lets White take the center and plans to attack it later.',
      '1. e4 g6 2. d4': 'White builds the ideal two-pawn center.',
      '1. e4 g6 2. d4 Bg7': 'The bishop already aims at d4 along the long diagonal.',
      '1. e4 g6 2. d4 Bg7 3. Nc3': 'Develops and defends e4.',
      '1. e4 g6 2. d4 Bg7 3. Nc3 d6': 'Controls e5. Black keeps ...Nf6 in reserve: playing it now would make the game a Pirc.',
      '1. e4 g6 2. d4 Bg7 3. Nc3 d6 4. Nf3': "Simple development, the Two Knights setup: White's center is solid.",
      '1. e4 g6 2. d4 Bg7 3. Nc3 d6 4. Nf3 c6':
        'Covers d5 and b5 and prepares ...b5 or ...Qb6. Then ...Nf6 (or ...Nd7) and castling follow.',
    },
  },
  {
    family: 'Alekhine Defense',
    aka: ["Alekhine's Defense"],
    side: 'black',
    level: 'intermediate',
    summary:
      '1...Nf6 invites White to chase the knight with pawns. Black lets White build a big center and then attacks it, hoping the advanced pawns become targets. It is provocative and leads to unusual positions.',
    ideasWhite: [
      'Gain space with e5 and d4; c4 and f4 are optional and riskier.',
      'The Modern Variation (4.Nf3) keeps it simple and solid.',
      "Don't overextend: every pawn move leaves squares behind.",
    ],
    ideasBlack: [
      'Undermine e5 with ...d6, then ...c5, ...Nc6 or ...dxe5.',
      'Get the c8 bishop out (often to g4) before ...e6.',
      'From b6 the knight eyes c4 and d5; add pressure on d4 with ...Nc6 and ...Bg4.',
    ],
    typicalPlans: [
      'Modern: 4.Nf3 Bg4 5.Be2 e6 6.O-O Be7 7.c4 Nb6: Black pressures e5 and d4.',
      'Four Pawns Attack: White builds c4-d4-e5-f4; Black counters with ...dxe5, ...Bf5, ...e6 and ...c5.',
    ],
    keyVariations: [
      {
        name: 'Alekhine Defense: Modern Variation',
        // 1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3
        uci: ['e2e4', 'g8f6', 'e4e5', 'f6d5', 'd2d4', 'd7d6', 'g1f3'],
        note: 'Calm and popular: White develops and keeps a small edge.',
      },
      {
        name: 'Alekhine Defense: Modern Variation, Main Line',
        // 1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4
        uci: ['e2e4', 'g8f6', 'e4e5', 'f6d5', 'd2d4', 'd7d6', 'g1f3', 'c8g4'],
        note: 'Black pins the knight to fight for e5 and d4.',
      },
      {
        name: 'Alekhine Defense: Four Pawns Attack',
        // 1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. c4 Nb6 5. f4
        uci: ['e2e4', 'g8f6', 'e4e5', 'f6d5', 'd2d4', 'd7d6', 'c2c4', 'd5b6', 'f2f4'],
        note: 'White grabs maximum space; sharp and double-edged.',
      },
      {
        name: 'Alekhine Defense: Exchange Variation',
        // 1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. c4 Nb6 5. exd6
        uci: ['e2e4', 'g8f6', 'e4e5', 'f6d5', 'd2d4', 'd7d6', 'c2c4', 'd5b6', 'e5d6'],
        note: 'White releases the tension for a smaller space edge.',
      },
      {
        name: 'Alekhine Defense: Scandinavian Variation',
        // 1. e4 Nf6 2. Nc3 d5
        uci: ['e2e4', 'g8f6', 'b1c3', 'd7d5'],
        note: 'If White avoids e5, Black plays ...d5 anyway.',
      },
    ],
    moveNotes: {
      '1. e4 Nf6': 'Attacks e4 and invites the pawn forward.',
      '1. e4 Nf6 2. e5': 'Kicks the knight and gains space.',
      '1. e4 Nf6 2. e5 Nd5': 'The knight sits in the center.',
      '1. e4 Nf6 2. e5 Nd5 3. d4': 'Supports e5 and grabs the center.',
      '1. e4 Nf6 2. e5 Nd5 3. d4 d6': 'Starts undermining e5.',
      '1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3': 'The Modern Variation: develops and defends e5.',
      '1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4': 'Pins the knight that guards e5.',
      '1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4 5. Be2': 'Breaks the pin.',
      '1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4 5. Be2 e6': 'Opens the f8 bishop and supports d5.',
      '1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4 5. Be2 e6 6. O-O Be7': 'Prepares to castle.',
      '1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4 5. Be2 e6 6. O-O Be7 7. c4': 'Kicks the knight from d5.',
      '1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4 5. Be2 e6 6. O-O Be7 7. c4 Nb6': 'The knight retreats but still eyes c4 and d5.',
    },
  },
  {
    family: "Queen's Pawn Game",
    aka: ['Colle System', 'Torre Attack'],
    side: 'white',
    level: 'beginner',
    summary:
      "1.d4 takes the center with a pawn the queen already protects. Queen's Pawn Game names cover lines without an early c4: quiet systems such as the Colle, Torre and London, where White develops the same way against almost anything.",
    ideasWhite: [
      'Develop Nf3, a bishop, e3 and castle; the setup matters more than the move order.',
      'Colle: e3, Bd3, Nbd2, c3 and O-O, then e4.',
      'Torre: Bg5 pins the f6 knight; London: Bf4 (see its own guide).',
    ],
    ideasBlack: [
      '...d5, ...Nf6 and ...c5 is a sound, active answer.',
      'Develop the c8 bishop before ...e6 when you can (...Bf5 or ...Bg4).',
      'Question d4 with ...c5 and pressure it with ...Nc6.',
    ],
    typicalPlans: [
      "Colle: e3, Bd3, Nbd2, c3, O-O, then e4 to open lines toward Black's king.",
      'Zukertort setup: b3 and Bb2 with a knight jump to e5.',
    ],
    keyVariations: [
      {
        name: "Queen's Pawn Game: Symmetrical Variation",
        // 1. d4 d5 2. Nf3 Nf6
        uci: ['d2d4', 'd7d5', 'g1f3', 'g8f6'],
        note: 'Both sides develop; White now picks a system.',
      },
      {
        name: "Queen's Pawn Game: Colle System, Traditional Colle",
        // 1. d4 Nf6 2. Nf3 e6 3. e3 c5 4. Bd3 d5 5. c3
        uci: ['d2d4', 'g8f6', 'g1f3', 'e7e6', 'e2e3', 'c7c5', 'f1d3', 'd7d5', 'c2c3'],
        note: 'The classic Colle pyramid; e4 is the plan.',
      },
      {
        name: 'Torre Attack: Classical Defense',
        // 1. d4 Nf6 2. Nf3 e6 3. Bg5
        uci: ['d2d4', 'g8f6', 'g1f3', 'e7e6', 'c1g5'],
        note: "The Torre: Bg5 pins the knight, weakening Black's grip on e4.",
      },
      {
        name: "Queen's Pawn Game: Stonewall Attack",
        // 1. d4 d5 2. e3 Nf6 3. Bd3
        uci: ['d2d4', 'd7d5', 'e2e3', 'g8f6', 'f1d3'],
        note: 'White aims for f4 and Ne5 with a kingside attack.',
      },
    ],
    moveNotes: {
      '1. d4': 'Takes the center; the queen already protects this pawn.',
      '1. d4 d5': 'Black claims an equal share of the center.',
      '1. d4 d5 2. Nf3': 'Develops and controls e5.',
      '1. d4 d5 2. Nf3 Nf6': 'Develops and controls e4.',
      '1. d4 d5 2. Nf3 Nf6 3. e3': 'The Colle: solid, and opens the f1 bishop.',
      '1. d4 d5 2. Nf3 Nf6 3. e3 e6': 'Black mirrors and opens the f8 bishop.',
      '1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3': 'The bishop aims at h7.',
      '1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5': 'Hits d4, the standard plan.',
      '1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5 5. c3': 'Keeps d4 supported.',
      '1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5 5. c3 Nc6': 'More pressure on d4.',
      '1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5 5. c3 Nc6 6. Nbd2': 'Supports the e4 push.',
      '1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5 5. c3 Nc6 6. Nbd2 Bd6': 'Develops and aims at e5 and h2.',
      '1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5 5. c3 Nc6 6. Nbd2 Bd6 7. O-O O-O': 'Both sides are ready; White now prepares e4.',
    },
  },
  {
    family: "Queen's Gambit",
    aka: [
      "Queen's Gambit Declined: Albin Countergambit",
      "Queen's Gambit Declined: Chigorin Defense",
    ],
    side: 'white',
    level: 'beginner',
    summary:
      "1.d4 d5 2.c4 offers a wing pawn to pull Black's d-pawn away from the center. It is not a true gambit: if Black takes, White usually wins the pawn back. White aims for central control and lasting pressure.",
    ideasWhite: [
      'Use c4 to undermine d5 and prepare e4.',
      'Develop Nc3, Nf3 and Bg5 or Bf4, piling up on d5.',
      'If Black takes on c4, win it back with e3 and Bxc4 (or grab the center with e4).',
    ],
    ideasBlack: [
      '2...e6 (Declined) and 2...c6 (Slav) keep a pawn on d5.',
      "2...dxc4 (Accepted) gives up the center for free development; don't try to keep the pawn.",
      'Free the game later with ...c5 or ...e5.',
    ],
    typicalPlans: [
      "Minority attack: in the Exchange QGD, White pushes b4-b5 to weaken Black's queenside.",
      'Central build-up: Nc3, Nf3, e3, Bd3, O-O, then e4.',
    ],
    keyVariations: [
      {
        name: "Queen's Gambit Declined",
        // 1. d4 d5 2. c4 e6
        uci: ['d2d4', 'd7d5', 'c2c4', 'e7e6'],
        note: 'The classical, solid answer.',
      },
      {
        name: "Queen's Gambit Accepted",
        // 1. d4 d5 2. c4 dxc4
        uci: ['d2d4', 'd7d5', 'c2c4', 'd5c4'],
        note: 'Black takes the pawn but plans to give it back for activity.',
      },
      {
        name: 'Slav Defense',
        // 1. d4 d5 2. c4 c6
        uci: ['d2d4', 'd7d5', 'c2c4', 'c7c6'],
        note: 'Holds d5 with the c-pawn and keeps the c8 bishop free.',
      },
      {
        name: "Queen's Gambit Declined: Albin Countergambit",
        // 1. d4 d5 2. c4 e5
        uci: ['d2d4', 'd7d5', 'c2c4', 'e7e5'],
        note: 'A sharp counter-gambit; the safe reply is 3.dxe5 d4 4.Nf3.',
      },
      {
        name: "Queen's Gambit Declined: Chigorin Defense",
        // 1. d4 d5 2. c4 Nc6
        uci: ['d2d4', 'd7d5', 'c2c4', 'b8c6'],
        note: 'Piece play instead of pawn support; Black often gives up the bishop pair.',
      },
    ],
    traps: [
      {
        title: 'Lasker Trap',
        // 1. d4 d5 2. c4 e5 3. dxe5 d4 4. e3 Bb4+ 5. Bd2 dxe3 6. Bxb4 exf2+ 7. Ke2 fxg1=N+ 8. Rxg1 Bg4+ 9. Kf2 Qxd1
        uci: [
          'd2d4', 'd7d5', 'c2c4', 'e7e5', 'd4e5', 'd5d4', 'e2e3', 'f8b4', 'c1d2', 'd4e3', 'd2b4',
          'e3f2', 'e1e2', 'f2g1n', 'h1g1', 'c8g4', 'e2f2', 'd8d1',
        ],
        note: 'In the Albin, after 4.e3?! Bb4+ 5.Bd2 dxe3, grabbing 6.Bxb4?? loses: ...exf2+ and ...fxg1=N+! (promoting to a knight with check), then ...Bg4+ wins the queen. 4.Nf3 avoids all this.',
        side: 'black',
        mistakes: [10],
      },
    ],
    moveNotes: {
      '1. d4': 'Takes the center.',
      '1. d4 d5': 'Black claims an equal share.',
      '1. d4 d5 2. c4': "The Queen's Gambit: attacks d5 from the side.",
      '1. d4 d5 2. c4 e6': 'Declines and supports d5 with a pawn.',
      '1. d4 d5 2. c4 e6 3. Nc3': 'More pressure on d5.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6': 'Defends d5 again and develops.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5': 'Pins the knight that guards d5.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7': 'Breaks the pin.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3': 'Frees the f1 bishop.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O': 'King safety first.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3': 'Develops the last knight; Bd3 (or Rc1) and castling come next.',
    },
  },
  {
    family: "Queen's Gambit Accepted",
    side: 'black',
    level: 'beginner',
    summary:
      "2...dxc4 takes the offered pawn, gives up the center for a moment and gains free development. Black does not try to keep the pawn; the plan is ...Nf6, ...e6 and ...c5 to attack White's center.",
    ideasWhite: [
      'Win the pawn back with e3 and Bxc4, or take the center with 3.e4.',
      'Use the central majority to push d5 or e5.',
      'An isolated d-pawn often appears; use it for activity.',
    ],
    ideasBlack: [
      "Don't hold on to c4 with ...b5; it usually backfires.",
      "Strike White's center with ...c5 (or ...e5 against 3.e4).",
      'Develop smoothly: ...Nf6, ...e6, ...a6, ...c5 and ...Nc6.',
    ],
    typicalPlans: [
      'Classical: 3.Nf3 Nf6 4.e3 e6 5.Bxc4 c5 6.O-O a6: Black targets d4, White plays for central pressure.',
      'Against 3.e4, hit the center right back with 3...e5 or 3...Nf6.',
    ],
    keyVariations: [
      {
        name: "Queen's Gambit Accepted: Classical Defense",
        // 1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 e6 5. Bxc4 c5
        uci: ['d2d4', 'd7d5', 'c2c4', 'd5c4', 'g1f3', 'g8f6', 'e2e3', 'e7e6', 'f1c4', 'c7c5'],
        note: 'The main line: ...c5 hits d4 and Black equalizes with care.',
      },
      {
        name: "Queen's Gambit Accepted: Saduleto Variation",
        // 1. d4 d5 2. c4 dxc4 3. e4
        uci: ['d2d4', 'd7d5', 'c2c4', 'd5c4', 'e2e4'],
        note: 'Also called the Central Variation: White takes the whole center.',
      },
      {
        name: "Queen's Gambit Accepted: Old Variation",
        // 1. d4 d5 2. c4 dxc4 3. e3
        uci: ['d2d4', 'd7d5', 'c2c4', 'd5c4', 'e2e3'],
        note: 'Quiet: White gets the pawn back with Bxc4.',
      },
      {
        name: "Queen's Gambit Accepted: Alekhine Defense",
        // 1. d4 d5 2. c4 dxc4 3. Nf3 a6
        uci: ['d2d4', 'd7d5', 'c2c4', 'd5c4', 'g1f3', 'a7a6'],
        note: 'A flexible waiting move: ...e6 and ...c5 come next, and ...a6 prepares ...b5 to gain space once White retakes on c4.',
      },
    ],
    traps: [
      {
        title: 'Holding the pawn with ...b5',
        // 1. d4 d5 2. c4 dxc4 3. e3 b5 4. a4 c6 5. axb5 cxb5 6. Qf3 Nc6 7. Qxc6+ Bd7 8. Qe4
        uci: [
          'd2d4', 'd7d5', 'c2c4', 'd5c4', 'e2e3', 'b7b5', 'a2a4', 'c7c6', 'a4b5', 'c6b5', 'd1f3',
          'b8c6', 'f3c6', 'c8d7', 'c6e4',
        ],
        note: '3...b5?! tries to keep the pawn, but after 4.a4 the natural 4...c6? fails to 5.axb5 cxb5 6.Qf3!, hitting the a8 rook along the long diagonal. Let the pawn go and develop.',
        side: 'white',
        mistakes: [7],
      },
    ],
    moveNotes: {
      '1. d4 d5 2. c4 dxc4': 'Accepts; the pawn will usually be given back.',
      '1. d4 d5 2. c4 dxc4 3. Nf3': 'Develops and stops ...e5.',
      '1. d4 d5 2. c4 dxc4 3. Nf3 Nf6': 'Develops and watches e4.',
      '1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3': 'Opens the bishop to take on c4.',
      '1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 e6': "Opens Black's bishop too.",
      '1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 e6 5. Bxc4': 'Material is level again.',
      '1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 e6 5. Bxc4 c5': 'The key break: it hits d4.',
      '1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 e6 5. Bxc4 c5 6. O-O a6': 'Prepares ...b5 to gain space with tempo on the bishop.',
    },
  },
  {
    family: "Queen's Gambit Declined",
    aka: ['Tarrasch Defense', 'QGD'],
    side: 'black',
    level: 'beginner',
    summary:
      '2...e6 keeps a strong pawn on d5 and builds a solid, classical position. The price is that the c8 bishop is blocked for a while. Black develops calmly, castles, and frees the game later with ...c5 or ...e5.',
    ideasWhite: [
      'Pressure d5 with Nc3, Bg5 and sometimes cxd5.',
      'In the Exchange Variation, use the minority attack (b4-b5).',
      'Aim for e4 when the center allows it.',
    ],
    ideasBlack: [
      'Develop: ...Nf6, ...Be7, ...O-O and ...Nbd7.',
      'Free the position with ...dxc4 and ...c5, or ...e5.',
      'Find a role for the c8 bishop (...b6 and ...Bb7, or after ...dxc4).',
    ],
    typicalPlans: [
      'Orthodox: ...Be7, ...O-O, ...Nbd7 and ...c6, then ...dxc4 and ...Nd5 or ...e5.',
      'Exchange QGD: White plays the minority attack; Black looks for kingside play or ...Ne4.',
    ],
    keyVariations: [
      {
        name: "Queen's Gambit Declined: Orthodox Defense",
        // 1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 Nbd7
        uci: [
          'd2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6', 'c1g5', 'f8e7', 'e2e3', 'e8g8', 'g1f3',
          'b8d7',
        ],
        note: 'The classical setup, played for more than a century.',
      },
      {
        name: "Queen's Gambit Declined: Exchange Variation",
        // 1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. cxd5
        uci: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6', 'c4d5'],
        note: 'White fixes the pawn structure; a strategic battle follows.',
      },
      {
        name: "Queen's Gambit Declined: Ragozin Defense",
        // 1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 Bb4
        uci: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6', 'g1f3', 'f8b4'],
        note: 'A Nimzo-Indian style pin on c3.',
      },
      {
        name: "Queen's Gambit Declined: Harrwitz Attack",
        // 1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 Be7 5. Bf4
        uci: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6', 'g1f3', 'f8e7', 'c1f4'],
        note: '5.Bf4: a modern, popular setup for White.',
      },
      {
        name: 'Tarrasch Defense',
        // 1. d4 d5 2. c4 e6 3. Nc3 c5
        uci: ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'c7c5'],
        note: 'Black accepts an isolated d-pawn in return for free piece play.',
      },
    ],
    traps: [
      {
        title: 'Elephant Trap',
        // 1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Nbd7 5. cxd5 exd5 6. Nxd5 Nxd5 7. Bxd8 Bb4+ 8. Qd2 Bxd2+ 9. Kxd2 Kxd8
        uci: [
          'd2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3', 'g8f6', 'c1g5', 'b8d7', 'c4d5', 'e6d5', 'c3d5',
          'f6d5', 'g5d8', 'f8b4', 'd1d2', 'b4d2', 'e1d2', 'e8d8',
        ],
        note: 'After 4...Nbd7 5.cxd5 exd5 the f6 knight is pinned, so 6.Nxd5?? seems to win a pawn. But 6...Nxd5! 7.Bxd8 Bb4+ wins the queen back, and Black ends up a piece for a pawn ahead.',
        side: 'black',
        mistakes: [10],
      },
    ],
    moveNotes: {
      '1. d4 d5 2. c4 e6': 'Declines, keeping a pawn on d5.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6': 'Defends d5 and develops.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5': 'Pins the knight that guards d5.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7': 'Breaks the pin.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O': 'King safety first.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 Nbd7': 'Supports ...c5 or ...e5 later.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 Nbd7 7. Rc1': 'The rook takes the c-file before Black frees with ...dxc4.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 Nbd7 7. Rc1 c6': 'Firms up d5 and prepares ...dxc4.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 Nbd7 7. Rc1 c6 8. Bd3': 'Develops; now ...dxc4 will cost White a tempo.',
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 Nbd7 7. Rc1 c6 8. Bd3 dxc4': "Black takes once White's bishop has moved.",
      '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 Nbd7 7. Rc1 c6 8. Bd3 dxc4 9. Bxc4 Nd5': "Capablanca's freeing idea: trade pieces to ease the cramp.",
    },
  },
  {
    family: 'Slav Defense',
    side: 'black',
    level: 'beginner',
    summary:
      "2...c6 supports d5 with the c-pawn, so the c8 bishop can still come out to f5 or g4. It is one of the most solid replies to the Queen's Gambit and a favorite of world champions.",
    ideasWhite: [
      'Pressure d5 and aim for e4.',
      'In the main line, a4 stops Black from holding c4 with ...b5.',
      'The Exchange Variation (cxd5) gives a quiet, symmetrical game.',
    ],
    ideasBlack: [
      'Develop the c8 bishop before playing ...e6.',
      'After ...dxc4, follow with ...Bf5 and ...e6 to regain activity.',
      'Stay solid; the pawn structure is very healthy.',
    ],
    typicalPlans: [
      'Main line: 4.Nc3 dxc4 5.a4 Bf5 6.e3 e6 7.Bxc4 Bb4: smooth development for both sides.',
      'Against 4.e3, Black can bring the bishop out at once with 4...Bf5.',
    ],
    keyVariations: [
      {
        name: 'Slav Defense: Czech Variation',
        // 1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4 5. a4 Bf5
        uci: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'd5c4', 'a2a4', 'c8f5'],
        note: 'The main line: take on c4, then develop the bishop to f5.',
      },
      {
        name: 'Slav Defense: Exchange Variation',
        // 1. d4 d5 2. c4 c6 3. cxd5
        uci: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'c4d5'],
        note: 'Symmetrical and solid; Black equalizes with simple development.',
      },
      {
        name: 'Slav Defense: Chebanenko Variation',
        // 1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 a6
        uci: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'a7a6'],
        note: 'Black prepares ...b5 to gain queenside space.',
      },
      {
        name: 'Slav Defense: Quiet Variation, Schallopp Defense',
        // 1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. e3 Bf5
        uci: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'e2e3', 'c8f5'],
        note: 'Against 4.e3 the bishop comes out before ...e6 shuts it in.',
      },
      {
        name: 'Semi-Slav Defense',
        // 1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6
        uci: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'e7e6'],
        note: '4...e6 turns it into the Semi-Slav (see its own guide).',
      },
    ],
    moveNotes: {
      '1. d4 d5 2. c4 c6': 'Supports d5 with a pawn and keeps the c8 bishop free.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3': 'More pressure on d5.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4': 'Takes, now that White cannot easily defend c4.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4 5. a4': 'Stops ...b5, which would hold the pawn.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4 5. a4 Bf5': 'The bishop gets out before ...e6.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4 5. a4 Bf5 6. e3 e6 7. Bxc4': 'Material is level again.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4 5. a4 Bf5 6. e3 e6 7. Bxc4 Bb4': 'Pins the c3 knight and slows down e4.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4 5. a4 Bf5 6. e3 e6 7. Bxc4 Bb4 8. O-O O-O': 'Both sides have developed smoothly.',
    },
  },
  {
    family: 'Semi-Slav Defense',
    aka: ['Semi-Slav Defense Accepted', 'Meran Defense'],
    side: 'black',
    level: 'advanced',
    summary:
      'With pawns on c6, d5 and e6, Black builds a rock-solid triangle that can suddenly explode with ...dxc4 and ...b5. It mixes Slav and QGD ideas and leads to some of the sharpest lines after 1.d4.',
    ideasWhite: [
      'Calm: e3 and Bd3, then aim for e4.',
      'Sharp: 5.Bg5 invites very deep, double-edged theory.',
      'Fight for e4 and use the center.',
    ],
    ideasBlack: [
      'Take on c4 at the right moment and support it with ...b5.',
      'Expand on the queenside with ...a6, ...b5 and ...c5.',
      'The c8 bishop usually goes to b7 after ...b5.',
    ],
    typicalPlans: [
      'Meran: 5.e3 Nbd7 6.Bd3 dxc4 7.Bxc4 b5: Black gains space, then plays ...Bb7, ...a6 and ...c5.',
      'Botvinnik (5.Bg5 dxc4 6.e4): both sides attack; theory runs very deep.',
    ],
    keyVariations: [
      {
        name: 'Semi-Slav Defense',
        // 1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6
        uci: ['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'e7e6'],
        note: 'The starting position of the Semi-Slav.',
      },
      {
        name: 'Semi-Slav Defense: Meran Variation',
        // 1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3 Nbd7 6. Bd3 dxc4 7. Bxc4 b5
        uci: [
          'd2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'e7e6', 'e2e3', 'b8d7', 'f1d3',
          'd5c4', 'd3c4', 'b7b5',
        ],
        note: 'Black gains queenside space with tempo on the bishop.',
      },
      {
        name: 'Semi-Slav Defense: Botvinnik Variation',
        // 1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. Bg5 dxc4 6. e4
        uci: [
          'd2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6', 'b1c3', 'e7e6', 'c1g5', 'd5c4', 'e2e4',
        ],
        note: 'One of the sharpest lines in chess; only for the well prepared.',
      },
    ],
    moveNotes: {
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6': 'The Semi-Slav triangle: c6, d5 and e6.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3': 'The calm approach.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3 Nbd7': 'Supports ...e5 or ...c5 later.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3 Nbd7 6. Bd3': 'Develops toward the kingside.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3 Nbd7 6. Bd3 dxc4': 'Takes now that the bishop must move again.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3 Nbd7 6. Bd3 dxc4 7. Bxc4 b5': 'The Meran: gains space with tempo.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3 Nbd7 6. Bd3 dxc4 7. Bxc4 b5 8. Bd3': 'The bishop returns to its best diagonal.',
      '1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3 Nbd7 6. Bd3 dxc4 7. Bxc4 b5 8. Bd3 Bb7': 'The bishop eyes the long diagonal; ...a6 and ...c5 come next.',
    },
  },
  {
    family: 'London System',
    aka: [
      "Queen's Pawn Game: London System",
      "Queen's Pawn Game: Accelerated London System",
      'Indian Defense: London System',
      'Indian Defense: Accelerated London System',
    ],
    side: 'white',
    level: 'beginner',
    summary:
      'White plays d4, Bf4, e3, Nf3, c3 and Bd3 against almost anything. It is a system rather than a sharp opening: easy to learn, solid, and full of simple attacking ideas like Ne5 and a kingside push.',
    ideasWhite: [
      'Get the dark-squared bishop to f4 before playing e3.',
      'Build the c3-d4-e3 pyramid and develop Nf3, Bd3, Nbd2 and O-O.',
      'Attack with Ne5, Qf3 or h4 once everything is developed.',
    ],
    ideasBlack: [
      'Hit b2 with ...c5 and ...Qb6 while the bishop has left c1.',
      'Challenge the f4 bishop with ...Bd6.',
      'Pressure d4 with ...c5 and ...Nc6.',
    ],
    typicalPlans: [
      'White: Bf4, e3, Nf3, c3, Bd3, Nbd2, O-O, then Ne5 and f4 or a kingside push.',
      'Black: ...d5, ...Nf6, ...c5, ...Nc6 and ...Qb6 or ...Bd6 to fight the bishop.',
    ],
    keyVariations: [
      {
        name: "Queen's Pawn Game: London System",
        // 1. d4 d5 2. Nf3 Nf6 3. Bf4
        uci: ['d2d4', 'd7d5', 'g1f3', 'g8f6', 'c1f4'],
        note: 'The classic move order.',
      },
      {
        name: "Queen's Pawn Game: Accelerated London System",
        // 1. d4 d5 2. Bf4
        uci: ['d2d4', 'd7d5', 'c1f4'],
        note: 'The modern order: Bf4 on move two avoids some setups.',
      },
      {
        name: 'Indian Defense: London System',
        // 1. d4 Nf6 2. Nf3 e6 3. Bf4
        uci: ['d2d4', 'g8f6', 'g1f3', 'e7e6', 'c1f4'],
        note: 'The London against ...Nf6 and ...e6.',
      },
      {
        name: 'London System: Poisoned Pawn Variation',
        // 1. d4 Nf6 2. Nf3 d5 3. Bf4 c5 4. e3 Qb6 5. Nc3
        uci: ['d2d4', 'g8f6', 'g1f3', 'd7d5', 'c1f4', 'c7c5', 'e2e3', 'd8b6', 'b1c3'],
        note: "White leaves b2 hanging; taking it gives White quick play against Black's queen.",
      },
    ],
    moveNotes: {
      '1. d4 d5 2. Bf4': 'The London bishop comes out before e3 blocks it.',
      '1. d4 d5 2. Bf4 Nf6 3. e3': 'Opens the f1 bishop and supports d4.',
      '1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. Nf3 c5': 'Black hits d4, the usual plan.',
      '1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. Nf3 c5 5. c3': 'The pyramid: d4 is solidly supported.',
      '1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. Nf3 c5 5. c3 Nc6 6. Nbd2': 'Develops and guards e4 and c4.',
      '1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. Nf3 c5 5. c3 Nc6 6. Nbd2 Bd6': 'Offers to trade off the strong f4 bishop.',
      '1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. Nf3 c5 5. c3 Nc6 6. Nbd2 Bd6 7. Bg3': 'Keeps the bishop; after ...Bxg3, hxg3 opens the h-file.',
      '1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. Nf3 c5 5. c3 Nc6 6. Nbd2 Bd6 7. Bg3 O-O 8. Bd3': 'Aims at h7: the typical attacking setup.',
    },
  },
  {
    family: 'Rapport-Jobava System',
    aka: ['Jobava London', 'Jobava London System'],
    side: 'white',
    level: 'intermediate',
    summary:
      'A sharper cousin of the London: White plays d4, Nc3 and Bf4, so the knight can jump to b5 and team up with the bishop against c7. It is aggressive and less explored than the London.',
    ideasWhite: [
      'Use Nb5 together with Bf4 to pressure c7.',
      'Push e4 or f3 and g4 to gain kingside space in some lines.',
      "Choose e3 and Bd3, or Qd2 and long castling, depending on Black's setup.",
    ],
    ideasBlack: [
      'Cover c7 and b5 (...a6, ...c6 or ...Bd6).',
      'Strike in the center with ...c5 or ...e5.',
      'Use ...Bf5 or ...Bg4 to fight for e4.',
    ],
    typicalPlans: [
      'Against ...e6 and ...c5: e3, Nb5 and c3 for queenside pressure.',
      "Against ...g6: Qd2 and Bh6 to trade Black's best bishop.",
    ],
    keyVariations: [
      {
        name: 'Rapport-Jobava System',
        // 1. d4 d5 2. Nc3 Nf6 3. Bf4
        uci: ['d2d4', 'd7d5', 'b1c3', 'g8f6', 'c1f4'],
        note: 'The basic position: Nb5 ideas against c7 are in the air.',
      },
      {
        name: 'Rapport-Jobava System, with e6',
        // 1. d4 d5 2. Nc3 e6 3. Bf4
        uci: ['d2d4', 'd7d5', 'b1c3', 'e7e6', 'c1f4'],
        note: 'Black prepares ...Bb4 or ...Bd6.',
      },
    ],
    moveNotes: {
      '1. d4 d5 2. Nc3': 'Blocks the c-pawn but prepares e4 and Nb5.',
      '1. d4 d5 2. Nc3 Nf6 3. Bf4': 'Together with Nb5, the bishop can hit c7.',
      '1. d4 d5 2. Nc3 Nf6 3. Bf4 e6 4. e3': 'Opens the f1 bishop.',
      '1. d4 d5 2. Nc3 Nf6 3. Bf4 e6 4. e3 c5': 'Strikes at d4.',
      '1. d4 d5 2. Nc3 Nf6 3. Bf4 e6 4. e3 c5 5. Nb5': 'Jumps at c7 and d6.',
      '1. d4 d5 2. Nc3 Nf6 3. Bf4 e6 4. e3 c5 5. Nb5 Na6': 'Covers c7.',
    },
  },
  {
    family: 'Catalan Opening',
    side: 'white',
    level: 'advanced',
    summary:
      "White combines the Queen's Gambit (d4, c4) with a kingside fianchetto (g3, Bg2). The g2 bishop presses on d5 and down the long diagonal toward a8, giving White lasting queenside pressure. Black often takes on c4 and must then untangle the queenside.",
    ideasWhite: [
      'The g2 bishop is the star: keep the long diagonal open.',
      'If Black takes on c4, win it back with Qc2 or Qa4 while keeping the pressure.',
      'Play slowly and positionally; small edges add up.',
    ],
    ideasBlack: [
      'Open Catalan: take on c4 and use ...a6, ...b5 or ...c5 to free the game.',
      'Closed Catalan: keep d5, play ...c6 and ...Nbd7, then ...b6 and ...Bb7.',
      'Blunt the g2 bishop by blocking or trading on the long diagonal.',
    ],
    typicalPlans: [
      'Open: 4...dxc4 5.Nf3 Be7 6.O-O O-O 7.Qc2 a6 8.Qxc4 b5, then ...Bb7.',
      'Closed: ...Be7, ...O-O, ...c6 and ...Nbd7, solid but a little passive.',
    ],
    keyVariations: [
      {
        name: 'Catalan Opening',
        // 1. d4 Nf6 2. c4 e6 3. g3
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g2g3'],
        note: 'The Catalan setup: g3 and Bg2.',
      },
      {
        name: 'Catalan Opening: Open Defense',
        // 1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g2g3', 'd7d5', 'f1g2', 'd5c4'],
        note: 'Black grabs c4; White develops fast and wins it back.',
      },
      {
        name: 'Catalan Opening: Closed',
        // 1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 Be7 5. Nf3
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g2g3', 'd7d5', 'f1g2', 'f8e7', 'g1f3'],
        note: 'Black keeps d5 and develops solidly.',
      },
    ],
    moveNotes: {
      '1. d4 Nf6 2. c4 e6 3. g3': 'Prepares the fianchetto: the Catalan.',
      '1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2': 'The bishop aims down the long diagonal.',
      '1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4': 'The Open Catalan: Black takes the pawn.',
      '1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4 5. Nf3 Be7 6. O-O O-O 7. Qc2': 'Prepares to take back on c4.',
      '1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4 5. Nf3 Be7 6. O-O O-O 7. Qc2 a6': 'Prepares ...b5 to keep the pawn for a while.',
      '1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4 5. Nf3 Be7 6. O-O O-O 7. Qc2 a6 8. Qxc4': 'Material is level again.',
      '1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4 5. Nf3 Be7 6. O-O O-O 7. Qc2 a6 8. Qxc4 b5': 'Gains space with tempo on the queen.',
      '1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4 5. Nf3 Be7 6. O-O O-O 7. Qc2 a6 8. Qxc4 b5 9. Qc2 Bb7': 'Black contests the long diagonal.',
    },
  },
  {
    family: 'Indian Defense',
    aka: ['Indian Game', 'Budapest Gambit'],
    side: 'black',
    level: 'beginner',
    summary:
      "1...Nf6 is the most flexible answer to 1.d4: it stops e4 for now and keeps Black's options open. After 2.c4 Black picks a setup: King's Indian or Grünfeld (...g6), Nimzo- or Queen's Indian (...e6), Benoni (...c5) and more.",
    ideasWhite: [
      '2.c4 is the main move, taking more central space.',
      '2.Nf3 with Bf4 or Bg5 leads to quieter systems.',
      'Aim for e4 whenever Black allows it.',
    ],
    ideasBlack: [
      'Control e4 with pieces before committing pawns.',
      'Pick a setup you like: ...e6 (solid), ...g6 (dynamic) or ...c5 (sharp).',
      'The Budapest Gambit (2...e5) is a trappy surprise weapon.',
    ],
    keyVariations: [
      {
        name: 'Indian Defense: Normal Variation',
        // 1. d4 Nf6 2. c4
        uci: ['d2d4', 'g8f6', 'c2c4'],
        note: 'The main move; Black now chooses a defense.',
      },
      {
        name: 'Indian Defense: West Indian Defense',
        // 1. d4 Nf6 2. c4 g6
        uci: ['d2d4', 'g8f6', 'c2c4', 'g7g6'],
        note: "Heads for the King's Indian or the Grünfeld.",
      },
      {
        name: 'Indian Defense: Knights Variation',
        // 1. d4 Nf6 2. Nf3
        uci: ['d2d4', 'g8f6', 'g1f3'],
        note: 'A flexible move order for White.',
      },
      {
        name: 'Indian Defense: Budapest Gambit',
        // 1. d4 Nf6 2. c4 e5
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e5'],
        note: 'Black gambits a pawn and usually wins it back; with care White keeps a small edge.',
      },
    ],
    traps: [
      {
        title: 'Budapest smothered mate',
        // 1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. Bf4 Nc6 5. Nf3 Bb4+ 6. Nbd2 Qe7 7. a3 Ngxe5 8. axb4 Nd3#
        uci: [
          'd2d4', 'g8f6', 'c2c4', 'e7e5', 'd4e5', 'f6g4', 'c1f4', 'b8c6', 'g1f3', 'f8b4', 'b1d2',
          'd8e7', 'a2a3', 'g4e5', 'a3b4', 'e5d3',
        ],
        note: "After 7...Ngxe5, 8.axb4?? allows ...Nd3 mate: the e7 queen pins the e2 pawn and White's own pieces box in the king. Play 8.Nxe5 Nxe5 9.e3, and don't take on b4 while e2 is pinned.",
        side: 'black',
        mistakes: [14],
      },
    ],
    moveNotes: {
      '1. d4 Nf6': 'Controls e4 and keeps every option open.',
      '1. d4 Nf6 2. c4': 'Takes more space in the center.',
      '1. d4 Nf6 2. c4 e6': 'Prepares ...d5 or ...Bb4.',
      '1. d4 Nf6 2. c4 e6 3. Nc3': 'Prepares e4.',
      '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4': 'The Nimzo-Indian pin stops e4.',
    },
    mainLine: '1. d4 Nf6 2. c4 e6',
  },
  {
    family: "King's Indian Defense",
    side: 'black',
    level: 'intermediate',
    summary:
      'Black fianchettoes (...g6, ...Bg7), castles, lets White build a big pawn center, then strikes with ...e5 or ...c5. In the main lines the center locks and both sides race: White attacks on the queenside, Black storms the kingside with ...f5.',
    ideasWhite: [
      'Build the big center: c4, d4 and e4, with Nf3 and Be2.',
      'When the center locks with d5, attack the queenside with b4 and c5.',
      'The Sämisch (f3) and Four Pawns (f4) are aggressive alternatives.',
    ],
    ideasBlack: [
      'Fianchetto and castle first, then hit the center with ...e5.',
      'If White plays d5, attack with ...Ne8 or ...Nd7, then ...f5 and ...f4.',
      'The g7 bishop may look blocked but often decides the game later.',
    ],
    typicalPlans: [
      'Classical: 7.O-O Nc6 8.d5 Ne7, then White pushes on the queenside and Black on the kingside.',
      'Fianchetto (g3, Bg2): a slower, positional game.',
    ],
    keyVariations: [
      {
        name: "King's Indian Defense: Orthodox Variation",
        // 1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5
        uci: [
          'd2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'e2e4', 'd7d6', 'g1f3', 'e8g8', 'f1e2',
          'e7e5',
        ],
        note: 'The classical main line.',
      },
      {
        name: "King's Indian Defense: Orthodox Variation, Aronin-Taimanov Defense",
        // 1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O Nc6
        uci: [
          'd2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'e2e4', 'd7d6', 'g1f3', 'e8g8', 'f1e2',
          'e7e5', 'e1g1', 'b8c6',
        ],
        note: 'After 8.d5 Ne7 the famous race starts: White on the queenside, Black on the kingside.',
      },
      {
        name: "King's Indian Defense: Sämisch Variation",
        // 1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f3
        uci: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'e2e4', 'd7d6', 'f2f3'],
        note: 'f3 supports e4; White often castles long and attacks.',
      },
      {
        name: "King's Indian Defense: Four Pawns Attack",
        // 1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. f4
        uci: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7', 'e2e4', 'd7d6', 'f2f4'],
        note: 'The most ambitious setup; Black must hit back quickly with ...c5 or ...e5.',
      },
      {
        name: "King's Indian Defense: Fianchetto Variation",
        // 1. d4 Nf6 2. c4 g6 3. Nf3 Bg7 4. g3
        uci: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'g1f3', 'f8g7', 'g2g3'],
        note: 'A quieter, positional choice.',
      },
    ],
    moveNotes: {
      '1. d4 Nf6 2. c4 g6': 'Prepares the fianchetto.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7': 'The bishop takes the long diagonal.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4': 'White builds a big center.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6': 'Controls e5 and prepares ...e5.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O': 'Black castles before opening the center.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5': 'The key strike at d4.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O Nc6': 'More pressure on d4.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O Nc6 8. d5': 'White locks the center and gains space.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O Nc6 8. d5 Ne7': 'The knight heads for the kingside; ...Nd7 or ...Ne8 and ...f5 come next.',
    },
  },
  {
    family: 'Nimzo-Indian Defense',
    side: 'black',
    level: 'intermediate',
    summary:
      "After 1.d4 Nf6 2.c4 e6 3.Nc3, Black pins the knight with 3...Bb4. Black fights for e4 with pieces and is often happy to give the bishop for the knight to double White's c-pawns. It is one of the most respected defenses at every level.",
    ideasWhite: [
      'Avoid doubled pawns with 4.Qc2, or accept them for the bishop pair.',
      'Aim for e4 to use the center.',
      "The two bishops are White's long-term trump in open positions.",
    ],
    ideasBlack: [
      'Control e4 with ...Bb4, ...Nf6 and often ...b6 and ...Bb7.',
      "Trade on c3 when it damages White's pawns.",
      'Fight the center with ...c5 and ...d5, or ...d6 and ...e5.',
    ],
    typicalPlans: [
      'Rubinstein (4.e3): ...O-O, ...d5 and ...c5, classical central play.',
      'Classical (4.Qc2): ...O-O with ...d5 or ...c5; White keeps a healthy structure.',
    ],
    keyVariations: [
      {
        name: 'Nimzo-Indian Defense: Rubinstein System',
        // 1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4', 'e2e3'],
        note: 'Solid development; Black usually continues ...O-O, ...d5 and ...c5.',
      },
      {
        name: 'Nimzo-Indian Defense: Classical Variation',
        // 1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4', 'd1c2'],
        note: 'The queen guards c3 so White avoids doubled pawns.',
      },
      {
        name: 'Nimzo-Indian Defense: Sämisch Variation',
        // 1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. a3
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4', 'a2a3'],
        note: 'White asks the bishop to take on c3 at once and gets the bishop pair.',
      },
      {
        name: 'Nimzo-Indian Defense: Three Knights Variation',
        // 1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Nf3
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4', 'g1f3'],
        note: 'Flexible; it can transpose to many lines.',
      },
    ],
    moveNotes: {
      '1. d4 Nf6 2. c4 e6 3. Nc3': 'Prepares e4.',
      '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4': 'The Nimzo pin: e4 is now hard to play.',
      '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3': 'The Rubinstein: solid development.',
      '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O 5. Bd3 d5': 'Takes a share of the center.',
      '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O 5. Bd3 d5 6. Nf3 c5': 'Hits d4 from the side.',
      '1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O 5. Bd3 d5 6. Nf3 c5 7. O-O': 'A classical position with chances for both sides.',
    },
  },
  {
    family: "Queen's Indian Defense",
    aka: ['Bogo-Indian Defense', "Queen's Indian Accelerated"],
    side: 'black',
    level: 'intermediate',
    summary:
      'After 1.d4 Nf6 2.c4 e6 3.Nf3, which avoids the Nimzo-Indian pin, Black fianchettoes with 3...b6 and ...Bb7 to control e4 from a distance. It is solid and flexible; 3...Bb4+ (Bogo-Indian) is a close relative.',
    ideasWhite: [
      'Fianchetto with g3 and Bg2 to fight the b7 bishop.',
      '4.a3 (Petrosian) stops ...Bb4 and prepares Nc3 and d5.',
      'Aim for e4 to gain space.',
    ],
    ideasBlack: [
      'Control e4 with ...Bb7, or play ...Ba6 to hit c4.',
      'Use ...Bb4+ to trade pieces and ease the position.',
      'Break with ...c5 or ...d5 to fight for the center.',
    ],
    typicalPlans: [
      'Fianchetto: 4.g3 Bb7 5.Bg2 Be7 6.O-O O-O 7.Nc3 Ne4, trading knights to free the game.',
      'Petrosian: 4.a3 Bb7 5.Nc3 d5 6.cxd5 Nxd5, open and classical.',
    ],
    keyVariations: [
      {
        name: "Queen's Indian Defense: Fianchetto Variation",
        // 1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g1f3', 'b7b6', 'g2g3'],
        note: 'White fights the long diagonal with Bg2.',
      },
      {
        name: "Queen's Indian Defense: Fianchetto Variation, Nimzowitsch Variation",
        // 1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Ba6
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g1f3', 'b7b6', 'g2g3', 'c8a6'],
        note: 'The bishop hits c4 and asks White to commit.',
      },
      {
        name: "Queen's Indian Defense: Petrosian Variation",
        // 1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. a3
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g1f3', 'b7b6', 'a2a3'],
        note: 'Prevents ...Bb4 and prepares Nc3.',
      },
      {
        name: 'Bogo-Indian Defense',
        // 1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+
        uci: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g1f3', 'f8b4'],
        note: 'The check trades off pieces; a simple, solid alternative.',
      },
    ],
    moveNotes: {
      '1. d4 Nf6 2. c4 e6 3. Nf3': 'Avoids the Nimzo-Indian pin.',
      '1. d4 Nf6 2. c4 e6 3. Nf3 b6': 'Prepares ...Bb7 to control e4.',
      '1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3': 'White fianchettoes too, fighting for the long diagonal.',
      '1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Be7': 'Prepares to castle.',
      '1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Be7 6. O-O O-O 7. Nc3': 'Prepares e4.',
      '1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Be7 6. O-O O-O 7. Nc3 Ne4': 'Occupies e4 and offers a trade.',
      '1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Be7 6. O-O O-O 7. Nc3 Ne4 8. Qc2': 'Challenges the knight.',
      '1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Be7 6. O-O O-O 7. Nc3 Ne4 8. Qc2 Nxc3': 'Trades knights to ease the position.',
      '1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Be7 6. O-O O-O 7. Nc3 Ne4 8. Qc2 Nxc3 9. Qxc3': 'White keeps a little space; Black is solid.',
    },
  },
  {
    family: 'Grünfeld Defense',
    aka: ['Gruenfeld Defense', 'Neo-Grünfeld Defense'],
    side: 'black',
    level: 'advanced',
    summary:
      'Black lets White build a big pawn center with e4 and then attacks it with pieces and pawn breaks: the g7 bishop, ...Nc6 and the ...c5 push. It is dynamic and theory-heavy, a favorite of Kasparov and many top players.',
    ideasWhite: [
      'Exchange Variation: cxd5 and e4 for a big center, backed by Be3, Nf3 or Ne2.',
      'Keep d4 defended against the g7 bishop and ...c5.',
      'Push d5 when it gains space with tempo.',
    ],
    ideasBlack: [
      'Attack d4 with ...Bg7, ...c5, ...Nc6 and ...Qa5 or ...Bg4.',
      "Trade knights on c3 so White's center becomes a target.",
      "Don't let White's center roll forward unchecked.",
    ],
    typicalPlans: [
      'Exchange: 4.cxd5 Nxd5 5.e4 Nxc3 6.bxc3 Bg7 7.Nf3 c5, a fight over d4.',
      'Russian (5.Qb3): White grabs the center after ...dxc4; Black hits back with ...a6 and ...b5 or ...Bg4.',
    ],
    keyVariations: [
      {
        name: 'Grünfeld Defense',
        // 1. d4 Nf6 2. c4 g6 3. Nc3 d5
        uci: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'd7d5'],
        note: 'Black strikes in the center at once.',
      },
      {
        name: 'Grünfeld Defense: Exchange Variation',
        // 1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5
        uci: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'd7d5', 'c4d5', 'f6d5'],
        note: 'White will build the big center with e4.',
      },
      {
        name: 'Grünfeld Defense: Exchange Variation, Modern Exchange Variation',
        // 1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3 Bg7 7. Nf3
        uci: [
          'd2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'd7d5', 'c4d5', 'f6d5', 'e2e4', 'd5c3', 'b2c3',
          'f8g7', 'g1f3',
        ],
        note: 'The modern main line.',
      },
      {
        name: 'Grünfeld Defense: Russian Variation',
        // 1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Nf3 Bg7 5. Qb3
        uci: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'd7d5', 'g1f3', 'f8g7', 'd1b3'],
        note: 'The queen hits d5 and later takes on c4.',
      },
      {
        name: 'Grünfeld Defense: Brinckmann Attack',
        // 1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Bf4
        uci: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'd7d5', 'c1f4'],
        note: 'A popular, solid sideline.',
      },
    ],
    moveNotes: {
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5': 'The Grünfeld: strike in the center at once.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5': 'The Exchange Variation.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4': 'Kicks the knight and builds the big center.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3': "Trades so White's pawns become targets.",
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3': 'White has a big center; Black will attack it.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3 Bg7': 'The bishop bears down on d4, and through it on c3 and the a1 rook.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3 Bg7 7. Nf3 c5': 'More pressure on d4.',
      '1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 6. bxc3 Bg7 7. Nf3 c5 8. Rb1': "Eyes b7 and steps off the g7 bishop's diagonal.",
    },
  },
  {
    family: 'Benoni Defense',
    aka: ['Modern Benoni'],
    side: 'black',
    level: 'advanced',
    summary:
      'After 1.d4 Nf6 2.c4 c5 3.d5 e6, Black trades on d5 to create an unbalanced structure: White has a central majority, Black a queenside majority and a fianchettoed bishop. It is a sharp, fighting choice for players who want winning chances.',
    ideasWhite: [
      'Push e4-e5 to use the central majority.',
      "Slow Black's queenside expansion (a4 against ...b5).",
      "Use the d5 pawn to cramp Black's pieces.",
    ],
    ideasBlack: [
      'Expand on the queenside with ...a6 and ...b5.',
      'Put the bishop on g7 and the rooks on e8 and b8.',
      'Pressure e4 and look for the ...b5 or ...c4 breaks.',
    ],
    typicalPlans: [
      'Classical: White plays Nf3, Be2, O-O and Nd2-c4; Black plays ...Re8, ...Na6-c7 and ...b5.',
      'Sharp lines with f4 (Four Pawns, Taimanov) aim for a quick e5.',
    ],
    keyVariations: [
      {
        name: 'Benoni Defense: Modern Variation',
        // 1. d4 Nf6 2. c4 c5 3. d5 e6
        uci: ['d2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'e7e6'],
        note: 'Black prepares to open the e-file.',
      },
      {
        name: 'Benoni Defense: Classical Variation',
        // 1. d4 Nf6 2. c4 c5 3. d5 e6 4. Nc3 exd5 5. cxd5 d6 6. e4 g6 7. Nf3
        uci: [
          'd2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'e7e6', 'b1c3', 'e6d5', 'c4d5', 'd7d6', 'e2e4',
          'g7g6', 'g1f3',
        ],
        note: 'White develops calmly; the most common setup.',
      },
      {
        name: 'Benoni Defense: Taimanov Variation',
        // 1. d4 Nf6 2. c4 c5 3. d5 e6 4. Nc3 exd5 5. cxd5 d6 6. e4 g6 7. f4 Bg7 8. Bb5+
        uci: [
          'd2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'e7e6', 'b1c3', 'e6d5', 'c4d5', 'd7d6', 'e2e4',
          'g7g6', 'f2f4', 'f8g7', 'f1b5',
        ],
        note: 'A dangerous attacking line; Black must defend accurately.',
      },
      {
        name: 'Benoni Defense: Czech Benoni Defense',
        // 1. d4 Nf6 2. c4 c5 3. d5 e5
        uci: ['d2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'e7e5'],
        note: 'Black locks the center with ...e5: closed and strategic.',
      },
      {
        name: 'Benoni Defense: Old Benoni',
        // 1. d4 c5
        uci: ['d2d4', 'c7c5'],
        note: '1...c5 at once; after 2.d5 it often leads to Benoni structures.',
      },
    ],
    moveNotes: {
      '1. d4 Nf6 2. c4 c5': 'Hits d4 and invites d5.',
      '1. d4 Nf6 2. c4 c5 3. d5': 'White grabs space.',
      '1. d4 Nf6 2. c4 c5 3. d5 e6': 'Undermines d5.',
      '1. d4 Nf6 2. c4 c5 3. d5 e6 4. Nc3 exd5 5. cxd5': "The Benoni structure: White's central majority against Black's queenside one.",
      '1. d4 Nf6 2. c4 c5 3. d5 e6 4. Nc3 exd5 5. cxd5 d6': 'Blocks the d5 pawn and opens the c8 bishop.',
      '1. d4 Nf6 2. c4 c5 3. d5 e6 4. Nc3 exd5 5. cxd5 d6 6. e4 g6': 'The bishop goes to g7.',
      '1. d4 Nf6 2. c4 c5 3. d5 e6 4. Nc3 exd5 5. cxd5 d6 6. e4 g6 7. Nf3 Bg7 8. Be2 O-O 9. O-O': 'Black plays ...Re8, ...a6 and ...b5 next; White aims for e5.',
    },
  },
  {
    family: 'Benko Gambit',
    aka: ['Benko Gambit Accepted', 'Benko Gambit Declined', 'Volga Gambit'],
    side: 'black',
    level: 'intermediate',
    summary:
      'After 1.d4 Nf6 2.c4 c5 3.d5, Black gives a queenside pawn with 3...b5. In return Black gets the open a- and b-files and long-lasting pressure, often even into the endgame.',
    ideasWhite: [
      'Keep the extra pawn and finish development safely.',
      'Declining with 4.Nf3 or 4.a4 is a practical choice.',
      "Look for e4-e5 or a central break before Black's pressure builds.",
    ],
    ideasBlack: [
      'Open the a- and b-files with ...a6 and ...Bxa6.',
      'Fianchetto (...g6, ...Bg7) so the bishop hits the long diagonal.',
      'Stack rooks and queen on the a- and b-files.',
    ],
    typicalPlans: [
      'Fully accepted: 4.cxb5 a6 5.bxa6 Bxa6 6.Nc3 d6 7.e4 Bxf1 8.Kxf1: White cannot castle; Black builds queenside pressure.',
    ],
    keyVariations: [
      {
        name: 'Benko Gambit',
        // 1. d4 Nf6 2. c4 c5 3. d5 b5
        uci: ['d2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'b7b5'],
        note: 'The gambit move.',
      },
      {
        name: 'Benko Gambit Accepted: Fully Accepted Variation',
        // 1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6 5. bxa6
        uci: ['d2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'b7b5', 'c4b5', 'a7a6', 'b5a6'],
        note: 'White takes on a6 too; Black recaptures with the bishop and is one pawn down, with open files for the rooks.',
      },
      {
        name: 'Benko Gambit Accepted: Pawn Return Variation',
        // 1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6 5. b6
        uci: ['d2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'b7b5', 'c4b5', 'a7a6', 'b5b6'],
        note: "White gives the pawn back to blunt Black's play.",
      },
      {
        name: 'Benko Gambit Declined: Main Line',
        // 1. d4 Nf6 2. c4 c5 3. d5 b5 4. Nf3
        uci: ['d2d4', 'g8f6', 'c2c4', 'c7c5', 'd4d5', 'b7b5', 'g1f3'],
        note: 'White declines and develops.',
      },
    ],
    moveNotes: {
      '1. d4 Nf6 2. c4 c5 3. d5 b5': 'The Benko: a pawn for open queenside files.',
      '1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6': 'Offers to swap off the a-pawn to open the a-file; after 5.bxa6 Bxa6 Black is still one pawn down.',
      '1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6 5. bxa6 Bxa6': 'The bishop gets an open diagonal.',
      '1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6 5. bxa6 Bxa6 6. Nc3 d6 7. e4 Bxf1': 'Trades bishops so White must move the king.',
      '1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6 5. bxa6 Bxa6 6. Nc3 d6 7. e4 Bxf1 8. Kxf1': 'White can no longer castle.',
      '1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6 5. bxa6 Bxa6 6. Nc3 d6 7. e4 Bxf1 8. Kxf1 g6': 'The other bishop goes to g7 to hit the queenside.',
    },
  },
  {
    family: 'Dutch Defense',
    side: 'black',
    level: 'intermediate',
    summary:
      '1...f5 controls e4 and stakes a claim on the kingside. It is ambitious and unbalanced: Black often attacks on the kingside later, but the king is a little more exposed. Main setups: Leningrad (...g6), Stonewall (...d5, ...e6, ...c6) and Classical (...e6, ...d6).',
    ideasWhite: [
      'Fianchetto with g3 and Bg2 to fight for e4 and the long diagonal.',
      'Prepare the e4 break.',
      'The weakened e8-h5 diagonal can allow early tactics.',
    ],
    ideasBlack: [
      'Control e4: it is the key square.',
      'Pick a setup: Leningrad, Stonewall or Classical.',
      'Attack on the kingside with ...Qe8-h5 or ...g5 when it is safe.',
    ],
    typicalPlans: [
      'Leningrad: ...g6, ...Bg7, ...O-O and ...d6, then ...e5 or ...Qe8.',
      'Stonewall: pawns on c6, d5, e6 and f5; a knight lands on e4.',
    ],
    keyVariations: [
      {
        name: 'Dutch Defense: Leningrad Variation',
        // 1. d4 f5 2. c4 Nf6 3. g3 g6 4. Bg2 Bg7 5. Nf3
        uci: ['d2d4', 'f7f5', 'c2c4', 'g8f6', 'g2g3', 'g7g6', 'f1g2', 'f8g7', 'g1f3'],
        note: "The dynamic, King's Indian-style setup.",
      },
      {
        name: 'Dutch Defense: Stonewall Variation',
        // 1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2 Be7 5. Nf3 O-O 6. O-O d5 7. Nc3 c6
        uci: [
          'd2d4', 'f7f5', 'c2c4', 'g8f6', 'g2g3', 'e7e6', 'f1g2', 'f8e7', 'g1f3', 'e8g8', 'e1g1',
          'd7d5', 'b1c3', 'c7c6',
        ],
        note: "A solid pawn wall; e4 becomes Black's outpost.",
      },
      {
        name: 'Dutch Defense: Classical Variation',
        // 1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2 Be7 5. Nf3 O-O 6. O-O d6
        uci: [
          'd2d4', 'f7f5', 'c2c4', 'g8f6', 'g2g3', 'e7e6', 'f1g2', 'f8e7', 'g1f3', 'e8g8', 'e1g1',
          'd7d6',
        ],
        note: 'Flexible: ...Qe8 and ...e5 often follow.',
      },
      {
        name: 'Dutch Defense: Staunton Gambit',
        // 1. d4 f5 2. e4
        uci: ['d2d4', 'f7f5', 'e2e4'],
        note: 'White sacrifices a pawn to open lines.',
      },
    ],
    traps: [
      {
        title: 'Mate on the open diagonal',
        // 1. d4 f5 2. Bg5 h6 3. Bh4 g5 4. e3 gxh4 5. Qh5#
        uci: ['d2d4', 'f7f5', 'c1g5', 'h7h6', 'g5h4', 'g7g5', 'e2e3', 'g5h4', 'd1h5'],
        note: 'After ...f5, ...h6 and ...g5, the e8-h5 diagonal is wide open. 4...gxh4?? allows Qh5 mate. Play 4...Bg7 or 4...Nf6 instead.',
        side: 'white',
        mistakes: [7],
      },
    ],
    moveNotes: {
      '1. d4 f5': 'Controls e4 from the side.',
      '1. d4 f5 2. c4 Nf6': 'More control of e4.',
      '1. d4 f5 2. c4 Nf6 3. g3': 'White fianchettoes to fight for e4.',
      '1. d4 f5 2. c4 Nf6 3. g3 g6': 'The Leningrad.',
      '1. d4 f5 2. c4 Nf6 3. g3 g6 4. Bg2 Bg7 5. Nf3 O-O 6. O-O d6': 'Prepares ...e5.',
      '1. d4 f5 2. c4 Nf6 3. g3 g6 4. Bg2 Bg7 5. Nf3 O-O 6. O-O d6 7. Nc3 Qe8': 'Supports ...e5 and can swing to h5.',
    },
  },
  {
    family: 'English Opening',
    side: 'white',
    level: 'intermediate',
    summary:
      '1.c4 controls d5 from the side and keeps the center flexible. White often fianchettoes (g3, Bg2), plays on the queenside, or transposes to 1.d4 openings. Many lines are a Sicilian with colors reversed.',
    ideasWhite: [
      'Control d5 with c4, Nc3 and Bg2.',
      'Expand on the queenside with Rb1, b4 and b5.',
      'Stay flexible: d4 or e4 can come later.',
    ],
    ideasBlack: [
      '1...e5 (a reversed Sicilian) grabs central space.',
      '1...c5 (Symmetrical) mirrors White.',
      '1...Nf6 with ...e6 or ...g6 can transpose to the Indian defenses.',
    ],
    typicalPlans: [
      'Botvinnik setup: c4, Nc3, g3, Bg2, e4 and Nge2, a central bind.',
      'Against ...e5: g3, Bg2, Nf3, O-O, then Rb1 and b4 on the queenside.',
    ],
    keyVariations: [
      {
        name: "English Opening: King's English Variation",
        // 1. c4 e5
        uci: ['c2c4', 'e7e5'],
        note: 'Black takes central space; a Sicilian with colors reversed.',
      },
      {
        name: 'English Opening: Carls-Bremen System',
        // 1. c4 e5 2. Nc3 Nf6 3. g3
        uci: ['c2c4', 'e7e5', 'b1c3', 'g8f6', 'g2g3'],
        note: 'The main fianchetto setup against ...e5.',
      },
      {
        name: 'English Opening: Symmetrical Variation',
        // 1. c4 c5
        uci: ['c2c4', 'c7c5'],
        note: 'Black mirrors White.',
      },
      {
        name: 'English Opening: Anglo-Indian Defense',
        // 1. c4 Nf6
        uci: ['c2c4', 'g8f6'],
        note: "Flexible: it can transpose to the Nimzo-, King's Indian or Grünfeld.",
      },
      {
        name: 'English Opening: Agincourt Defense',
        // 1. c4 e6
        uci: ['c2c4', 'e7e6'],
        note: "Black prepares ...d5 with a Queen's Gambit-like setup.",
      },
    ],
    moveNotes: {
      '1. c4': 'Controls d5 from the side.',
      '1. c4 e5': 'A reversed Sicilian.',
      '1. c4 e5 2. Nc3': 'More control of d5.',
      '1. c4 e5 2. Nc3 Nf6 3. g3': 'The fianchetto: the bishop will hit d5 and b7.',
      '1. c4 e5 2. Nc3 Nf6 3. g3 d5': "Black grabs the center with ...d5, like White's d4 in an Open Sicilian: a Dragon with colors reversed.",
      '1. c4 e5 2. Nc3 Nf6 3. g3 d5 4. cxd5 Nxd5 5. Bg2': 'Pressure on d5.',
      '1. c4 e5 2. Nc3 Nf6 3. g3 d5 4. cxd5 Nxd5 5. Bg2 Nb6': 'The knight steps away from the bishop.',
      '1. c4 e5 2. Nc3 Nf6 3. g3 d5 4. cxd5 Nxd5 5. Bg2 Nb6 6. Nf3': 'Develops and hits e5.',
      '1. c4 e5 2. Nc3 Nf6 3. g3 d5 4. cxd5 Nxd5 5. Bg2 Nb6 6. Nf3 Nc6': 'Defends e5.',
    },
  },
  {
    family: 'Réti Opening',
    aka: ['Reti Opening', 'Zukertort Opening'],
    side: 'white',
    level: 'intermediate',
    summary:
      "1.Nf3 and 2.c4 attack Black's center from the flanks instead of occupying it. White fianchettoes and often transposes into the English, the Catalan or a Queen's Gambit. In the opening database, 1.Nf3 by itself is called the Zukertort Opening.",
    ideasWhite: [
      'Pressure d5 with c4 and a bishop on g2 (or b2).',
      'Keep the pawns flexible; strike with d4 or e4 later.',
      'Use transpositions to reach lines you know.',
    ],
    ideasBlack: [
      'Hold the center with ...d5 plus ...c6 or ...e6.',
      '2...d4 grabs space but can become a target.',
      '2...dxc4 is playable if Black develops quickly.',
    ],
    typicalPlans: [
      'Double fianchetto: g3, Bg2, b3, Bb2, O-O and a later d3 or d4.',
      'Against ...d4: e3 or b4 to undermine the advanced pawn.',
    ],
    keyVariations: [
      {
        name: 'Réti Opening',
        // 1. Nf3 d5 2. c4
        uci: ['g1f3', 'd7d5', 'c2c4'],
        note: 'The Réti proper: c4 attacks d5 from the side.',
      },
      {
        name: 'Réti Opening: Advance Variation',
        // 1. Nf3 d5 2. c4 d4
        uci: ['g1f3', 'd7d5', 'c2c4', 'd5d4'],
        note: 'Black gains space; White undermines with e3 or b4.',
      },
      {
        name: 'Réti Opening: Réti Accepted',
        // 1. Nf3 d5 2. c4 dxc4
        uci: ['g1f3', 'd7d5', 'c2c4', 'd5c4'],
        note: 'Black takes; White usually regains it with e3 and Bxc4, or Na3.',
      },
      {
        name: 'English Opening: Neo-Catalan',
        // 1. Nf3 d5 2. c4 e6 3. g3 Nf6
        uci: ['g1f3', 'd7d5', 'c2c4', 'e7e6', 'g2g3', 'g8f6'],
        note: 'With ...e6, it becomes a Catalan-style position.',
      },
    ],
    moveNotes: {
      '1. Nf3': 'Develops and controls e5 and d4 without committing a pawn.',
      '1. Nf3 d5 2. c4': 'The Réti: attacks d5 from the side.',
      '1. Nf3 d5 2. c4 e6': 'Supports d5 solidly.',
      '1. Nf3 d5 2. c4 e6 3. g3': 'Prepares the fianchetto.',
      '1. Nf3 d5 2. c4 e6 3. g3 Nf6 4. Bg2': 'The bishop adds pressure to d5.',
      '1. Nf3 d5 2. c4 e6 3. g3 Nf6 4. Bg2 Be7 5. O-O O-O 6. b3': 'Prepares Bb2: a double fianchetto.',
    },
  },
  {
    family: 'Bird Opening',
    aka: ["Bird's Opening"],
    side: 'white',
    level: 'intermediate',
    summary:
      '1.f4 controls e5 and prepares a kingside setup, like a Dutch Defense with an extra move. White often plays Nf3, e3, b3 and Bb2, aiming the bishop at the kingside. It is offbeat but sound.',
    ideasWhite: [
      'Control e5 with f4, Nf3 and Bb2.',
      'Build a Stonewall (d4, e3, f4) or a fianchetto setup (g3, Bg2).',
      'Attack on the kingside with Qe1-h4 or g4 ideas.',
    ],
    ideasBlack: [
      '1...d5 with a solid setup is the simplest answer.',
      "1...e5 (From's Gambit) is a sharp try; White must avoid early traps.",
      'Use the weakened e1-h4 diagonal with ...Qh4+ ideas.',
    ],
    typicalPlans: [
      'Classic Bird: Nf3, e3, b3, Bb2, Be2, O-O, then Ne5 or Qe1.',
      "Against From's Gambit: 2.fxe5 d6 3.exd6 Bxd6 4.Nf3, and keep the extra pawn safely.",
    ],
    keyVariations: [
      {
        name: 'Bird Opening: Dutch Variation',
        // 1. f4 d5
        uci: ['f2f4', 'd7d5'],
        note: 'The most solid reply.',
      },
      {
        name: "Bird Opening: From's Gambit",
        // 1. f4 e5
        uci: ['f2f4', 'e7e5'],
        note: "Black gives a pawn to attack White's weakened kingside.",
      },
      {
        name: "Bird Opening: From's Gambit, Lasker Variation",
        // 1. f4 e5 2. fxe5 d6 3. exd6 Bxd6 4. Nf3 g5
        uci: ['f2f4', 'e7e5', 'f4e5', 'd7d6', 'e5d6', 'f8d6', 'g1f3', 'g7g5'],
        note: 'Black throws in ...g5 to chase the f3 knight.',
      },
      {
        name: 'Bird Opening: Lasker Variation',
        // 1. f4 d5 2. Nf3 Nf6 3. e3 c5
        uci: ['f2f4', 'd7d5', 'g1f3', 'g8f6', 'e2e3', 'c7c5'],
        note: 'A classical setup for Black.',
      },
    ],
    traps: [
      {
        title: "From's Gambit mate",
        // 1. f4 e5 2. fxe5 d6 3. exd6 Bxd6 4. Nc3 Qh4+ 5. g3 Qxg3+ 6. hxg3 Bxg3#
        uci: [
          'f2f4', 'e7e5', 'f4e5', 'd7d6', 'e5d6', 'f8d6', 'b1c3', 'd8h4', 'g2g3', 'h4g3', 'h2g3',
          'd6g3',
        ],
        note: 'After 3...Bxd6, the natural 4.Nc3?? loses: ...Qh4+ and ...Qxg3+ lead to mate. 4.Nf3, covering h4, is the right move.',
        side: 'black',
        mistakes: [6],
      },
    ],
    moveNotes: {
      '1. f4': 'Controls e5 and prepares a kingside setup.',
      '1. f4 d5 2. Nf3': 'Develops and covers h4 and e5.',
      '1. f4 d5 2. Nf3 Nf6 3. e3': 'Opens the f1 bishop.',
      '1. f4 d5 2. Nf3 Nf6 3. e3 g6 4. b3': 'Prepares Bb2 to aim at e5 and the kingside.',
      '1. f4 d5 2. Nf3 Nf6 3. e3 g6 4. b3 Bg7 5. Bb2 O-O 6. Be2 c5 7. O-O': 'A typical Bird setup: e5 is under control.',
    },
  },
  {
    family: "King's Indian Attack",
    side: 'white',
    level: 'beginner',
    summary:
      "White sets up Nf3, g3, Bg2, O-O, d3 and e4 against almost anything. It is a King's Indian Defense with colors reversed and an extra move, popular at club level because the plan is clear: push e5 and attack the king.",
    ideasWhite: [
      'Same setup every time: Nf3, g3, Bg2, O-O, d3, Nbd2 and e4.',
      'Push e5 to gain kingside space, then bring pieces over (Re1, Nf1, h4).',
      'It also works against French- and Sicilian-style setups.',
    ],
    ideasBlack: [
      'Take the center with ...d5, ...c5 and ...Nc6.',
      'Expand on the queenside with ...b5 and ...b4 while White attacks.',
      "Don't let White's e5 push go unchallenged.",
    ],
    typicalPlans: [
      'Against ...e6, ...d5 and ...c5: e4, Re1, e5, then Nf1, h4 and a kingside attack; Black answers with ...b5-b4.',
      'Against ...c6 with ...Bg4 or ...Bf5: a quieter game with e4 or c4.',
    ],
    keyVariations: [
      {
        name: "King's Indian Attack",
        // 1. Nf3 d5 2. g3
        uci: ['g1f3', 'd7d5', 'g2g3'],
        note: 'The setup begins.',
      },
      {
        name: "King's Indian Attack: Double Fianchetto",
        // 1. Nf3 d5 2. g3 g6
        uci: ['g1f3', 'd7d5', 'g2g3', 'g7g6'],
        note: 'Black mirrors with ...g6.',
      },
      {
        name: "King's Indian Attack: French Variation",
        // 1. Nf3 d5 2. g3 c5 3. Bg2 Nc6
        uci: ['g1f3', 'd7d5', 'g2g3', 'c7c5', 'f1g2', 'b8c6'],
        note: 'Black grabs space with ...c5 and ...Nc6.',
      },
      {
        name: "French Defense: King's Indian Attack",
        // 1. e4 e6 2. d3
        uci: ['e2e4', 'e7e6', 'd2d3'],
        note: 'The same setup against the French.',
      },
    ],
    moveNotes: {
      '1. Nf3 d5 2. g3': 'The KIA setup begins.',
      '1. Nf3 d5 2. g3 Nf6 3. Bg2 e6 4. O-O Be7 5. d3': 'Prepares e4.',
      '1. Nf3 d5 2. g3 Nf6 3. Bg2 e6 4. O-O Be7 5. d3 O-O 6. Nbd2': 'Supports e4.',
      '1. Nf3 d5 2. g3 Nf6 3. Bg2 e6 4. O-O Be7 5. d3 O-O 6. Nbd2 c5': 'Black grabs queenside space.',
      '1. Nf3 d5 2. g3 Nf6 3. Bg2 e6 4. O-O Be7 5. d3 O-O 6. Nbd2 c5 7. e4': 'Challenges the center; e5 may follow.',
      '1. Nf3 d5 2. g3 Nf6 3. Bg2 e6 4. O-O Be7 5. d3 O-O 6. Nbd2 c5 7. e4 Nc6 8. Re1': 'Supports e4 and a later e5.',
    },
  },
  {
    family: 'Englund Gambit',
    aka: ['Englund Gambit Declined'],
    side: 'black',
    level: 'beginner',
    summary:
      '1.d4 e5 gives up a pawn at once. It is objectively dubious, but it hides a famous trap that catches many unprepared players. Learn the trap and the simple antidote; as White, there is nothing to fear.',
    ideasWhite: [
      'Take the pawn (2.dxe5) and develop normally.',
      'After ...Qb4+ and ...Qxb2, answer with Nc3, not Bc3.',
      '4.Bf4 is the main line; 4.Qd5 is a simpler way to hold e5, though 4...f6 gives Black some play.',
    ],
    ideasBlack: [
      '...Nc6 and ...Qe7 attack e5 and set up the trap.',
      'The queen raid ...Qb4+ and ...Qxb2 is the key idea.',
      'If White plays carefully, Black is simply a pawn down.',
    ],
    keyVariations: [
      {
        name: 'Englund Gambit: Main Line',
        // 1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7
        uci: ['d2d4', 'e7e5', 'd4e5', 'b8c6', 'g1f3', 'd8e7'],
        note: 'Black attacks e5 and prepares ...Qb4+.',
      },
      {
        name: 'Englund Gambit: Stockholm Variation',
        // 1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7 4. Qd5
        uci: ['d2d4', 'e7e5', 'd4e5', 'b8c6', 'g1f3', 'd8e7', 'd1d5'],
        note: 'A practical reply: the queen holds e5 and White stays out of the main trap.',
      },
    ],
    traps: [
      {
        title: 'Englund Gambit trap',
        // 1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7 4. Bf4 Qb4+ 5. Bd2 Qxb2 6. Bc3 Bb4 7. Qd2 Bxc3 8. Qxc3 Qc1#
        uci: [
          'd2d4', 'e7e5', 'd4e5', 'b8c6', 'g1f3', 'd8e7', 'c1f4', 'e7b4', 'f4d2', 'b4b2', 'd2c3',
          'f8b4', 'd1d2', 'b4c3', 'd2c3', 'b2c1',
        ],
        note: 'After 5...Qxb2, the calm 6.Nc3! keeps White clearly better. The natural 6.Bc3?? walks into ...Bb4 and, after 7.Qd2 Bxc3 8.Qxc3, ...Qc1 mate.',
        side: 'black',
        mistakes: [10],
      },
    ],
    moveNotes: {
      '1. d4 e5': 'The Englund Gambit: a pawn for quick play.',
      '1. d4 e5 2. dxe5': 'Takes the pawn.',
      '1. d4 e5 2. dxe5 Nc6': 'Attacks e5.',
      '1. d4 e5 2. dxe5 Nc6 3. Nf3': 'Defends e5.',
      '1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7': 'Attacks e5 again and prepares ...Qb4+.',
      '1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7 4. Bf4': 'Defends e5 a second time.',
      '1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7 4. Bf4 Qb4+': 'Check, and the queen also hits b2 and, along the 4th rank, the f4 bishop. 5.Bd2 blocks and saves it.',
      '1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7 4. Bf4 Qb4+ 5. Bd2 Qxb2': 'Grabs the pawn and attacks the rook.',
      '1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7 4. Bf4 Qb4+ 5. Bd2 Qxb2 6. Nc3': 'The right reply: it develops, and the a1 rook is covered by the queen. White is clearly better.',
    },
  },
];

/** Lowercase, no accents, straight apostrophes: "Grünfeld" and "Grunfeld" match. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

interface GuideIndex {
  /** Normalized family names and plain aliases. */
  families: Map<string, OpeningGuide>;
  /** Normalized full-name aliases ("queen's pawn game: london system"), longest first. */
  fullNames: [string, OpeningGuide][];
}

let index: GuideIndex | null = null;

function guideIndex(): GuideIndex {
  if (index) return index;
  const families = new Map<string, OpeningGuide>();
  const fullNames: [string, OpeningGuide][] = [];
  for (const g of OPENING_GUIDES) families.set(normalize(g.family), g);
  for (const g of OPENING_GUIDES) {
    for (const a of g.aka ?? []) {
      const n = normalize(a);
      if (n.includes(':')) fullNames.push([n, g]);
      else if (!families.has(n)) families.set(n, g);
    }
  }
  // Longest first, so the most specific full-name alias wins.
  fullNames.sort((a, b) => b[0].length - a[0].length);
  return (index = { families, fullNames });
}

/**
 * The guide for an opening family or a full dataset name ("Sicilian Defense",
 * "Sicilian Defense: Najdorf Variation", "Russian Game", "Grunfeld Defense"), or undefined.
 * Full-name aliases win ("Queen's Pawn Game: London System" -> London System); then the family
 * before ':', then the family before ',' ("London System, with Be2" -> London System).
 */
export function guideFor(familyOrName: string | null | undefined): OpeningGuide | undefined {
  const n = normalize(familyOrName ?? '');
  if (!n) return undefined;
  const { families, fullNames } = guideIndex();
  for (const [alias, g] of fullNames) {
    if (n === alias || n.startsWith(alias + ',') || n.startsWith(alias + ':')) return g;
  }
  const family = n.split(':')[0].trim();
  return families.get(family) ?? families.get(family.split(',')[0].trim());
}

/** The `moveNotes` key for a line of SAN moves from the initial position: "1. e4 e5 2. Nf3". */
export function moveNoteKey(sans: readonly string[]): string {
  return sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');
}

/** The guide's note on the last move of `sans` (SAN moves from the initial position), if any. */
export function moveNoteFor(guide: OpeningGuide, sans: readonly string[]): string | undefined {
  if (!sans.length || !guide.moveNotes) return undefined;
  const key = moveNoteKey(sans);
  return Object.hasOwn(guide.moveNotes, key) ? guide.moveNotes[key] : undefined;
}

/**
 * The SAN moves (from the initial position) of the guide's main line, the line its `moveNotes`
 * explain: `mainLine` when set, else its longest annotated line (the first one on a tie). Learn and drill modes should step
 * through this line rather than the catalog's main line of the family, which can be another move
 * order or setup (the London System guide follows 1.d4 d5 2.Bf4, the catalog's "London System"
 * line is 1.d4 Nf6 2.Nf3 g6 3.Bf4). [] for a guide without notes.
 */
export function guideMainLine(guide: OpeningGuide): string[] {
  const sansOf = (key: string): string[] => key.split(' ').filter((t) => !/^\d+\.$/.test(t));
  if (guide.mainLine && guide.moveNotes && Object.hasOwn(guide.moveNotes, guide.mainLine)) return sansOf(guide.mainLine);
  let best: string[] = [];
  for (const key of Object.keys(guide.moveNotes ?? {})) {
    const sans = sansOf(key);
    if (sans.length > best.length) best = sans;
  }
  return best;
}
