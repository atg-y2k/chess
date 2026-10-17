import UIKit
import Capacitor

/**
 The app's web view controller: Capacitor's CAPBridgeViewController plus the plugins that are part
 of this app rather than npm packages. (`npx cap sync` lists the npm plugins in
 capacitor.config.json, and Capacitor registers those by itself.)

 SceneDelegate creates it as the window's root view controller; Main.storyboard names it too.
 */
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Called from loadView once the bridge exists and before the web view loads the app, so the
        // plugin's JavaScript interface is injected in time, and its Transaction.updates listener
        // starts at launch, as Apple asks.
        bridge?.registerPluginInstance(StorePlugin())
    }

    /**
     Info.plist lists every orientation (iOS has no per-model key, and the iPhone Duo's nearly square
     displays turn every way, like an iPad's); this narrows it per screen. A tall phone screen (the
     long side more than 1.6 times the short one: every iPhone but the Duo, ≈ 1.4) stays in
     portrait, as the app always has; the Duo's displays get what Info.plist lists. (The web app's
     fold heuristic uses the same ratio: `FOLD.innerMaxAspect` in src/layout/fold.ts.)
     */
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        let listed = super.supportedInterfaceOrientations
        guard let screen = screenBounds() else { return listed }
        let short = min(screen.width, screen.height)
        let long = max(screen.width, screen.height)
        return short > 0 && long / short > 1.6 ? .portrait : listed
    }

    /// The screen the app is on (the window's once it has one; the Duo's two displays differ).
    private func screenBounds() -> CGRect? {
        if let screen = viewIfLoaded?.window?.windowScene?.screen { return screen.bounds }
        return UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first?.bounds
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Now that the window (and so its screen) is known.
        setNeedsUpdateOfSupportedInterfaceOrientations()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // Folding or unfolding the Duo moves the app to the other display: ask again there.
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
    }
}
