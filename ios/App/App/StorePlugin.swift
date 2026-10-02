import Foundation
import UIKit
import Capacitor
import StoreKit

/**
 The app's "Store" plugin: the one-time Pro in-app purchase (a non-consumable with Family Sharing
 on), with StoreKit 2. There is no server and nothing leaves the device: StoreKit 2 checks the App
 Store's signature on each transaction itself (`VerificationResult`), and only verified
 transactions count.

 JavaScript side: src/native/purchases.ts (`registerPlugin('Store')`), which passes the product ID
 (PRO_PRODUCT_ID there) with every call. MainViewController registers the plugin at launch.

 - `getProduct({productId})` -> `{id, title, description, displayPrice}`. Rejects if the App Store
   does not know the product or can't be reached.
 - `isUnlocked({productId})` -> `{unlocked}`: a verified, unrevoked entitlement, bought by this
   Apple ID or shared with it through Family Sharing. Read from StoreKit's on-device cache, so it
   works offline.
 - `purchase({productId})` -> `{result: "purchased" | "cancelled" | "pending" | "failed", error?}`.
   "pending" means waiting for approval (Ask to Buy); the approval arrives as an event.
 - `restore({productId})` -> `{unlocked, error?}`: `AppStore.sync()` (the App Store may ask the
   player to sign in), then the same check as isUnlocked, even if the sync failed.
 - Event `entitlementChanged` `{productId, unlocked}`: sent after each transaction from
   `Transaction.updates` (Ask to Buy approvals, purchases on another device or in the App Store,
   refunds and revocations), once the entitlement has been checked again.

 Threading: Capacitor calls the @objc methods on its background "bridge" queue. Each one starts a
 Task (which runs on the concurrency thread pool, not the main thread) and settles its call exactly
 once from there. `CAPPluginCall.resolve`/`reject` may be called from any thread: the bridge hops to
 the main thread to reach the web view. Only showing the purchase sheet needs the main actor (`buy`).
 */
