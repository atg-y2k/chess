/**
 * Dev-only component gallery. Open /gallery.html?g=<name> with `npm run dev` to render
 * src/dev/<name>.gallery.tsx (its default export is a component). Not part of the app build.
 */
import { render } from 'preact';
import '../styles/app.css';
import '../ui/skins.css';
import { watchSystemTheme } from '../theme';
import { applySkins, boardTheme, initSkins, isBoardTheme, isPieceSet, pieceSet } from '../ui/skins';

// Galleries follow the OS colour scheme (emulate it to check both themes); `?theme=dark|light` forces one.
const params = new URLSearchParams(location.search);
const forced = params.get('theme');
watchSystemTheme(() => (forced === 'dark' || forced === 'light' ? forced : 'system'));
// ... and the app's board theme and piece set (Menu → Board & pieces); `?board=wood&pieces=chessnut` forces them.
// They are forced for this page only (not stored), on <html> and in the signals the galleries' pickers
// start from, so a picker shows the forced skin and changing one keeps the other.
initSkins();
const board = params.get('board');
const pieces = params.get('pieces');
if (isBoardTheme(board)) boardTheme.value = board;
if (isPieceSet(pieces)) pieceSet.value = pieces;
applySkins(boardTheme.peek(), pieceSet.peek());

const galleries = import.meta.glob<{ default: () => preact.JSX.Element }>('./*.gallery.tsx');

async function main() {
  const name = params.get('g');
  const root = document.getElementById('app')!;
  const key = `./${name}.gallery.tsx`;
  if (!name || !galleries[key]) {
    root.innerHTML =
      '<ul style="padding:24px">' +
      Object.keys(galleries)
        .map((k) => k.slice(2, -'.gallery.tsx'.length))
        .map((n) => `<li><a style="color:var(--accent)" href="?g=${n}">${n}</a></li>`)
        .join('') +
      '</ul>';
    return;
  }
  const mod = await galleries[key]();
  const Gallery = mod.default;
  render(<Gallery />, root);
}

main();
