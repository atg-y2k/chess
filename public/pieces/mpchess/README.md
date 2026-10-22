# MPchess (chess pieces)

The MPchess piece set, one of the piece sets Chess Coach offers (Menu → Board & pieces).

- Art: Maxime Chupin
- License: GPL-3.0-only. Upstream says “GNU GENERAL PUBLIC LICENSE, Version 3, 29 June 2007” and
  ships the GPL-3.0 text, with no “or any later version”, so it is version 3 of the GPL (GPLv3
  section 14); lila’s COPYING.md lists it as GPLv3+. Chess Coach distributes it under GPL-3.0, whose
  text ships with the app (engine/COPYING-stockfish.txt, and Menu → About → Licenses).
- Source: lichess.org's lila repository at commit cd2656d2787a766ba743da8da1dd3b24975e6329:
  https://github.com/lichess-org/lila/tree/cd2656d2787a766ba743da8da1dd3b24975e6329/public/piece/mpchess
  (the set's license is listed in https://github.com/lichess-org/lila/blob/cd2656d2787a766ba743da8da1dd3b24975e6329/COPYING.md).
  Upstream: https://github.com/chupinmaxime/mpchess-pieces (README: “GNU GENERAL PUBLIC LICENSE,
  Version 3”), checked at commit 720f6e050b4ee9b6e68f1ef5d89330a44850d54e, which also has the set's
  other forms (SVG, MetaPost, fonts): https://github.com/chupinmaxime/mpchess-pieces/tree/720f6e050b4ee9b6e68f1ef5d89330a44850d54e
- The 12 SVG files are lila's copies, byte for byte the files at that commit. lila prepares the
  artist's SVGs for the web (minified, with a `color-scheme:light only` style it adds); Chess Coach
  made no further changes. SHA-256:

    b9daea1c15d832c85fcc9b30a1b074b4644711053d49b3056752c53d7ff0b37c  wK.svg
    f7954e0f514faecf46674ad9657a486c15760a466dcf7d429bdeca437837bd92  wQ.svg
    889e094b9fa1ff3b058434401247f600367eda8656aaeb5fa07e4aa9bf2e5368  wR.svg
    42d8b0f1e6615052023617a3b6b6d60fc40172cc79d2e1b8a2610b28ed8c180b  wB.svg
    699d5567223b140922e592380209515da1e4b19aefde01b979153a4000a0a984  wN.svg
    c95c4b57cbd20cd198d7f488c021b4cc29221e96ee7b6092f680d6e11111c36c  wP.svg
    9a3a3bfbcc185be5ffcd25b4cfc6a1f361856a77152f44f7b4e5b7e962085636  bK.svg
    c59a82672f2562cc2da7c32ab6bf8ef47aca6a79f2aa61f589a8c6bf7270eb3c  bQ.svg
    c9f9eeb8af73ca6baaaf9a529957a4c767c93c7149cd4d8d45215d0dd39bf7b0  bR.svg
    b4dfae44a58000acbb39a95dc618a74080f2b1c2b401dd8ccb129a49536965e3  bB.svg
    86b7ed041767241632005b0876de769de67249eff9e43956cfb2660a0acdd0bb  bN.svg
    3744cc43f5517bf5f211eddf7ce8159b8021f5247fc617ce15dd4bc6c473f2e7  bP.svg
