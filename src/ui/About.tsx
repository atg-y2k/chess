/**
 * "About" section (in the Menu): the app's GPL notice, its version, where to get the source, and
 * the credits and licenses of the components it ships. The build also writes every bundled
 * package's license text to THIRD-PARTY-LICENSES.txt next to the app, and the engine's source and
 * license notes are in engine/README.md (with engine/COPYING-stockfish.txt). Those two and the full
 * GPL text (the repository's LICENSE, a separate chunk) open in the in-app license viewer
 * (LicenseSheet), which works offline and in the App Store app; their links keep real hrefs. The
 * source link opens in the browser (Safari, in the App Store app). Where Pro is sold, it also links to
 * the privacy policy, terms of use and support page, so they stay reachable once Pro is unlocked.
 */
import { useCallback, useState } from 'preact/hooks';
import { APP_NAME, APP_VERSION, LEGAL_URLS, nativeBuild, paywallEnabled } from '../native/platform';
import { LicenseSheet, fileDoc, type LicenseDoc } from './LicenseSheet';
import './About.css';

/**
 * Where users get the app's source (GPL-3.0-or-later: the corresponding source must be offered):
 * the repository, or in the App Store app the tag of its release (https://github.com/atg-y2k/chess/tree/v<version>).
 * vite.config.ts sets it (SOURCE_URL there); a build for another host sets VITE_SOURCE_URL (e.g. a
 * source archive next to the app), as THIRD-PARTY-LICENSES.txt does.
 */
export const SOURCE_URL: string = (import.meta.env.VITE_SOURCE_URL as string | undefined) || 'https://github.com/atg-y2k/chess';

/** The license texts of everything the build ships (written by the build next to index.html). */
export const THIRD_PARTY_URL = `${import.meta.env.BASE_URL}THIRD-PARTY-LICENSES.txt`;
/** The engine's source, license and checksums (public/engine/README.md, shipped with the app). */
export const ENGINE_NOTES_URL = `${import.meta.env.BASE_URL}engine/README.md`;

/**
 * Whether About shows the privacy policy, terms and support links: in the App Store app (and the
 * paywall test build). The web app sells nothing and has no account, so it does not need them.
 */
export const SHOW_LEGAL_LINKS: boolean = nativeBuild || paywallEnabled;

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
  nativeBuild
    ? {
        name: 'Capacitor',
        what: 'the iOS app around the game: share sheet, haptics, status bar, launch screen',
        by: '© 2017-present Drifty Co.; includes code from Apache Cordova, © The Apache Software Foundation',
        license: 'MIT (below); Apache-2.0 for the Cordova code (see Third-party licenses)',
        url: 'https://capacitorjs.com/',
      }
    : {
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

/** The MIT-licensed components named in the credits (Workbox only ships with the web app, Capacitor with the iOS app). */
const MIT_NAMES = `Preact, @preact/signals, ${nativeBuild ? 'Capacitor' : 'Workbox'}`;

const MIT = `Preact: Copyright (c) 2015-present Jason Miller
@preact/signals: Copyright (c) 2022-present Preact Team
${nativeBuild ? 'Capacitor: Copyright (c) 2017-present Drifty Co.' : 'Workbox: Copyright 2018 Google LLC'}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** The texts the license viewer shows. */
export const GPL_DOC: LicenseDoc = {
  id: 'gpl',
  title: 'GNU General Public License v3',
  load: () => import('../../LICENSE?raw').then((m) => m.default),
};
export const THIRD_PARTY_DOC: LicenseDoc = fileDoc('third-party', 'Third-party licenses', THIRD_PARTY_URL);
export const ENGINE_NOTES_DOC: LicenseDoc = fileDoc('engine-notes', 'Engine source and license', ENGINE_NOTES_URL);

/** The Menu's About section. */
export function About() {
  const [doc, setDoc] = useState<LicenseDoc | null>(null);
  const close = useCallback(() => setDoc(null), []);
  /** Opens `d` in the viewer; a modified click (new tab, on the web) follows the link instead. */
  const show = (d: LicenseDoc) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setDoc(d);
  };
  return (
    <div class="sheet-group about">
      <p class="about-lead">
        <strong>{APP_NAME}</strong> {GPL_NOTICE}
      </p>
      {APP_VERSION && (
        <p class="about-version" data-id="version">
          Version {APP_VERSION}
        </p>
      )}
      <p class="about-links">
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" data-id="source">
          Source code
        </a>
        <a
          href="https://www.gnu.org/licenses/gpl-3.0.html"
          target="_blank"
          rel="noopener noreferrer"
          data-id="gpl"
          onClick={show(GPL_DOC)}
        >
          GPL-3.0 (full text)
        </a>
        <a href={THIRD_PARTY_URL} target="_blank" rel="noopener" data-id="third-party" onClick={show(THIRD_PARTY_DOC)}>
          Third-party licenses
        </a>
        <a
          href={ENGINE_NOTES_URL}
          target="_blank"
          rel="noopener"
          data-id="engine-notes"
          onClick={show(ENGINE_NOTES_DOC)}
        >
          Engine source and license
        </a>
      </p>
      {SHOW_LEGAL_LINKS && (
        <p class="about-links about-legal">
          <a href={LEGAL_URLS.privacy} target="_blank" rel="noopener noreferrer" data-id="about-privacy">
            Privacy Policy
          </a>
          <a href={LEGAL_URLS.terms} target="_blank" rel="noopener noreferrer" data-id="about-terms">
            Terms of Use
          </a>
          <a href={LEGAL_URLS.support} target="_blank" rel="noopener noreferrer" data-id="about-support">
            Support
          </a>
        </p>
      )}
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
        <h4 class="about-h">{MIT_NAMES}: MIT</h4>
        <pre class="about-text">{MIT}</pre>
      </details>
      <LicenseSheet doc={doc} onClose={close} />
    </div>
  );
}

/** One line for pages outside the app (the engine self-test). */
export function LegalFooter() {
  return (
    <p class="about-footer">
      {APP_NAME} is free software (GPL-3.0-or-later) and comes with ABSOLUTELY NO WARRANTY.{' '}
      <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
        Source code
      </a>
    </p>
  );
}
