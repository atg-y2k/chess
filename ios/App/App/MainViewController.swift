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
}
