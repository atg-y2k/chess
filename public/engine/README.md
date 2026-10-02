# Stockfish.js engine files

This folder holds an unmodified copy of the **Stockfish 19 "lite single-threaded" WebAssembly
engine** from Stockfish.js. The app runs it in a Web Worker and talks to it over UCI (a text
protocol). Vite copies this folder into the build unchanged, and the service worker precaches it so
the engine also works offline.

| File | Size (bytes) | SHA-256 |
|---|---:|---|
| `stockfish-19-lite-single.js` | 21,415 | `d3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6` |
| `stockfish-19-lite-single.wasm` | 1,787,571 | `57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387` |
| `COPYING-stockfish.txt` | 35,821 | `0b383d5a63da644f628d99c33976ea6487ed89aaa59f0b3257992deac1171e6b` |

Check them with `sha256sum public/engine/*`.

## Source and licence

- **Stockfish.js 19**, (c) 2026 Chess.com, LLC, by Nathan Rugg. It is based on
  [Stockfish](https://github.com/official-stockfish/Stockfish) (c) T. Romstad, M. Costalba,
  J. Kiiski, G. Linscott and other contributors. The lite NNUE net (`nn-61e7af4bb97d`) is by
  Chris Bao (sscg13).
- **Licence:** GNU General Public License v3 (GPL-3.0). The full text is in
  [`COPYING-stockfish.txt`](COPYING-stockfish.txt), identical to the upstream `Copying.txt` and to
  this repository's `LICENSE`.
- **Corresponding source:** upstream repository
  [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js), tag
  [`v19.0.0`](https://github.com/nmrugg/stockfish.js/tree/v19.0.0). The same files are in the release
  assets (`https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0/<file>`) and in the npm
  package [`stockfish@19.0.0`](https://www.npmjs.com/package/stockfish/v/19.0.0) under `bin/`
  (tarball integrity
  `sha512-jDyYLbqNpboQcMs5HodTHI2CrKL74zkQWb1+sgoNXw5HI6avTblW4G0X7afFt3BBOc6VbTSkOV64EUxm/DWSpg==`).
  The upstream README explains how to rebuild the engine with Emscripten (`./build.js`).

Chess Coach as a whole is distributed under the GPL-3.0-or-later (see `LICENSE` at the repository
root). Its complete source is at <https://github.com/atg-y2k/chess>; a copy hosted elsewhere names
its source in `THIRD-PARTY-LICENSES.txt`, next to the app.

## Updating

1. Download the two `stockfish-<version>-lite-single.*` files from the new upstream release (or
   copy them from `node_modules/stockfish/bin/` after a temporary `npm pack stockfish@<version>`).
2. Keep the `.js` and `.wasm` side by side under the same base name. The worker loads the `.wasm`
   from its own URL with `.js` replaced by `.wasm`, so do not rename or hash them.
3. Never put new content under an old file name: installed apps keep the engine files cached by
   name (the service worker precaches them without a revision, so that the first visit downloads
   them only once). Upstream names carry the version, so a new version has new names.
4. Update the file name in `src/engine/workerTransport.ts`, the names and SHA-256 in `ENGINE_FILES`
   in `vite.config.ts` (the build fails until they match), the table above and the tag link.
