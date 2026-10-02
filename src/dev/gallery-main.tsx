/**
 * Dev-only component gallery. Open /gallery.html?g=<name> with `npm run dev` to render
 * src/dev/<name>.gallery.tsx (its default export is a component). Not part of the app build.
 */
import { render } from 'preact';
import '../styles/app.css';
import { watchSystemTheme } from '../theme';

// Galleries follow the OS colour scheme (emulate it to check both themes); `?theme=dark|light` forces one.
const forced = new URLSearchParams(location.search).get('theme');
watchSystemTheme(() => (forced === 'dark' || forced === 'light' ? forced : 'system'));

const galleries = import.meta.glob<{ default: () => preact.JSX.Element }>('./*.gallery.tsx');

async function main() {
  const name = new URLSearchParams(location.search).get('g');
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
