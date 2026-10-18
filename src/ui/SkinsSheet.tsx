/**
 * "Board & pieces" (the Menu's Appearance section): the board theme and the piece set, picked
 * separately, free in every build. A sheet over the Menu, which stays open under it (Escape, the X,
 * a swipe down or a tap outside close only this one, and give the focus back to the Menu).
 *
 * On top, a live preview: the app's own Board, read-only, on a real middlegame position with its
 * last move, in the chosen skin, with the names and the set's credit beside it. Under it the two
 * pickers (SkinPickers.tsx). A tap applies a choice at once and stores it; the preview, the game
 * board behind the sheets and every other board follow without a re-render of their own
 * (src/ui/skins.css keys off <html data-board data-pieces>).
 *
 * The preview stays in sight (sticky) while the pickers scroll under it. Where the sheet is short and
 * wide (a phone in landscape, the iPhone Duo half folded on a table), it is a column beside them.
 */
import { useId } from 'preact/hooks';
import { Board } from './Board';
import { Sheet } from './Sheet';
import { BoardThemePicker, PieceSetPicker } from './SkinPickers';
import { SKIN_LICENSES, boardThemeLabel, pieceSetLabel, pieceSetOf, type BoardThemeId, type PieceSetId } from './skins';
import './SkinsSheet.css';

/** The sheet's title, and the Menu row's label. */
export const SKINS_TITLE = 'Board & pieces';

/**
 * The preview's position: the Queen's Gambit Declined, Orthodox Defense, after Capablanca's freeing
 * maneuver (…Nd5, …e5) and 14…Nf6. Both sides have every kind of piece, the center is open (so the
 * squares show), and the last move, a knight's, lights a light and a dark square. No check.
 */
export const PREVIEW = {
  moves: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 Nbd7 Rc1 c6 Bd3 dxc4 Bxc4 Nd5 Bxe7 Qxe7 O-O Nxc3 Rxc3 e5 Bb3 exd4 exd4 Nf6',
  fen: 'r1b2rk1/pp2qppp/2p2n2/8/3P4/1BR2N2/PP3PPP/3Q1RK1 w - - 1 15',
  lastMove: ['d7', 'f6'] as [string, string],
} as const;

/** "Preview of the Brown board with the Chessnut pieces" (the preview board's accessible name). */
export function previewLabel(board: string, pieces: string): string {
  return `Preview of the ${boardThemeLabel(board)} with the ${pieceSetLabel(pieces)}`;
}

/** "Pieces by Armando Hernandez Marroquin" and the license's name, under the names. */
export function pieceCredit(pieces: string): { by: string; license: string } {
  const set = pieceSetOf(pieces);
  return { by: `Pieces by ${set.author}`, license: SKIN_LICENSES[set.license].name };
}

const NO_DESTS = new Map<string, string[]>();
const noMove = () => {};

export interface SkinsSheetProps {
  open: boolean;
  board: BoardThemeId;
  pieces: PieceSetId;
  onBoard: (id: BoardThemeId) => void;
  onPieces: (id: PieceSetId) => void;
  onClose: () => void;
}

export function SkinsSheet({ open, board, pieces, onBoard, onPieces, onClose }: SkinsSheetProps) {
  const boardLabelId = useId();
  const piecesLabelId = useId();
  const credit = pieceCredit(pieces);
  return (
    <Sheet open={open} onClose={onClose} title={SKINS_TITLE} class="skins-sheet">
      <div class="skins-layout">
        <div class="skins-preview" data-id="skins-preview">
          <div class="skins-preview-board" role="img" aria-label={previewLabel(board, pieces)}>
            <Board fen={PREVIEW.fen} orientation="white" dests={NO_DESTS} lastMove={PREVIEW.lastMove} onMove={noMove} />
          </div>
          <div class="skins-preview-text">
            <span class="skins-preview-name" aria-hidden="true">
              {boardThemeLabel(board)}
            </span>
            <span class="skins-preview-name" aria-hidden="true">
              {pieceSetLabel(pieces)}
            </span>
            <span class="skins-preview-credit" data-id="pieces-credit">
              {credit.by} · <span class="skin-license">{credit.license}</span>
            </span>
          </div>
        </div>
        <div class="skins-pickers">
          <section class="sheet-section">
            <h3 class="sheet-label" id={boardLabelId}>
              Board
            </h3>
            <BoardThemePicker labelledBy={boardLabelId} value={board} onChange={onBoard} />
          </section>
          <section class="sheet-section">
            <h3 class="sheet-label" id={piecesLabelId}>
              Pieces
            </h3>
            <PieceSetPicker labelledBy={piecesLabelId} value={pieces} onChange={onPieces} />
            <p class="sheet-note">Every set’s artist and license are listed in About, at the end of the Menu.</p>
          </section>
        </div>
      </div>
    </Sheet>
  );
}
