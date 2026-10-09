# Shipping Chess Coach on the App Store

A step-by-step checklist for putting the iPhone app on the App Store as a **free download with one
"Pro" in-app purchase**, built on your Mac. Work through it top to bottom; most steps happen once.
Plan on 3–6 weeks part-time from enrollment to "live", including one or two review rounds.

> **This is not legal or tax advice.** The business, App Store and licensing facts below come from
> research done on 2026-10-02, with sources at the end. Apple changes its rules and screens often,
> so check anything important against Apple's current pages. Have a lawyer review the EULA and the
> GPL questions in [Licensing](#15-licensing-gpl-every-release), and an accountant the tax and
> company questions.

**Contents**

0. [Decisions to make first](#0-decisions-to-make-first)
1. [Apple Developer Program](#1-apple-developer-program-individual-or-company)
2. [Agreements, tax and banking](#2-agreements-tax-and-banking)
3. [Small Business Program](#3-small-business-program-enroll-before-launch)
4. [EU trader information](#4-eu-trader-information-dsa)
5. [Bundle ID and the App Store Connect app record](#5-bundle-id-and-the-app-store-connect-app-record)
6. [The Pro in-app purchase](#6-the-pro-in-app-purchase)
7. [Build and run on your Mac](#7-build-and-run-on-your-mac)
8. [TestFlight](#8-testflight)
9. [App Privacy](#9-app-privacy)
10. [Age rating](#10-age-rating)
11. [Export compliance](#11-export-compliance)
12. [Screenshots](#12-screenshots)
13. [Name and other metadata](#13-name-and-other-metadata)
14. [App Review notes](#14-app-review-notes)
15. [Licensing (GPL): every release](#15-licensing-gpl-every-release)
16. [The free web version](#16-the-free-web-version-your-decision)
17. [Things the research flagged](#17-things-the-research-flagged)
18. [Submit](#18-submit)
19. [After launch](#19-after-launch)

## Where things live in this repository

| What | Where (the one place to change it) |
|---|---|
| Bundle ID `io.github.atgy2k.chesscoach` | `APP_ID` in `capacitor.config.ts` (`npm run build:native` copies it into the Xcode project) |
| Home Screen name "Chess Coach" | `APP_NAME` in `capacitor.config.ts`. Other places that still say "Chess Coach" are listed under [Renaming the app](#renaming-the-app). |
| Version (e.g. 1.0.0) | `version` in `package.json` (`npm run build:native` writes `MARKETING_VERSION`) |
| Build number | Xcode (target → General → Build), or the release workflow's run number |
| Pro product ID `io.github.atgy2k.chesscoach.pro` | `PRO_PRODUCT_ID` in `src/native/purchases.ts`, and `ios/App/App/Products.storekit` for testing in Xcode |
| What is free and what is Pro | `FEATURE_TIERS` in `src/game/entitlements.ts` |
| Privacy policy, terms (EULA), support page | `public/privacy.html`, `public/terms.html`, `public/support.html`, published with the web app at `https://atg-y2k.github.io/chess/…`. In the app, Menu → About links to all three at any time and the paywall to the first two (`LEGAL_URLS` in `src/native/platform.ts`). `npm run check:legal` lists any placeholder still in them. |
| EULA text for App Store Connect | `docs/EULA-draft.md` (same text as `public/terms.html`) |
| CI build of the iOS app (unsigned) | `.github/workflows/ios-build.yml` |
| Signed build to TestFlight | `.github/workflows/ios-release.yml` |
| App Store screenshots | `node scripts/appstore-screenshots.mjs` |
| Native project details | `ios/README-native.md` |

## 0. Decisions to make first

- [ ] **The name.** "Chess Coach" is crowded: on 2026-10-02 the US App Store had at least nine apps
      with "Chess Coach" in the title, six of them from 2026. Pick a distinctive brand, with "Chess
      Coach" as a descriptor if you like. See [Name and other metadata](#13-name-and-other-metadata).
- [ ] **Individual or company** as the seller (section 1). This decides whose name the App Store shows.
- [ ] **Price of Pro.** The research suggests **US$9.99**, in line with paid chess apps (Chess Tiger Pro
      $9.99, HIARCS $9.99, Shredder $8.99, tChess Pro $7.99; SmallFish $4.99), and less than one month
      of chess.com Diamond. A launch price (e.g. $6.99 for two weeks) can be scheduled.
- [ ] **Where to sell.** Untick **China mainland**: games there need a government approval number.
      Decide whether to sell in the **EU**, which requires public trader contact details (section 4).
- [ ] **The free web version**: keep, limit or retire it (section 16).
- [ ] Already decided in the project: iPhone only (no iPad screenshots needed), portrait only, iOS 16.4
      or later (the engine needs WebAssembly SIMD), GPL-3.0-or-later.

## 1. Apple Developer Program (individual or company)

- [ ] Turn on two-factor authentication for your Apple Account.
- [ ] Enroll at <https://developer.apple.com/programs/enroll/> (US$99 a year; local prices vary). The
      Apple Developer app on your iPhone or Mac also works.

| | Individual | Organization (e.g. an LLC) |
|---|---|---|
| Seller name on the App Store | **Your legal name** | The company's legal name |
| Needs | Apple Account, legal name, an address (no P.O. box at enrollment) | A legal entity (not a DBA or sole proprietorship), a free **D-U-N-S number**, a website on the company's domain, an email on that domain, authority to sign |
| Approval | usually 24–48 hours | D-U-N-S up to 5 business days, plus up to 2 for Apple to receive it, plus 1–2 weeks of verification |
| Later | Apple can convert an individual account into an organization one (your apps and Team ID stay) if you form a legal entity later | |

If seeing your own name as the seller is fine, enroll as an individual: it is the fastest route. If
not, form the company first, then enroll as an organization.

## 2. Agreements, tax and banking

In App Store Connect → **Business**, in this order (the Account Holder must do it):

- [ ] Accept the **Paid Apps Agreement**. Without it you cannot create in-app purchases.
- [ ] **Tax forms**: W-9 if you are a US person (you can use a free IRS EIN instead of your SSN), or
      W-8BEN plus any local forms otherwise.
- [ ] **Bank account** (only possible once the agreement and tax forms are in).

Apple collects and pays VAT and sales tax in most countries and pays you monthly.

## 3. Small Business Program (enroll before launch)

- [ ] Enroll at <https://developer.apple.com/app-store/small-business-program/> as soon as the Paid Apps
      Agreement is active. It cuts Apple's commission from 30% to **15%** while you earn under US$1M a
      year. It is **not automatic**, and the lower rate starts **15 days after the end of the fiscal
      month in which Apple approves you**, so sales before then pay 30%. At $9.99 in the US you keep
      about $8.49 per sale with it.

## 4. EU trader information (DSA)

Selling an app or an in-app purchase usually makes you a "trader" under the EU Digital Services Act.
Apple then shows **an address (a P.O. box is allowed), a phone number and an email** on your EU product
pages. Apps without trader status were removed from EU storefronts on 2025-02-17.

- [ ] App Store Connect → Business → Digital Services Act: enter and verify your trader details. A
      separate phone number, a separate support email and a P.O. box or virtual mailbox (with a
      document linking you to it) limit what becomes public.
- [ ] Or don't sell in the 27 EU countries (Pricing and Availability).

## 5. Bundle ID and the App Store Connect app record

- [ ] Register the bundle ID: <https://developer.apple.com/account/resources/identifiers/list> → **+** →
      App IDs → App → Explicit, **`io.github.atgy2k.chesscoach`** (or whatever `APP_ID` in
      `capacitor.config.ts` says). The In-App Purchase capability is on for every explicit App ID;
      nothing else needs ticking. The bundle ID can't be changed after release, but users never see it,
      so it can stay as it is if you rename the app.
- [ ] Create the app: App Store Connect → Apps → **+** → New App: platform iOS, your chosen name,
      primary language English (U.S.), the bundle ID above, a SKU (e.g. `chesscoach-ios`), full access.
      This **reserves the name**, so do it early.
- [ ] Pricing and Availability: the app is **Free**; untick China mainland (and the EU if you chose
      that); turn off availability on **Apple silicon Macs** until you have tested the app there.

## 6. The Pro in-app purchase

- [ ] App Store Connect → your app → **Monetization → In-App Purchases** → **+**:
  - Type: **Non-Consumable**
  - Reference name: `Pro` (only you see it)
  - Product ID: **`io.github.atgy2k.chesscoach.pro`**. It must equal `PRO_PRODUCT_ID` in
    `src/native/purchases.ts` and can never be reused, even if you delete the purchase.
- [ ] Price: **$9.99** with the United States as the base country; Apple sets the other countries.
- [ ] **Family Sharing: Turn On.** This cannot be turned off again, which is fine: the app and the
      paywall promise it.
- [ ] Localization (English U.S.): display name up to 30 characters, e.g. `Chess Coach Pro`;
      description up to 45 characters, e.g. `Coach explanations, hints and full reviews`.
- [ ] **Review information**: a screenshot of the paywall (`iap-review/paywall.png` from
      [Screenshots](#12-screenshots), or one taken on your iPhone) and a short note (see
      [App Review notes](#14-app-review-notes)).
- [ ] The **first** in-app purchase must be submitted **together with an app version**: on the version
      page, under "In-App Purchases and Subscriptions", select Pro before you submit (section 18).
- Optional later: offer codes work for non-consumables (since 2025-10-29); IAP promo codes were retired
  in March 2026.

The app checks the purchase with StoreKit 2 on the device: no server, no account, and it works
offline. `ios/README-native.md` describes the plugin (`ios/App/App/StorePlugin.swift`).

## 7. Build and run on your Mac

You need **Xcode 26 or later** (from the Mac App Store; App Store uploads must use the iOS 26 SDK since
2026-04-28) and **Node 24** (from <https://nodejs.org> or a version manager).

```sh
git clone https://github.com/atg-y2k/chess.git && cd chess
npm ci                 # install
npm run build:native   # type-check, then build the web app into dist-native/ (no service worker)
npm run cap:sync       # copy it into ios/App/App/public and update the Swift packages list
npm run ios:open       # open ios/App/App.xcodeproj in Xcode
```

In Xcode:

- [ ] **Xcode → Settings → Accounts**: add your Apple Account.
- [ ] Select the **App** target → **Signing & Capabilities** → tick *Automatically manage signing* and
      pick your **Team**. Xcode writes your Team ID into the project; committing it is fine (it is not a
      secret).
- [ ] The first time, Xcode resolves the Swift packages (Capacitor). Commit the
      `Package.resolved` it creates under `ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/`,
      so every build uses the same versions.
- [ ] **Run on your iPhone**: connect it, turn on Settings → Privacy & Security → **Developer Mode**,
      pick it as the run destination and press ⌘R. The Simulator works too.
- [ ] After every change to the web app, run `npm run build:native && npm run cap:sync` again, then Run.
- [ ] Debugging: Debug builds can be inspected with Safari's Web Inspector (Safari → Settings →
      Advanced → *Show features for web developers*, then the **Develop** menu → your iPhone → the app).

**Test the purchase without App Store Connect** (StoreKit testing): the shared `App` scheme points at
`ios/App/App/Products.storekit` (Pro at $9.99, Family Sharing on). Check once under Product → Scheme →
Edit Scheme → Run → Options that *StoreKit Configuration* says `Products.storekit`. Then:

- [ ] Buy Pro; cancel a purchase; turn on **Ask to Buy** (Editor menu, with `Products.storekit` open),
      buy (the app says it's waiting), then approve it in **Debug → StoreKit → Manage Transactions**.
- [ ] Refund it in Manage Transactions: Pro locks again.
- [ ] Delete the transaction, reinstall, and use **Restore Purchases**.

**Test against the sandbox**: create a sandbox tester (App Store Connect → Users and Access → Sandbox),
sign in with it on the iPhone (Settings → Developer, or Settings → App Store → Sandbox Account), and set
the scheme's StoreKit Configuration to **None**. TestFlight builds always use the sandbox, with nothing
charged.

**Device checklist** (things only a real iPhone shows; see `ios/README-native.md`):

- [ ] A fresh install in **airplane mode** starts and plays (nothing is downloaded).
- [ ] Menu → Engine → **Run engine self-test** says PASS.
- [ ] Play a full game with the coach on, then a Game Review, on the oldest iPhone you support (memory
      with two engines).
- [ ] Sounds follow the silent switch and don't stop your music; haptics on moves.
- [ ] Export PGN opens the share sheet; Privacy Policy, Terms and Source code open in Safari.
- [ ] Status bar readable in dark and light themes; nothing under the Dynamic Island or home indicator.
- [ ] Swipe the app away mid-game and reopen: the game, rating and Pro are still there.
- [ ] VoiceOver can reach the main buttons.

## 8. TestFlight

Pick one way to upload; both put the build in App Store Connect → TestFlight.

**A. From Xcode (simplest on your Mac)**

- [ ] Set `version` in `package.json` (1.0.0 for the first release; it is 0.1.0 now), run
      `npm run build:native && npm run cap:sync`, commit, and **push**.
- [ ] Build what you upload from that clean, pushed commit: `npm run build:native:release && npm run cap:sync`.
      It fails if anything is uncommitted, because About links to the source at that exact commit
      (`…/tree/<commit>`; GPL, see section 15). Then tag the commit, e.g.
      `git tag ios-v1.0.0-b7 && git push origin ios-v1.0.0-b7` (version and build number), so the link
      stays valid whatever happens to the branch.
- [ ] In Xcode choose **Any iOS Device (arm64)** as the destination, then **Product → Archive**.
- [ ] In the Organizer: **Distribute App → App Store Connect → Upload**. Each upload needs a new build
      number: raise it under the App target → General → Build, or let the distribution options manage
      it.

**B. From GitHub Actions (`.github/workflows/ios-release.yml`)**

It runs when you push a tag `v<version>` (equal to `package.json`'s version), or by hand from the
Actions tab. It first tags the commit `ios-v<version>-b<build number>` (the source link built into the
app, see section 15), then builds, signs with an App Store Connect API key, sets the version from
`package.json` and the build number from the run number, and uploads. On a `v*` tag it refuses to run
while the legal pages still have placeholders. One-time setup (the top of the workflow file has the
details):

- [ ] App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**,
      access **App Manager** (Admin if creating the certificate is refused). Download the `.p8` (only
      once) and note the Key ID and Issuer ID.
- [ ] Make a private key for the distribution certificate:
      `ssh-keygen -t rsa -b 2048 -m PEM -f ios_dist_cert_key -q -N ""`
- [ ] GitHub → repository Settings → Secrets and variables → Actions: variables `APPSTORE_ISSUER_ID`,
      `APPSTORE_API_KEY_ID` (and optionally `IOS_BUILD_NUMBER_OFFSET`), secrets
      `APPSTORE_API_PRIVATE_KEY` (the `.p8` file's contents) and `IOS_DIST_CERT_PRIVATE_KEY` (the
      contents of `ios_dist_cert_key`).
- If you also upload from Xcode, keep the build numbers apart: set `IOS_BUILD_NUMBER_OFFSET` above the
  highest number you used in Xcode.

**Then**

- [ ] Wait for the build to finish processing (5–30 minutes; Apple emails you).
- [ ] TestFlight → Internal Testing → create a group, add yourself, and install the **TestFlight** app on
      your iPhone. Internal testers (up to 100 people on your team) need no review.
- [ ] Optional: External Testing (needs a short beta review, usually about a day).

Separately, `.github/workflows/ios-build.yml` builds the app without signing on every push that touches
the app, so a Swift or Xcode project error shows up in the pull request before you archive.

## 9. App Privacy

- [ ] App Store Connect → your app → **App Privacy** → Get Started → "Do you or your third-party partners
      collect data from this app?" → **No** → the label reads **Data Not Collected**. This is accurate:
      Apple defines "collect" as sending data off the device, and the app sends nothing (StoreKit runs
      through iOS, and there is no analytics or crash SDK).
- [ ] **Privacy Policy URL**: `https://atg-y2k.github.io/chess/privacy.html`. Fill in its placeholders
      first (`chesscoach-support@example.com`, `[YOUR LEGAL NAME]`) and check that the page is live
      (it is published by the web app's `deploy.yml` from `main`).
- [ ] Keep it that way: adding analytics, a crash reporter or a purchase backend (such as RevenueCat)
      would change the label and the policy.

## 10. Age rating

- [ ] App Information → Age Rating → Edit. Apple's 2025–26 questionnaire (answers mandatory since
      2026-01-31) adds 13+, 16+ and 18+ bands and questions about in-app controls, capabilities,
      wellness and AI. For this app the answers are all **None / No**:
  - no violence, mature themes, gambling, contests, horror, medical or sexual content;
  - no user-generated content, messaging or chat;
  - no unrestricted web access (links open Safari, which doesn't count as an in-app browser);
  - no advertising;
  - no generative AI: the coach's text is written by rules from the engine's analysis.
- [ ] The result should be **4+**. Don't choose the Kids category (stricter rules).

## 11. Export compliance

Nothing to do: `ios/App/App/Info.plist` sets `ITSAppUsesNonExemptEncryption` to `NO`, because the app
uses no encryption of its own. App Store Connect then skips the encryption questions for every build.

## 12. Screenshots

App Store Connect requires iPhone **6.9-inch** screenshots: 1320 × 2868 pixels (1290 × 2796 or
1260 × 2736 also work), portrait, PNG or JPEG, **no transparency**, 1 to 10 of them. The first three
show in search results. They must show the app in use. iPad screenshots are not needed (iPhone only).

**With the script** (renders the real app in Chromium at 440 × 956 points × 3):

```sh
npx playwright install chromium            # once, on your Mac
node scripts/appstore-screenshots.mjs      # writes appstore/screenshots/01-…05-….png and iap-review/paywall.png
```

It builds the App Store web app with the mock store into `node_modules/.cache` (never into
`dist-native/`), serves it on `127.0.0.1:5640`, plays fixed positions with the real engine and saves
the product-page screenshots `01-new-game` (bot picker), `02-coach` (a blunder explained, with the
evaluation bar), `03-hint` (arrows and the reason), `04-review` (accuracy and move counts) and
`05-openings` (the Openings section: the Italian Game's main line stepped through on its board, with
the move's note). `02`, `03` and `05` show Pro features (the move's note in `05` is an opening guide),
so they carry a "Pro · in-app purchase" tag. It also saves
`iap-review/paywall.png`, the paywall with its price: that one is **only** the in-app purchase's App
Review screenshot (section 6), not a product-page screenshot. Options: `--only=coach,hint`,
`--theme=light`, `--no-status-bar` (it draws a "9:41" status bar by default), `--skip-build`,
`--port=`, `--out=`. Run it on your Mac so the text uses Apple's system font. The
`appstore/screenshots/` folder ignores its own contents in git.

**Or from the Simulator** (the real app in WKWebView): run the app on an **iPhone 17 Pro Max**
simulator (6.9-inch), give it a clean status bar with
`xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3`,
and press ⌘S in the Simulator to save a 1320 × 2868 screenshot. Screenshots taken on a Pro Max iPhone
(side button + volume up) work too.

Captions or device frames around the screenshots are allowed, but prices don't belong in screenshots.

- [ ] Every screenshot that shows a Pro feature (coach explanations, Hint, Show best, the explorer,
      best-move arrows, Game Review's key moments, opening guides and drills) says that it needs the in-app purchase, e.g. the script's tag or a
      caption (Guideline 2.3.2). Simulator screenshots need the same label.
- [ ] No prices in product-page screenshots (Guideline 2.3.7): upload 01–05, not the paywall.

## 13. Name and other metadata

**Name** (2–30 characters, unique on the App Store). Candidates the research checked on 2026-10-02
(US App Store, iTunes Search API):

| Candidate | Result | Length |
|---|---|---|
| **Pawnwise: Chess Coach** | no app with "Pawnwise" | 21 |
| **Rookwise: Offline Chess Coach** | no app with "Rookwise" | 29 |
| **Checkmate Coach: Learn Chess** | no app with "Checkmate Coach" | 28 |
| **Blunder Coach: Chess Trainer** | no app with "Blunder Coach" | 28 |
| Kingside Coach | no match | 14 |
| ~~Chess Sensei~~, ~~Knightly Chess~~ | taken (2026) | |
| ~~Chess Mentor~~ | taken, and a chess.com product name | |

Before you commit to one, also search Google Play, the USPTO trademark database
(<https://tmsearch.uspto.gov>) and domain names, then create the app record to reserve it (section 5).
The Home Screen name (`APP_NAME`) can be the short brand, e.g. "Pawnwise".

**Don't use** "chess.com", "Lichess", "Stockfish", "Chessable", "Magnus" or "Game Review" in the name,
subtitle or keywords (Guidelines 2.3.7, 4.1(c), 5.2.1). Saying "Powered by the open-source Stockfish
engine" in the description is fine: it is factual attribution, and the GPL wants the credit.

#### Renaming the app

Change `APP_NAME` in `capacitor.config.ts` and run `npm run build:native` (it updates the iOS display
name; the About section and "<name> Pro" follow it). These still say "Chess Coach" and need editing by
hand: `index.html` (`<title>` and `apple-mobile-web-app-title`), the web manifest in `vite.config.ts`
(`name`, `short_name`), `src/App.tsx` (the start screen and the PGN share title), `src/game/pgn.ts`
(the PGN Event and Site tags), `public/privacy.html`, `public/terms.html`, `public/support.html`,
`docs/EULA-draft.md`, the Pro display name in App Store Connect and `ios/App/App/Products.storekit`.

**The other fields**

- [ ] **Subtitle** (≤ 30 characters, no prices, no other apps): e.g. `Play bots, learn every move` (27).
- [ ] **Keywords** (≤ 100 bytes, comma-separated, no spaces needed, don't repeat words from the name):
      e.g. `offline,engine,analysis,blunder,elo,rating,bot,computer,trainer,learn,board,opening,tactics,practice`
      (100 bytes). Add `chess` (drop `practice`) if the name doesn't contain it.
- [ ] **Promotional text** (≤ 170 characters, can change any time without review): e.g. "One purchase,
      yours forever: no subscription, no account, no ads. Everything runs on your iPhone, even in
      airplane mode."
- [ ] **Description** (≤ 4,000 characters). A draft:

```text
Play chess against the computer at any level, from complete beginner to grandmaster strength, and learn from every move with a coach that explains it in plain English. Everything runs on your iPhone: no account, no ads, no tracking, and it works in airplane mode.

PLAY
• 16 computer opponents from 100 to 3200 Elo, a custom strength slider, and "Match my rating"
• Your own rating, with your stats and recent games
• Takebacks, board flip and PGN export

SEE WHO'S WINNING
• A live evaluation bar and a graph of the whole game
• Every move rated: Best, Excellent, Good, Inaccuracy, Mistake, Blunder
• Rate the computer's moves too, to see whether it found the best move
• Accuracy for both players after the game

LEARN OPENINGS
• 3,800 named opening lines in 141 openings, with "Start here" picks for beginners, easiest first
• Search by name, code or moves, and explore the well-known moves one by one
• Step through any line on a board, with the opening's name at every move
• Play an opening against the computer: it follows the line while you learn it

LEARN MORE WITH PRO (one-time purchase)
• The coach explains every move: what it wins or loses, the tactic you missed, the threat you allowed, and what was better
• Hints with the idea behind the best move
• Show best: the move you should have played, and why
• The explorer: try moves for both sides before you play them, with the engine's verdict
• Best-move arrows while you play
• A full review of every game, with its key moments and a comment on every move
• Opening lessons and drills: why every move of an opening is played, the plans and traps, and drills with your progress saved
Pro is a single in-app purchase, not a subscription, and Family Sharing shares it with your family.

PRIVATE AND OFFLINE
Your games and your rating never leave your iPhone. The app collects no data.

OPEN SOURCE
Powered by the open-source Stockfish chess engine. Chess Coach is free software under the GNU General Public License v3; the source code of every version is at https://github.com/atg-y2k/chess
```

- [ ] **Support URL**: `https://atg-y2k.github.io/chess/support.html` (Apple wants real contact details
      there: replace the placeholder email; add a postal address if your local law requires one).
- [ ] **Privacy Policy URL**: section 9.
- [ ] **Copyright**: e.g. `2026 Your Name` (or your company).
- [ ] **Category**: primary **Games**, subcategory **Board**; secondary **Education**.
- [ ] **License Agreement** (App Information): replace Apple's standard EULA with the custom one from
      `docs/EULA-draft.md`, after a lawyer has reviewed it (section 15).

## 14. App Review notes

App Store Connect → the version → App Review Information: your contact details, "Sign-in required"
**off**, and notes. A draft (replace X.Y.Z):

```text
Chess Coach is a chess trainer that runs entirely on the device. The Stockfish chess engine (open source, GPL) is bundled in the app, so it works offline and needs no account or sign-in. There is no server.

FREE: all 16 computer opponents (100-3200 Elo), the player's rating, the evaluation bar and graph, the rating of every move (Best, Mistake, Blunder...), also of the computer's moves with the "Rate opponent's moves" option, and accuracy after the game. The Openings section (Menu > Openings, or "Learn openings" on the New game sheet): browsing and searching 3,800 named opening lines, exploring them move by move, stepping through any line on a board, and playing an opening against the computer.

PRO is one non-consumable in-app purchase (io.github.atgy2k.chesscoach.pro, Family Sharing on). It unlocks the coach's explanations of each move, Hint, Show best, the explorer (trying moves before playing them, with the engine's evaluation and ratings), best-move arrows, the key moments and per-move comments of the post-game review, and in the Openings section the opening guides (the "why" of each move, the plans, traps and key variations) and the opening drills with saved progress.

WHERE TO FIND THE PURCHASE: tap Play on the New game sheet and make any move. The coach panel under the board rates the move and shows "Unlock to see why", which opens the purchase screen. The purchase screen also opens from the Hint and Explore buttons, from Menu > Chess Coach Pro > Unlock, and in the Openings section (Menu > Openings, then any opening under "Start here") from the guide's "Unlock" button and from "Drill it". Restore Purchases is in the Menu and on the purchase screen.

OPEN SOURCE: the app is free software under the GNU GPL v3 or later. Menu > About links to the exact source code of this build (https://github.com/atg-y2k/chess/tree/ios-vX.Y.Z-bN) and shows the licenses, the Privacy Policy, the Terms of Use and Support. Our custom EULA states that the GPL governs the software.

DIAGNOSTICS: Menu > Engine > Run engine self-test runs the chess engine and shows PASS or FAIL.
```

## 15. Licensing (GPL): every release

The app stays **GPL-3.0-or-later**, as it must: chessground (the board) is linked into the app and
Stockfish ships with it, both GPL-3.0. Selling GPL software is allowed (GPLv3 section 4: "You may charge
any price or no price"), and Stockfish's own terms allow selling it "by itself or as part of some bigger
software package", as long as the full source, or a pointer to it, comes with every copy.

**For every App Store release:**

- [ ] Set `version` in `package.json`, run `npm run build:native`, commit and push.
- [ ] **Every uploaded build links to its exact source.** The App Store build's About section (and its
      `THIRD-PARTY-LICENSES.txt`) points at the commit it was built from. The release workflow tags
      that commit `ios-v<version>-b<build number>` before it builds, and builds with
      `npm run build:native:release`, which refuses uncommitted changes. For an upload from Xcode,
      do the same by hand (section 8A). **Never delete or move these tags**: they keep each build's
      source reachable.
- [ ] Tag the build you release as `v<version>` too, e.g. `git tag v1.0.0 && git push origin v1.0.0`
      (pushing it starts the release workflow, which refuses a tag that doesn't match `package.json`).
      It is the human-friendly name; the app itself links to the `ios-v…` tag or the commit. GitHub
      serves a source archive for every tag; attaching your own (`npm run build:source`) to a GitHub
      release is optional.
- [ ] **Resubmitting after a rejection** (or a TestFlight fix) under the same version: commit the fix,
      then run the workflow by hand (Actions → iOS release → Run workflow) or archive from Xcode as in
      section 8A. The new build gets its own `ios-v<version>-b<build>` tag, so its source link is right
      even though `v<version>` already exists (it may then name the rejected build; that is harmless,
      and tags are never moved). Or bump the version instead, and edit it on the App Store Connect
      version page, which stays editable until approval.
- [ ] Keep the notices: the GPL text, credits, `THIRD-PARTY-LICENSES.txt` and the engine's license in
      the app (About already shows them), and the source link in the store description.
- [ ] Add no restrictions on GPL rights: no terms forbidding copying or modification, no obfuscation
      that hides where the code comes from.

**Once:**

- [ ] A **custom EULA** that defers to the GPL (`docs/EULA-draft.md`). Apple's Standard EULA forbids
      "transfer, redistribute or sublicense", which clashes with the GPL. **Have a lawyer review the
      draft** before you paste it into App Store Connect. Note that `public/terms.html` is already
      published by `deploy.yml` as soon as this branch reaches `main`; it shows a visible "Draft"
      notice until you remove it (`npm run check:legal` lists it with the other placeholders).
- [ ] Optional: a `TRADEMARKS.md` declining trademark rights in the app's name and icon (GPLv3 section
      7(e)), with a pointer to it in the README and in `public/icon-source.svg`, so forks must rename.
      The EULA today only says that the GPL, a copyright license, grants no trademark rights; if you
      add `TRADEMARKS.md`, the EULA may refer to it. Your brand is what you control: anyone may legally
      publish their own build of the source, free or paid.
- [ ] Don't merge outside contributions without a contributor agreement if you want to keep the
      option to relicense your own code later.

**The known risk.** The FSF's position (2010) is that the App Store's terms add restrictions the GPL
forbids; VLC was pulled in January 2011 after one of its own copyright holders complained. In practice
GPL chess apps are on the App Store: the official Lichess app (GPL-3.0, ships chessground and
Stockfish), Tord Romstad's Stockfish app, and SmallFish ($4.99, built on Stockfish and listed as the
"Recommended iOS App" on stockfishchess.org). Apple removes an app only when a copyright holder
complains, so full compliance and visible credit are the protection. The Stockfish project sued
ChessBase in 2021 over concealed origin and missing source, not over charging money.

**For the lawyer:** the custom EULA against Apple's minimum terms and GPL section 10; individual vs
LLC; and how much of this codebase is copyrightable (most of it was written with an AI assistant, and
the U.S. Copyright Office's January 2025 report requires human authorship). See also
`ios/README-native.md` → Releasing.

## 16. The free web version (your decision)

The same app is free and fully unlocked at <https://atg-y2k.github.io/chess/> (the web build has no
paywall). Choose one:

| Option | For | Against |
|---|---|---|
| **Keep it free and complete** (as now) | Nothing to do; open-source goodwill; a way to try the app on any device | People can skip the purchase; App Review may compare the app with an identical free website (Guideline 4.2, "repackaged website") |
| **Turn it into a demo** | Free taste of the app, with a link to the App Store | Needs code: the web build has no purchase flow, so Pro features would have to be locked there, with a link to the store instead of a Buy button |
| **Stop hosting it** | No competition with the paid app; a simpler 4.2 story | Existing Home Screen installs keep working offline but get no updates |

The GPL requires the source for copies you distribute (the repository stays public); it does not require
hosting a free copy. **Whatever you choose, keep the three pages online**: `privacy.html`, `terms.html`
and `support.html` are App Store requirements, the paywall links to them, and today `deploy.yml`
publishes them together with the web app. If you stop hosting the app, deploy only those pages (or host
them elsewhere and update `LEGAL_URLS` in `src/native/platform.ts` and the URLs in App Store Connect).

## 17. Things the research flagged

- [ ] **Move badges**: `src/ui/ClassIcon.tsx` draws badges much like chess.com's (e.g. a teal "!!" for
      Brilliant). The words are generic chess terms, but give the icons your own shapes and colors
      before launch to avoid a trade-dress complaint.
- [ ] **"Game Review"** is chess.com's feature name. Consider another label in the app (e.g. "Game
      Analysis" or "Coach Review"), and keep it out of the name, subtitle and keywords either way.
- [ ] **Ratings**: keep saying they are engine-scale ratings, not chess.com or FIDE ratings.
- [ ] **Web-isms** (Guideline 4.2): the app must feel like an app. The native build already has no
      service worker, no install instructions, native share, haptics, status bar and launch screen,
      and no "Available offline" row in the Menu (that is web app only).
- [ ] **VoiceOver labels** on the main controls.
- [ ] Credit kept for the cburnett pieces (in About) and for Stockfish.
- [ ] **Audio**: if, on a device, sounds ignore the silent switch or stop music, set the audio session to
      ambient in `AppDelegate.swift` (`AVAudioSession.sharedInstance().setCategory(.ambient,
      options: [.mixWithOthers])`).

## 18. Submit

- [ ] Fill in placeholders everywhere: `chesscoach-support@example.com`, `[YOUR LEGAL NAME]`,
      `[YOUR POSTAL ADDRESS]` and `[GOVERNING LAW]` in `public/*.html` and `docs/EULA-draft.md`, and
      remove the pages' "Draft" notices once the lawyer has signed off. `npm run check:legal` must
      print nothing (the release workflow runs it, and fails on a `v*` tag otherwise). Deploy the web
      site so the pages are live.
- [ ] **License Agreement**: App Store Connect → App Information → License Agreement → paste the
      custom EULA (same text as `public/terms.html`). Without it the app ships under Apple's Standard
      EULA, which the GPL clashes with (section 15), and the app's "Terms of Use" link would point at
      terms that are not in force.
- [ ] On the version page (1.0): upload the screenshots 01–04 (not the paywall, which is only the
      in-app purchase's review screenshot), fill in the metadata, choose the **build**, select **Pro**
      under In-App Purchases and Subscriptions, add the review notes.
- [ ] Version Release: **Manually release this version**, so you choose launch day.
- [ ] **Add for Review**, then **Submit for Review**. Apple reviews 90% of submissions within 24 hours.
- [ ] If it is rejected, answer in App Store Connect with a concrete list of changes. Budget one or two
      rounds. You can appeal once per rejection to the App Review Board.

## 19. After launch

- [ ] Answer reviews; watch App Store Connect → Analytics (product page views → downloads, purchases).
- [ ] Every release: version bump, tag, TestFlight, submit (sections 8, 15, 18).
- [ ] Renew the membership every year ($99), or the app leaves the store.
- [ ] Each spring Apple raises the required Xcode/SDK; the CI workflows use the newest stable Xcode.
- [ ] Accept updated agreements in App Store Connect when asked (new apps and purchases are blocked
      until you do).
- [ ] Ideas for later: Game Center, a widget, an iPad layout, a native Stockfish for faster analysis.

## Sources (research of 2026-10-02)

- Apple: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (2.1, 2.3.2, 2.3.7,
  2.5.2, 3.1.1, 4.1, 4.2, 4.3, 5.1, 5.2); [enrollment](https://developer.apple.com/programs/enroll/);
  [D-U-N-S](https://developer.apple.com/help/account/membership/D-U-N-S/);
  [Small Business Program](https://developer.apple.com/app-store/small-business-program/);
  [DSA trader requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/)
  and [the 2025-02-17 removals](https://developer.apple.com/news/?id=einwn76m);
  [App privacy details](https://developer.apple.com/app-store/app-privacy-details/);
  [export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/);
  [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/);
  [in-app purchase fields](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-information);
  [Family Sharing for in-app purchases](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/turn-on-family-sharing-for-in-app-purchases);
  [submitting the first in-app purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase);
  [SDK minimums](https://developer.apple.com/news/upcoming-requirements/);
  [offer codes for non-consumables](https://developer.apple.com/news/?id=gf6mgrs6);
  [Custom EULA minimum terms](https://www.apple.com/legal/internet-services/itunes/dev/minterms/);
  [Standard EULA](https://www.apple.com/legal/internet-services/itunes/dev/stdeula/).
- Age rating changes: [9to5Mac, 2025-07-24](https://9to5mac.com/2025/07/24/apple-notifies-developers-of-new-app-store-age-rating-system/).
- China game approval numbers: [Game Developer](https://www.gamedeveloper.com/game-platforms/8-000-games-have-been-pulled-from-the-app-store-in-china-over-missing-isbns).
- GPL and the App Store: [FSF, 2010-05-25](https://www.fsf.org/news/2010-05-app-store-compliance);
  [VLC removed, Engadget 2011-01-08](https://www.engadget.com/2011-01-08-vlc-app-removed-from-app-store.html);
  [Stockfish terms of use](https://github.com/official-stockfish/Stockfish#terms-of-use);
  [Stockfish vs ChessBase, 2021](https://stockfishchess.org/blog/2021/our-lawsuit-against-chessbase/);
  [Lichess mobile (GPL-3.0)](https://github.com/lichess-org/mobile);
  [U.S. Copyright Office, AI report part 2 (2025-01-29)](https://copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf).
- GitHub-hosted runners (`macos-26`, free for public repositories):
  [docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- Signing and upload tools: [codemagic-cli-tools](https://github.com/codemagic-ci-cd/cli-tools) (GPL-3.0).