@objc(StorePlugin)
public class StorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StorePlugin"
    public let jsName = "Store"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProduct", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isUnlocked", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise)
    ]

    /// Listens to `Transaction.updates` for as long as the plugin lives (the app's lifetime).
    private var updatesTask: Task<Void, Never>?

    deinit {
        updatesTask?.cancel()
    }

    /// Called once, when MainViewController registers the plugin at launch.
    override public func load() {
        // Apple: listen to Transaction.updates from launch on, or transactions that happen outside a
        // purchase() call can be missed. Unfinished transactions are delivered here once, right
        // after launch. (A purchase made in this app comes back from purchase(), not from here.)
        updatesTask = Task.detached(priority: .utility) { [weak self] in
            for await update in StoreKit.Transaction.updates {
                await self?.handle(update)
            }
        }
    }

    // MARK: - Plugin methods

    @objc func getProduct(_ call: CAPPluginCall) {
        guard let productId = requiredProductId(call) else { return }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("The App Store has no product \(productId)", "NOT_FOUND")
                    return
                }
                call.resolve([
                    "id": product.id,
                    "title": product.displayName,
                    "description": product.description,
                    "displayPrice": product.displayPrice
                ])
            } catch {
                call.reject("Could not load the product: \(error.localizedDescription)", "UNAVAILABLE", error)
            }
        }
    }

    @objc func isUnlocked(_ call: CAPPluginCall) {
        guard let productId = requiredProductId(call) else { return }
        Task {
            let unlocked = await self.isEntitled(to: productId)
            call.resolve(["unlocked": unlocked])
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = requiredProductId(call) else { return }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.resolve(["result": "failed", "error": "The App Store has no product \(productId)"])
                    return
                }
                let result = try await self.buy(product)
                switch result {
                case .success(.verified(let transaction)):
                    // Nothing to deliver: Pro is read from the current entitlements, which now include
                    // this transaction. Finishing tells the App Store the purchase was handled.
                    await transaction.finish()
                    call.resolve(["result": "purchased"])
                case .success(.unverified(let transaction, let error)):
                    // The signature did not check out: don't unlock. Left unfinished, like Apple's
                    // sample code does, so StoreKit offers it again at the next launch.
                    CAPLog.print("Store: unverified purchase \(transaction.id): \(error)")
                    call.resolve(["result": "failed", "error": "The purchase could not be verified: \(error.localizedDescription)"])
                case .userCancelled:
                    call.resolve(["result": "cancelled"])
                case .pending:
                    // Ask to Buy, or a payment that needs action: Transaction.updates reports it later.
                    call.resolve(["result": "pending"])
                @unknown default:
                    call.resolve(["result": "failed", "error": "Unknown purchase result"])
                }
            } catch StoreKitError.userCancelled {
                call.resolve(["result": "cancelled"])
            } catch {
                // e.g. Product.PurchaseError.purchaseNotAllowed (purchases turned off in Screen Time),
                // StoreKitError.networkError.
                call.resolve(["result": "failed", "error": error.localizedDescription])
            }
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        guard let productId = requiredProductId(call) else { return }
        Task {
            var failure: String?
            do {
                // Apple: only call this when the player asks (the Restore Purchases button). It may
                // show the App Store sign-in.
                try await AppStore.sync()
            } catch StoreKitError.userCancelled {
                failure = "cancelled"
            } catch let syncError {
                failure = syncError.localizedDescription
            }
            // Check even if the sync failed: the entitlements on the device may already include Pro.
            let unlocked = await self.isEntitled(to: productId)
            var data: PluginCallResultData = ["unlocked": unlocked]
            if let failure {
                data["error"] = failure
            }
            call.resolve(data)
        }
    }

    // MARK: - StoreKit

    /// Whether the player owns `productId` now: a verified transaction for it, not refunded or
    /// revoked, among the current entitlements. These include purchases shared through Family
    /// Sharing, and come from StoreKit's on-device cache (no network needed).
    private func isEntitled(to productId: String) async -> Bool {
        for await result in StoreKit.Transaction.currentEntitlements {
            // Refunded and revoked purchases are already left out of currentEntitlements; checking
            // revocationDate as well costs nothing.
            if case .verified(let transaction) = result,
               transaction.productID == productId,
               transaction.revocationDate == nil {
                return true
            }
        }
        return false
    }

    /// Shows the App Store purchase sheet. From iOS 17, StoreKit asks UIKit apps for the scene to show
    /// it in; on iOS 16, purchase() finds it by itself.
    @MainActor
    private func buy(_ product: Product) async throws -> Product.PurchaseResult {
        if #available(iOS 17.0, *), let scene = bridge?.viewController?.viewIfLoaded?.window?.windowScene {
            return try await product.purchase(confirmIn: scene)
        }
        return try await product.purchase()
    }

    /// A transaction from Transaction.updates: finish it if it is verified, check the entitlement
    /// again and tell JavaScript.
    private func handle(_ update: VerificationResult<StoreKit.Transaction>) async {
        let productId: String
        switch update {
        case .verified(let transaction):
            productId = transaction.productID
            await transaction.finish()
        case .unverified(let transaction, let error):
            productId = transaction.productID
            CAPLog.print("Store: ignoring an unverified transaction \(transaction.id): \(error)")
        }
        // Check the entitlements rather than trust this one transaction: e.g. when a purchase shared
        // by a family member is revoked, Pro stays unlocked if this Apple ID bought it too.
        let unlocked = await isEntitled(to: productId)
        // addListener/removeListener change the plugin's listener list on the bridge's queue. Notify
        // from that queue too, so the two never touch the list at the same time.
        let queue = (bridge as? CapacitorBridge)?.dispatchQueue ?? DispatchQueue.main
        queue.async { [weak self] in
            self?.notifyListeners("entitlementChanged", data: ["productId": productId, "unlocked": unlocked])
        }
    }

    // MARK: - Helpers

    /// The call's `productId` option, or nil after rejecting the call.
    private func requiredProductId(_ call: CAPPluginCall) -> String? {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("productId is required", "INVALID_ARGUMENT")
            return nil
        }
        return productId
    }
}
