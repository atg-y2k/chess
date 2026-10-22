# Classic (cburnett) chess pieces

The default piece set: Colin M.L. Burnett's pieces exactly as chessground (the board, GPL-3.0)
ships them in `@lichess-org/chessground/assets/chessground.cburnett.css`. These 12 files are that
stylesheet's base64 data URIs decoded, unmodified, so the default look is the one the app always had.
The build inlines them into the app's CSS (src/ui/skins.css), so they load with it.

- Art: Colin M.L. Burnett (https://en.wikipedia.org/wiki/User:Cburnett), as shipped with chessground
  by lichess.org
- License: GPL-2.0-or-later (the art); chessground: GPL-3.0-or-later. Chess Coach distributes both
  under GPL-3.0-or-later.
- Source: https://github.com/lichess-org/chessground (the npm package @lichess-org/chessground,
  version in package-lock.json), assets/chessground.cburnett.css
- SHA-256 of the files:

    3f7f546c1c672cd4939c8577bdb53359517939a6719b4d65fb90c0c3a6e9d0ed  wK.svg
    06cd2e8ab40436c3f7f841642e65cabf27c1a554ecdf67e984d778ad74c169ac  wQ.svg
    c7033117813319e3c477629d337516e051ac2a5438460ad3abf21a8d9bca5bb0  wR.svg
    a0341e416a85b6bd05020bd9a3615f0d4359ebc776cfd9b2bbf2813ca1b73e0e  wB.svg
    1407efd029cc1a59410db0a6b8c596817914c9c5edae303be7374b3d25dd82b4  wN.svg
    c2d652c07fcdb4fb983ad26e45908e631e955bfd84cbae3e93ef5c26f5ad74ab  wP.svg
    324683f02ba4eb5e24cc9b8a9059d6f95d47bb1fff6c2ef0994d247ade9bb23f  bK.svg
    11989a32b8925061ddc6dcc63f9706cdef1f0575161345fb5050d7bba703605e  bQ.svg
    6408c626e971e5cc09cbebc2f8c7b6e5db1ffe29ae612476ff474d53d0103c5b  bR.svg
    b4343211dfa30fd8fb54f02bb6c088dfd64d586699503c7e4b38248546cab986  bB.svg
    c9c51d6d11c2e3993bed1678cf744a205cf56f23c9d13df5af7ed664243e1c1c  bN.svg
    fbf212c48bae17e1438369893b8b053f5a22128301514168a7961d984cb02257  bP.svg
