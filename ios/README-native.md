<!--
  FOR WHOEVER CHANGES THE NATIVE (SWIFT) SIDE NEXT, e.g. the StoreKit plugin. Checked against
  Capacitor 8.5.2's generated project:

  1. The App target does NOT use a file-system-synchronized group. project.pbxproj has
     objectVersion = 60 and classic explicit references: no PBXFileSystemSynchronizedRootGroup
     (that is Xcode 16's objectVersion 77 format). A new .swift file in ios/App/App/ is NOT compiled
     until the project lists it. Add four entries by hand (24-digit uppercase hex IDs, unique in the
     file), as was done for App/PrivacyInfo.xcprivacy (grep for 5C0FFEE1 to see the pattern):
       - PBXBuildFile:      <B> /* Foo.swift in Sources */ = {isa = PBXBuildFile; fileRef = <F> /* Foo.swift */; };
       - PBXFileReference:  <F> /* Foo.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Foo.swift; sourceTree = "<group>"; };
       - the "App" PBXGroup 504EC3061FED79650016851F, children:  <F> /* Foo.swift */,
       - the Sources phase 504EC3001FED79650016851F, files:  <B> /* Foo.swift in Sources */,
       (Resources such as a .storekit file go in the Resources phase 504EC3021FED79650016851F instead.)
     Check that it still parses on Linux with the `xcode` package that @capacitor/cli installs:
       node -e "const p=require('xcode').project('ios/App/App.xcodeproj/project.pbxproj');p.parseSync();console.log(p.hash.project.objects.PBXSourcesBuildPhase)"
     The App target is 504EC3031FED79650016851F; the shared scheme is
     App.xcodeproj/xcshareddata/xcschemes/App.xcscheme (its LaunchAction is where a StoreKit
     configuration file for local testing would be referenced).

  2. The main view controller is created in code, not by the storyboard. SceneDelegate.swift
     (UIScene life cycle; AppDelegate.swift is @UIApplicationMain and returns SceneDelegate as the
     scene delegate class) does:
         window = UIWindow(windowScene: windowScene)
         window?.rootViewController = MainViewController()
     Main.storyboard still exists and is still named in Info.plist (UIMainStoryboardFile and the
     scene manifest's UISceneStoryboardFile). Its initial view controller is
         customClass="MainViewController" customModule="App" customModuleProvider="target"
     but SceneDelegate replaces that window at launch, so that instance never loads a web view.
     MainViewController (a CAPBridgeViewController) registers the app-local plugins in
     `capacitorDidLoad()`: add another one there with `bridge?.registerPluginInstance(MyPlugin())`
     (StorePlugin.swift is a worked example).
     On the JS side, get @capacitor/core through `nativePlugins.core()` (src/native/platform.ts) for
     `registerPlugin`, so the web build stays free of Capacitor code.
-->

# Chess Coach for iOS (Capacitor)

The App Store app is the same web app, built with `VITE_NATIVE=1` and wrapped by
[Capacitor 8](https://capacitorjs.com/) (MIT). Its files ship inside the app and are served from
`capacitor://localhost/`, so it works offline from the first launch and only updates through the App
Store: there is no service worker, no update logic and no web app manifest. Capacitor 8 uses Swift
Package Manager (no CocoaPods, no `pod install`). The app is GPL-3.0-or-later like the rest of the
repository.

## Where each setting lives

| Setting | The one place to change it |
|---|---|
| Bundle ID (`io.github.atgy2k.chesscoach`) | `APP_ID` in `capacitor.config.ts`. `npm run build:native` writes it into `PRODUCT_BUNDLE_IDENTIFIER` in `App/App.xcodeproj/project.pbxproj`. It must match App Store Connect and can't change after release. |
| Home Screen name (`Chess Coach`) | `APP_NAME` in `capacitor.config.ts`. `npm run build:native` writes it into `CFBundleDisplayName` in `App/App/Info.plist`; the About section shows it too. |
| Version | `version` in `package.json`. `npm run build:native` writes it into `MARKETING_VERSION`; About shows it. |
| Build number | `CURRENT_PROJECT_VERSION` in `project.pbxproj` (1). It must go up with every upload; a CI workflow can set it, e.g. to the run number. |
| Minimum iOS (16.4, for WebAssembly SIMD) | `IPHONEOS_DEPLOYMENT_TARGET` in `project.pbxproj` (all four entries). Keep it a plain number: `cap sync` reads the first one to write `.iOS(.v16)` into `App/CapApp-SPM/Package.swift`. |
| iPhone only | `TARGETED_DEVICE_FAMILY = 1` in `project.pbxproj` (`"1,2"` adds iPad, which then needs iPad screenshots). |
| Orientations (portrait on a regular iPhone, every way on the iPhone Duo) | `UISupportedInterfaceOrientations` in `Info.plist` and `supportedInterfaceOrientations` in `App/App/MainViewController.swift`; see [Orientations, multitasking and the iPhone Duo](#orientations-multitasking-and-the-iphone-duo). |
| Pro in-app purchase ID | `src/native/purchases.ts`. |
| Background color (`#1d1c1a`) | `capacitor.config.ts` (web view, launch screen plugin) and `App/App/Base.lproj/LaunchScreen.storyboard`. |

Other `Info.plist` choices: `ITSAppUsesNonExemptEncryption = NO` (skips the export compliance
question on each upload), `UIRequiredDeviceCapabilities = arm64`, `UIStatusBarStyle` light content
with `UIViewControllerBasedStatusBarAppearance = YES` (what @capacitor/status-bar needs), and no
permission (`NS…UsageDescription`) keys, since the app uses none. `App/App/PrivacyInfo.xcprivacy`
declares the one required-reason API the app uses: UserDefaults (`CA92.1`), through
@capacitor/preferences.

## Orientations, multitasking and the iPhone Duo

On the iPhone Duo the app turns with the device, like the web app: its layout follows the window
(portrait, landscape, the Duo's displays, Split View; see `src/App.css` and `src/layout/fold.ts`). On
every other iPhone it stays in portrait, as it always has.

- `UISupportedInterfaceOrientations`: all four. iOS has no per-model key (the Duo reads the iPhone
  one), and iPad-style multitasking (Split View, Slide Over, resizable windows) wants all four
  orientations, a launch storyboard (`UILaunchStoryboardName`, `LaunchScreen.storyboard`) and no
  `UIRequiresFullScreen` (deprecated since iOS 26; leave it out). The same key serves iPad if it is
  ever added (`TARGETED_DEVICE_FAMILY = 1` today). iPhones with Face ID never turn upside down anyway.
- `MainViewController.supportedInterfaceOrientations` narrows that per screen: a tall phone screen
  (the long side more than 1.6 times the short one: every iPhone but the Duo, whose displays are about
  1.4) gets portrait only; the Duo's displays get all four. It asks again when the window first shows
  and after every size change (`setNeedsUpdateOfSupportedInterfaceOrientations`), so folding or
  unfolding, which moves the app to the other display, picks the right set. A launch with a regular
  iPhone held sideways may show the launch screen in landscape for a moment before the app turns
  upright.
- `UIApplicationSupportsMultipleScenes` stays `false`: one window. Two windows of the app side by
  side would be two web views sharing one localStorage, each saving its own game over the other's.
  The app still sits beside another app in Split View: that needs no extra scene.
- `vite.config.ts` (`nativeProjectSettings`) only rewrites the bundle ID, the version and the
  display name; it never touches these keys.
- The launch screen is the app's mark on `#1d1c1a`, "aspect fill", so it covers any screen in any
  orientation; in landscape the mark sits slightly higher than the app's own start screen shows it.
- The status bar: iOS hides it on an iPhone in landscape. The web view runs under it either way
  (`overlaysWebView`), and the CSS pads the app with the safe areas, which in landscape are along
  the sides (the Dynamic Island) and the bottom. On the Duo's open inner display it runs down the
  right edge; the App Store app sets its text color with the theme (`src/native/statusbar.ts`), and
  the installed web app paints a dark band down that side in the light theme (`src/styles/app.css`).

**The iPhone Duo** (announced on September 9, 2026; iOS 27.1). Its open inner display (7.6", 2670 ×
1878 px) has the status bar, a vertical Dynamic Island and the Dock along its right edge, a fold down
its middle, and iPad-style Split View; the outer display is 5.4" (1398 × 2034 px). What Apple had not
published when this was written, and so is not verified: the displays' sizes in points and their
scale factor, the safe-area insets in each posture, whether WKWebView reports the fold (the Viewport
Segments API, `window.viewport.segments`, and the Device Posture API: WebKit had shipped neither as
of mid-2026), whether its user agent says iPhone or, like iPadOS, Mac, and whether iPhone apps get
Split View on it as they are or need iPad-style multitasking (all four orientations, which the app
lists). The app recognizes the inner display by its size when nothing reports the fold. Without a
reported posture, half folded (tabletop) needs the Menu's "Keep the board off the fold": Automatic
can't tell it from flat. One blind spot: should the Duo turn out to be @2x (about 1335 × 939 points)
and send the Mac user agent, its inner display looks like an iPad, so Automatic leaves it whole (the
setting still splits it).

To check and tune it:

1. Build with the Xcode that has the iOS 27 SDK (the first that knows the iPhone Duo) and run the app
   in its iPhone Duo simulator: open and closed, portrait and landscape, half folded, and in Split
   View beside another app at each width. Check that the app turns on both displays (and stays
   upright on a regular iPhone simulator), that Split View is offered, where the status bar is drawn
   and that it is readable in the light theme, and, in Safari, the same in a tab and installed.
2. In Safari's Web Inspector on the simulator, read `innerWidth`, `innerHeight`, `screen.width`,
   `screen.height`, `devicePixelRatio`, `navigator.userAgent`, `navigator.maxTouchPoints`,
   `window.viewport?.segments`, `navigator.devicePosture`, `matchMedia('(device-posture: folded)')`
   and the safe areas (`getComputedStyle(document.getElementById('app'))`'s padding) in each state.
3. Put what you find where it is used: the `FOLD` estimates in `src/layout/fold.ts` (the inner
   display's smallest short side and largest aspect ratio, the clearance kept around the fold, the
   share of the height a Safari tab keeps; the 1.6 ratio is also in `MainViewController.swift`), the
   window-shape thresholds of the Duo's whole-screen layouts in `src/App.css` (short, wide portrait;
   big portrait; squat landscape: the media queries next to "the iPhone Duo's outer display" and "its
   inner display upright"), the test viewports at the top of `e2e/foldable.spec.ts`, and, for the web
   app's launch images, the displays' sizes in `SPLASH_SCREENS` in `vite.config.ts`, with their
   images made by `node scripts/make-splash.mjs --size=<width>x<height>` (device pixels; add
   `--scale=0.667` at @2x).

## Build and run on a Mac

Needs Xcode 26 or later (App Store uploads must use the iOS 26 SDK) and Node 22.18 or later.
Capacitor's CLI loads `capacitor.config.ts` with Node's built-in TypeScript support, because
TypeScript 7 no longer has the JavaScript compiler API it used before.

```sh
npm ci
npm run build:native   # tsc, then VITE_NATIVE=1 vite build into dist-native/
npm run cap:sync       # copies dist-native/ into App/App/public and updates Package.swift
npm run ios:open       # opens App/App.xcodeproj in Xcode
```

In Xcode, pick your team under the App target's Signing & Capabilities (automatic signing), then run
on a device or a simulator. Run `build:native` and `cap:sync` again after every change to the web
app. Debug builds can be inspected with Safari's Web Inspector (Develop menu); Release builds can't.
The engine self-test also works in the app: Menu, then Run engine self-test.

## What the native build does differently

- `vite.config.ts`: base `/`, no vite-plugin-pwa (no `sw.js`, no manifest), no Safari launch
  images, no source maps, and the web-only files (`splash/`, `pwa-*.png`, `maskable-*.png`,
  `icon-source.svg`) are dropped from `dist-native/`. THIRD-PARTY-LICENSES.txt lists Capacitor's
  native code (MIT, with Apache-2.0 code from Apache Cordova) instead of Workbox.
- `src/native/`: `platform.ts` (`nativeBuild`, `isNative`, `paywallEnabled`, and `nativePlugins`, the
  only place that imports Capacitor, so the web build contains none of it), `storage.ts`
  (localStorage backup in Preferences, restored at startup if iOS cleared it), `haptics.ts` (a haptic
  with every game sound, while Sound is on), `share.ts` (`navigator.share` opens the iOS share sheet,
  so PGN export works unchanged), `statusbar.ts` (status bar follows the theme; the launch screen is
  hidden once the app has rendered).
- Links: Capacitor 8 sends any link to another site (`target="_blank"` or not) to Safari
  (`WebViewDelegationHandler`: `UIApplication.shared.open`), so plain `<a target="_blank">` links
  work. A new-window link to one of the app's own files would do nothing (no app opens
  `capacitor://` URLs), so About shows the license texts in an in-app viewer instead.

## Files in ios/

Committed: the Xcode project (`App/App.xcodeproj`, including the shared scheme), `App/App/` (Swift
sources, `Info.plist`, storyboards, `Assets.xcassets`, `PrivacyInfo.xcprivacy`), `App/CapApp-SPM/`
(the local package that lists the plugins; `cap sync` rewrites its `Package.swift`), `debug.xcconfig`
and `tools/`. Commit `Package.resolved` too once Xcode creates it, so every build resolves the same
capacitor-swift-pm.

Generated by `npx cap sync ios` and ignored (see `.gitignore`): `App/App/public/` (the web app),
`App/App/capacitor.config.json`, `App/App/config.xml` and `capacitor-cordova-ios-plugins/`, plus build
products. The plugins' Swift packages are referenced from `node_modules/`, so run `npm ci` before
building.

## App icon and launch screen

`App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` is the single 1024 × 1024 opaque
icon (Xcode makes the other sizes); `Splash.imageset` is the launch image: the app's mark on
`#1d1c1a`, placed where the app's own start screen shows its logo. Both are rendered from
`public/icon-source.svg` and `public/favicon.svg`:

```sh
npm install --no-save sharp && node ios/tools/make-assets.mjs
```

## Releasing (GPL)

Every App Store build must have its exact source published. The native build links About (and
`THIRD-PARTY-LICENSES.txt`) to the commit it is built from, `https://github.com/atg-y2k/chess/tree/<commit>`
(`VITE_SOURCE_URL` overrides it). So build what you upload with `npm run build:native:release`: it
fails on uncommitted changes (plain `npm run build:native` only warns). Push that commit and tag it
`ios-v<version>-b<build number>`; the release workflow (`.github/workflows/ios-release.yml`) does all of
this itself and passes the tag as the source link. Tag the released version `v<version>` as well.
Never delete or move these tags. Details: `docs/APP_STORE.md` sections 8 and 15.

## What was checked on Linux, and what needs a Mac

Checked on Linux: `npx cap add ios` and `npx cap sync ios` succeed; the project file parses (with the
`xcode` package); `Info.plist` and the privacy manifest are valid property lists; the icon and splash
have no alpha channel; and `dist-native/`, served by `vite preview`, boots in Chromium (iPhone 15 Pro
emulation) without a service worker and passes the engine self-test.

Needs a Mac or a device: building and archiving (`xcodebuild`, signing), Swift Package resolution,
the shared scheme, and everything at run time in WKWebView: the workers and WebAssembly under
`capacitor://`, the launch screen hand-over (also in landscape), the status bar, haptics, the share
sheet, the Preferences backup, audio with the silent switch, safe areas, rotation, memory with two
engines, and the iPhone Duo (see above).

## In-app purchase (Pro, StoreKit 2)

The App Store app is a free download with one non-consumable in-app purchase, Pro, with Family
Sharing on. Its product ID, `io.github.atgy2k.chesscoach.pro`, is `PRO_PRODUCT_ID` in
`src/native/purchases.ts`. It must match the in-app purchase in App Store Connect and
`App/App/Products.storekit`. There is no server: StoreKit 2 verifies every transaction on the
device, and the entitlement check works offline.

| File | What it does |
|---|---|
| `App/App/StorePlugin.swift` | The app's own Capacitor plugin, `Store`: `getProduct`, `isUnlocked`, `purchase`, `restore` (each takes `{productId}`), and the `entitlementChanged` event `{productId, unlocked}`. It listens to `Transaction.updates` from launch, so it sees Ask to Buy approvals, purchases on other devices, refunds and revocations. |
| `App/App/MainViewController.swift` | `CAPBridgeViewController` plus `registerPluginInstance(StorePlugin())` in `capacitorDidLoad()`, and the orientations per screen (portrait on a tall phone screen). `SceneDelegate.swift` creates it, and `Main.storyboard` names it too. |
| `App/App/Products.storekit` | A local StoreKit configuration for testing in Xcode: Pro at $9.99, Family Sharing on. It is in the project but not in Copy Bundle Resources, so it is not shipped. |
| `src/native/purchases.ts` | The JavaScript side. `getPurchases()` returns the native store in the app, a mock store in a `VITE_PAYWALL=1` web build, and "always unlocked" in the PWA. Failures come back as results (`restore()` gives `restored`, `none`, `cancelled` or `failed`, so an offline restore is not reported as "nothing to restore"), except that `isUnlocked()` rejects when the plugin is missing or the call fails, so a cached Pro is kept rather than locked. `loadStorePlugin()` logs a `console.error` if the `Store` plugin was not registered. |

### Testing purchases in Xcode (no App Store Connect needed)

The shared `App` scheme already points Run at `Products.storekit`. The scheme file was written by
hand on Linux, so check it once:

1. Open **Product > Scheme > Edit Scheme… > Run > Options**. **StoreKit Configuration** should say
   `Products.storekit`. If it says None, pick `Products.storekit` there; Xcode then saves the path
   it prefers.
2. Run the app on a simulator or a device. Buying uses the sheet from the local file, and nothing
   is charged.
3. **Debug > StoreKit > Manage Transactions…** lists the purchases. From there you can refund one
   (the app locks Pro again through `Transaction.updates`), delete one (to buy again), or approve or
   decline an Ask to Buy request.
4. With `Products.storekit` open in the editor, the **Editor** menu turns on **Ask to Buy** (the
   purchase returns "pending"; approve it in Manage Transactions), **Interrupted Purchases** and
   **Fail Transactions**, and sets errors for each StoreKit call.

The scheme's StoreKit configuration only applies when you run from Xcode. TestFlight and App Store
builds always use the real store (the sandbox, for TestFlight).

### Testing against App Store Connect (sandbox, TestFlight)

1. App Store Connect: the Paid Apps Agreement, with tax and banking, must be active. Create the
   in-app purchase: **Non-Consumable**, product ID as above, price $9.99, Family Sharing **on** (this
   can't be turned off later), a display name and description, and the review screenshot. The first
   in-app purchase must be submitted with an app version.
2. To use the sandbox from Xcode, set the scheme's StoreKit Configuration to **None**. Then sign in
   with a sandbox Apple Account under Settings > Developer (or Settings > App Store) on the device.
   TestFlight builds use the sandbox with your own Apple Account, and nothing is charged.

### Testing the paywall in a browser

Build or serve the web app with `VITE_PAYWALL=1`, for example `VITE_PAYWALL=1 npx vite`. This uses
`MockPurchases`: Pro is the localStorage flag `chesscoach.mockPro`. Tests control it through
`window.__mockStore`:

- **`result`**: what the next purchase returns: `'purchased'` (the default), `'cancelled'`,
  `'pending'` or `'failed'`.
- **`price`**: the price shown (default `'$9.99'`).
- **`available`**: `false` makes the store unavailable, so there is no product.
- **`owned`**: `true` means Restore Purchases finds Pro.
- **`restoreError`**: `'cancelled'` (the player closes the sign-in) or `'failed'` (offline) makes the
  App Store sync of Restore Purchases fail; `null` (the default) lets it work.
- **`delayMs`**: the delay on every call (default 300).
- **`setUnlocked(true | false)`**: simulates an Ask to Buy approval or a refund.
- **`unlocked`**: read-only; whether Pro is unlocked.

Assigning an object to `window.__mockStore`, for example in Playwright's `addInitScript`, merges
these settings in.

### What was checked on Linux, and what needs a Mac

Checked on Linux:

- The project file parses, and the new Swift files are in the Sources phase.
- `Products.storekit` is valid JSON with the same product ID as `purchases.ts`.
- The scheme and storyboard are well-formed XML.
- The plugin's method and event names match `purchases.ts` (`tests/native/purchases.test.ts` checks
  this).
- The PWA bundle contains neither store.

There is no Swift compiler here. The Swift was written against the StoreKit 2 and Capacitor 8.5.2
sources and documentation, but it has not been compiled.

Needs a Mac:

- Compile, and fix any warnings.
- Check that Xcode resolves the scheme's StoreKit Configuration (step 1 above).
- Buy, cancel, Ask to Buy (pending, then approve), refund (Pro locks again), and Restore Purchases,
  first with `Products.storekit` and then in the sandbox. Also Restore in airplane mode (expect
  "Couldn't reach the App Store", not "No earlier purchase"), and closing the sign-in (expect no
  message).
- Check that the purchase sheet appears over the app.
