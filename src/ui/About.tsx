/**
 * "About" section (in the Menu): the app's GPL notice, where to get the source, and the credits
 * and licenses of the components it ships (the bundled code has lost their license headers, so
 * the notices are shown here). The full GPL text is loaded on demand from the repository's
 * LICENSE (a separate chunk, precached like the rest of the app, so it also works offline).
 */
import { useState } from 'preact/hooks';
import './About.css';

/** Public source of the app (GPL-3.0-or-later: the corresponding source must be offered). */
export const SOURCE_URL = 'https://github.com/atg-y2k/chess';

/** The GPL notice, after the app's name. */
export const GPL_NOTICE =
  'is free software: you can redistribute it and/or modify it under the terms of the GNU General ' +
  'Public License as published by the Free Software Foundation, either version 3 of the License, or ' +
  '(at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.';

interface Credit {
  name: string;
  what: string;
  by: string;
  license: string;
  url: string;
}

export const CREDITS: Credit[] = [
  {
    name: 'Stockfish 19 (Stockfish.js lite)',
    what: 'the chess engine',
    by: 'the Stockfish developers; Stockfish.js by Nathan Rugg, © 2026 Chess.com, LLC',
    license: 'GPL-3.0',
    url: 'https://github.com/nmrugg/stockfish.js/tree/v19.0.0',
  },
  {
    name: 'chessground',
    what: 'the board, with the cburnett piece set',
    by: 'lichess.org',
    license: 'GPL-3.0',
    url: 'https://github.com/lichess-org/chessground',
  },
  {
    name: 'chess.js',
    what: 'the rules of chess',
    by: '© 2025 Jeff Hlywa',
    license: 'BSD-2-Clause (below)',
    url: 'https://github.com/jhlywa/chess.js',
  },
  {
    name: 'Preact and @preact/signals',
    what: 'the user interface',
    by: '© 2015-present Jason Miller; © 2022-present Preact Team',
    license: 'MIT (below)',
    url: 'https://preactjs.com/',
  },
  {
    name: 'Workbox',
    what: 'offline support',
    by: '© 2018 Google LLC',
    license: 'MIT (below)',
    url: 'https://github.com/GoogleChrome/workbox',
  },
  {
    name: 'lichess chess-openings',
    what: 'opening names and book moves',
    by: 'lichess.org',
    license: 'CC0 (public domain)',
    url: 'https://github.com/lichess-org/chess-openings',
  },
];

const BSD_2 = `Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com)
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const MIT = `Preact: Copyright (c) 2015-present Jason Miller
@preact/signals: Copyright (c) 2022-present Preact Team
Workbox: Copyright 2018 Google LLC

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** The full GPL text, fetched the first time it is opened. */
function GplText() {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = (e: Event) => {
    if (!(e.currentTarget as HTMLDetailsElement).open || text !== null) return;
    import('../../LICENSE?raw').then(
      (m) => setText(m.default),
      () => setFailed(true),
    );
  };
  return (
    <details class="about-more" onToggle={load}>
      <summary>GNU General Public License v3 (full text)</summary>
      <pre class="about-text">
        {text ?? (failed ? 'Could not load the license text. It is at https://www.gnu.org/licenses/gpl-3.0.html' : 'Loading…')}
      </pre>
    </details>
  );
}

/** The Menu's About section. */
export function About() {
  return (
    <div class="sheet-group about">
      <p class="about-lead">
        <strong>Chess Coach</strong> {GPL_NOTICE}
      </p>
      <p class="about-links">
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" data-id="source">
          Source code
        </a>
        <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">
          GPL-3.0 online
        </a>
      </p>
      <GplText />
      <details class="about-more">
        <summary>Credits and third-party licenses</summary>
        <ul class="about-credits">
          {CREDITS.map((c) => (
            <li key={c.name}>
              <a href={c.url} target="_blank" rel="noopener noreferrer">
                {c.name}
              </a>{' '}
              ({c.what}): {c.by}. License: {c.license}.
            </li>
          ))}
        </ul>
        <h4 class="about-h">chess.js: BSD-2-Clause</h4>
        <pre class="about-text">{BSD_2}</pre>
        <h4 class="about-h">Preact, @preact/signals, Workbox: MIT</h4>
        <pre class="about-text">{MIT}</pre>
      </details>
    </div>
  );
}

/** One line for pages outside the app (the engine self-test). */
export function LegalFooter() {
  return (
    <p class="about-footer">
      Chess Coach is free software (GPL-3.0-or-later) and comes with ABSOLUTELY NO WARRANTY.{' '}
      <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
        Source code
      </a>
    </p>
  );
}
