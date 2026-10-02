/**
 * The one-time "Pro" in-app purchase: a non-consumable App Store product with Family Sharing on,
 * bought and checked with StoreKit 2 on the device (no server, no account).
 *
 * `getPurchases()` picks the store for the build:
 * - the App Store app: `NativePurchases`, over the app's own Capacitor plugin "Store"
 *   (ios/App/App/StorePlugin.swift, registered by MainViewController.swift);
 * - a web build made with VITE_PAYWALL=1, for testing the paywall: `MockPurchases`, a pretend store
 *   kept in localStorage that tests steer through `window.__mockStore`;
 * - the web app (PWA): `AlwaysUnlocked`, since nothing is sold there.
 *
 * Failures are logged with console.warn and reported in the result ('failed', 'cancelled', null),
 * never thrown, with one exception: `isUnlocked()` rejects when the store cannot be asked at all (the
 * plugin is missing or the call failed), so callers keep what they knew instead of reading "not
 * bought" (which would lock out a player who paid).
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { APP_NAME, isNative, nativePlugins, paywallEnabled } from './platform';

/**
 * The Pro product's ID, the one place it is set in code. It must match the in-app purchase in App
 * Store Connect, and ios/App/App/Products.storekit (for testing purchases in Xcode).
 */
export const PRO_PRODUCT_ID = 'io.github.atgy2k.chesscoach.pro';

/** The Pro product as the store describes it, localized for the player's storefront. */
export interface ProProduct {
  id: string;
  /** Display name. */
  title: string;
  description: string;
  /** The price with its currency, e.g. "$9.99". */
  displayPrice: string;
}

/**
 * How a purchase ended: 'purchased' (Pro is unlocked now), 'cancelled' (the player closed the
 * sheet), 'pending' (waiting for approval, e.g. Ask to Buy; onChange reports an approval), 'failed'.
 */
export type PurchaseResult = 'purchased' | 'cancelled' | 'pending' | 'failed';

/**
 * How Restore Purchases ended: 'restored' (Pro is unlocked), 'none' (the App Store was asked and
 * this Apple Account has no Pro), 'cancelled' (the player closed the App Store sign-in), 'failed'
 * (the App Store could not be reached or the sync failed, so whether Pro is owned is not known).
 */
export type RestoreResult = 'restored' | 'none' | 'cancelled' | 'failed';

export interface Purchases {
  /** The product with its localized price; null when the store is unavailable (offline, not set up). */
  getProduct(): Promise<ProProduct | null>;
  /**
   * Whether Pro is unlocked: a verified, unrefunded purchase by this Apple ID or shared with it
   * through Family Sharing. Works offline (StoreKit's on-device cache). Rejects when the store
   * cannot be asked (e.g. the native plugin is missing): that is "unknown", not "locked".
   */
  isUnlocked(): Promise<boolean>;
  /** Shows the App Store purchase sheet. */
  purchase(): Promise<PurchaseResult>;
  /** Restore Purchases: syncs with the App Store (may ask to sign in), then checks again. Never rejects. */
  restore(): Promise<RestoreResult>;
  /**
   * Calls `cb` when Pro gets unlocked or locked outside purchase() and restore(): an Ask to Buy
   * approval, a purchase on another device, a refund or a revocation. Returns the unsubscribe.
   */
  onChange(cb: (unlocked: boolean) => void): () => void;
}

const RESULTS: readonly PurchaseResult[] = ['purchased', 'cancelled', 'pending', 'failed'];

/** `r` if it is a PurchaseResult, else 'failed'. */
function asResult(r: unknown): PurchaseResult {
  return RESULTS.includes(r as PurchaseResult) ? (r as PurchaseResult) : 'failed';
}

/** A product from the plugin, checked; null if it is not one. */
function asProduct(p: unknown): ProProduct | null {
  if (!p || typeof p !== 'object') return null;
  const { id, title, description, displayPrice } = p as Record<string, unknown>;
  if (typeof id !== 'string' || typeof displayPrice !== 'string' || !displayPrice) return null;
  return {
    id,
    title: typeof title === 'string' ? title : '',
    description: typeof description === 'string' ? description : '',
    displayPrice,
  };
}

/** onChange's listeners: each is called on its own, so one that throws does not stop the others. */
class Listeners {
  private readonly fns = new Set<(unlocked: boolean) => void>();

  add(cb: (unlocked: boolean) => void): () => void {
    const fn = (unlocked: boolean): void => cb(unlocked); // a new entry even if `cb` is added twice
    this.fns.add(fn);
    return () => {
      this.fns.delete(fn);
    };
  }

  emit(unlocked: boolean): void {
    for (const fn of [...this.fns]) {
      try {
        fn(unlocked);
      } catch (e) {
        console.warn('[store] an onChange listener failed', e);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The App Store app

/** Sent by the plugin after each transaction update, once it has checked the entitlement again. */
export interface EntitlementChangedEvent {
  productId?: string;
  unlocked: boolean;
}

/** The native plugin's interface (ios/App/App/StorePlugin.swift, jsName "Store"). */
export interface StorePlugin {
  /** Rejects when the App Store does not know the product or can't be reached. */
  getProduct(options: { productId: string }): Promise<ProProduct>;
  isUnlocked(options: { productId: string }): Promise<{ unlocked: boolean }>;
  purchase(options: { productId: string }): Promise<{ result: PurchaseResult; error?: string }>;
  /** `error`: the App Store sync failed ('cancelled' if the player closed the sign-in); `unlocked` is still checked. */
  restore(options: { productId: string }): Promise<{ unlocked: boolean; error?: string }>;
  addListener(
    eventName: 'entitlementChanged',
    listener: (event: EntitlementChangedEvent) => void,
  ): Promise<PluginListenerHandle>;
}

let reportedMissing = false;

/**
 * Loads the native plugin. It comes wrapped in an object on purpose: a Capacitor plugin proxy
 * answers every property, `then` included, so a promise resolved with the proxy itself would call
 * a native method "then" and never settle. Never return the proxy from an async function.
 * Rejects, with a loud console.error once, when the app did not register the plugin (SceneDelegate
 * must create MainViewController, which registers it; see ios/README-native.md).
 */
export async function loadStorePlugin(): Promise<{ store: StorePlugin }> {
  const { Capacitor, registerPlugin } = await nativePlugins.core();
  if (!Capacitor.isPluginAvailable('Store')) {
    if (!reportedMissing) {
      reportedMissing = true;
      console.error(
        '[store] The native "Store" plugin is not registered: in-app purchases cannot work. ' +
          'SceneDelegate.swift must create MainViewController (see ios/README-native.md).',
      );
    }
    throw new Error('The "Store" plugin is not registered');
  }
  return { store: registerPlugin<StorePlugin>('Store') };
}

/** The App Store app's store: StoreKit 2 through the "Store" plugin. */
export class NativePurchases implements Purchases {
  private readonly load: () => Promise<{ store: StorePlugin }>;
  private readonly productId: string;
  private loaded: Promise<{ store: StorePlugin }> | null = null;
  private readonly listeners = new Listeners();
  private listening = false;
  /** The last state the store reported (null: none yet). onChange fires only when an event changes it. */
  private known: boolean | null = null;

  constructor(load: () => Promise<{ store: StorePlugin }> = loadStorePlugin, productId: string = PRO_PRODUCT_ID) {
    this.load = load;
    this.productId = productId;
  }

  getProduct(): Promise<ProProduct | null> {
    return this.withStore('getProduct', null, async (store) => {
      const product = asProduct(await store.getProduct({ productId: this.productId }));
      if (!product) console.warn('[store] getProduct gave no product');
      return product;
    });
  }

  /** Rejects when the plugin is unavailable or the call fails (see Purchases.isUnlocked). */
  async isUnlocked(): Promise<boolean> {
    const { store } = await this.plugin('isUnlocked');
    const { unlocked } = await store.isUnlocked({ productId: this.productId });
    this.known = unlocked === true;
    return this.known;
  }

  purchase(): Promise<PurchaseResult> {
    return this.withStore('purchase', 'failed', async (store) => {
      const { result, error } = await store.purchase({ productId: this.productId });
      const r = asResult(result);
      if (r === 'failed') console.warn('[store] purchase failed:', error ?? result);
      if (r === 'purchased') this.known = true;
      return r;
    });
  }

  restore(): Promise<RestoreResult> {
    return this.withStore<RestoreResult>('restore', 'failed', async (store) => {
      const { unlocked, error } = await store.restore({ productId: this.productId });
      if (error && error !== 'cancelled') console.warn('[store] App Store sync failed:', error);
      this.known = unlocked === true;
      // The plugin checks the entitlement even when the sync failed: an unlock wins.
      if (this.known) return 'restored';
      if (error === 'cancelled') return 'cancelled';
      return error ? 'failed' : 'none';
    });
  }

  onChange(cb: (unlocked: boolean) => void): () => void {
    const off = this.listeners.add(cb);
    if (!this.listening) {
      // One native listener for the app's lifetime, shared by all callers.
      this.listening = true;
      void this.withStore('onChange', false, async (store) => {
        await store.addListener('entitlementChanged', (event) => this.changed(event));
        return true;
      }).then((ok) => {
        if (!ok) this.listening = false; // try again with the next onChange()
      });
    }
    return off;
  }

  /** An `entitlementChanged` event: tells the listeners if it changes the known state. */
  private changed(event: EntitlementChangedEvent | null | undefined): void {
    if (!event || (event.productId !== undefined && event.productId !== this.productId)) return;
    const unlocked = event.unlocked === true;
    if (unlocked === this.known) return;
    this.known = unlocked;
    this.listeners.emit(unlocked);
  }

  /**
   * The plugin, loaded once, still boxed (an async function must never return the proxy itself);
   * rejects, and loads again next time, when it is unavailable.
   */
  private async plugin(what: string): Promise<{ store: StorePlugin }> {
    try {
      return await (this.loaded ??= this.load());
    } catch (e) {
      this.loaded = null;
      console.warn(`[store] ${what}: the Store plugin is unavailable`, e);
      throw e;
    }
  }

  /** Runs `f` with the plugin; on any failure logs it and gives `fallback`. */
  private async withStore<T>(what: string, fallback: T, f: (store: StorePlugin) => Promise<T>): Promise<T> {
    let box: { store: StorePlugin };
    try {
      box = await this.plugin(what);
    } catch {
      return fallback;
    }
    try {
      return await f(box.store);
    } catch (e) {
      console.warn(`[store] ${what} failed`, e);
      return fallback;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The mock store (web build with VITE_PAYWALL=1)

/** localStorage key of the mock store's "Pro is unlocked" flag ('1'). */
export const MOCK_PRO_KEY = 'chesscoach.mockPro';

/** What a test can set on `window.__mockStore`. Assigning an object to it merges these in. */
export interface MockStoreSettings {
  /** What purchase() gives (default 'purchased', which unlocks). */
  result?: PurchaseResult;
  /** The product's displayPrice (default '$9.99'). */
  price?: string;
  /** false: the store is unavailable, so getProduct() gives null (default true). */
  available?: boolean;
  /**
   * The Apple ID already owns Pro (bought on another device, or before a reinstall), so restore()
   * unlocks it (default false).
   */
  owned?: boolean;
  /** The pretend latency of every call, in ms (default 300). */
  delayMs?: number;
  /**
   * How the App Store sync of restore() goes wrong: 'cancelled' (the player closes the sign-in),
   * 'failed' (offline), or null (it works; default).
   */
  restoreError?: 'cancelled' | 'failed' | null;
}

/** `window.__mockStore` while the mock store runs: its settings, plus controls. */
export interface MockStore extends Required<MockStoreSettings> {
  /** Whether Pro is unlocked now. */
  readonly unlocked: boolean;
  /**
   * A change made outside the app: true = an Ask to Buy approval or a purchase on another device,
   * false = a refund or revocation. Fires onChange if it changes anything.
   */
  setUnlocked(unlocked: boolean): void;
}

const MOCK_DEFAULTS: Required<MockStoreSettings> = {
  result: 'purchased',
  price: '$9.99',
  available: true,
  owned: false,
  delayMs: 300,
  restoreError: null,
};

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

/**
 * A pretend App Store for testing the paywall in the browser. Pro is a localStorage flag
 * (MOCK_PRO_KEY); tests set what the store does through `window.__mockStore` (see MockStore).
 */
export class MockPurchases implements Purchases {
  /** The settings and controls, also at `window.__mockStore`. */
  readonly controls: MockStore;
  private readonly storage: KeyValue | null;
  private readonly listeners = new Listeners();

  /** `target` gets the `__mockStore` property (default: globalThis, i.e. window). */
  constructor({ storage, target = globalThis }: { storage?: KeyValue | null; target?: object } = {}) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.controls = { ...MOCK_DEFAULTS, unlocked: false, setUnlocked: (unlocked) => this.setUnlocked(unlocked) };
    Object.defineProperty(this.controls, 'unlocked', { enumerable: true, get: () => this.read() });
    const t = target as { __mockStore?: unknown };
    this.merge(t.__mockStore); // settings a test put there before the app started
    try {
      Object.defineProperty(target, '__mockStore', {
        configurable: true,
        get: () => this.controls,
        set: (v: unknown) => this.merge(v),
      });
    } catch (e) {
      console.warn('[store] cannot install window.__mockStore', e);
    }
  }

  getProduct(): Promise<ProProduct | null> {
    return this.later(() =>
      this.controls.available === false
        ? null
        : {
            id: PRO_PRODUCT_ID,
            title: `${APP_NAME} Pro`,
            description: 'Coach explanations, hints and Game Review',
            displayPrice: typeof this.controls.price === 'string' ? this.controls.price : MOCK_DEFAULTS.price,
          },
    );
  }

  isUnlocked(): Promise<boolean> {
    return this.later(() => this.read());
  }

  purchase(): Promise<PurchaseResult> {
    return this.later(() => {
      const r = asResult(this.controls.result);
      if (r === 'purchased') this.write(true);
      return r;
    });
  }

  restore(): Promise<RestoreResult> {
    return this.later((): RestoreResult => {
      const error = this.controls.restoreError;
      if (error === 'cancelled') return 'cancelled';
      if (error !== 'failed' && this.controls.owned === true) this.write(true);
      // Like the plugin, an entitlement already on the device wins over a failed sync.
      if (this.read()) return 'restored';
      return error === 'failed' ? 'failed' : 'none';
    });
  }

  onChange(cb: (unlocked: boolean) => void): () => void {
    return this.listeners.add(cb);
  }

  /** See MockStore.setUnlocked. */
  setUnlocked(unlocked: boolean): void {
    const was = this.read();
    this.write(unlocked);
    if (was !== unlocked) this.listeners.emit(unlocked);
  }

  /** Copies the known settings from `v` (anything else is ignored). */
  private merge(v: unknown): void {
    if (!v || typeof v !== 'object' || v === this.controls) return;
    const s = v as MockStoreSettings;
    const c = this.controls as Required<MockStoreSettings>;
    if (s.result !== undefined) c.result = asResult(s.result);
    if (typeof s.price === 'string') c.price = s.price;
    if (typeof s.available === 'boolean') c.available = s.available;
    if (typeof s.owned === 'boolean') c.owned = s.owned;
    if (typeof s.delayMs === 'number') c.delayMs = s.delayMs;
    if (s.restoreError === null || s.restoreError === 'cancelled' || s.restoreError === 'failed') {
      c.restoreError = s.restoreError;
    }
  }

  private read(): boolean {
    try {
      return this.storage?.getItem(MOCK_PRO_KEY) === '1';
    } catch {
      return false;
    }
  }

  private write(unlocked: boolean): void {
    try {
      if (unlocked) this.storage?.setItem(MOCK_PRO_KEY, '1');
      else this.storage?.removeItem(MOCK_PRO_KEY);
    } catch (e) {
      console.warn('[store] mock store: cannot save', e);
    }
  }

  /** `f()` after the pretend latency. */
  private later<T>(f: () => T): Promise<T> {
    const ms = this.controls.delayMs;
    const delay = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
    return new Promise((resolve) => setTimeout(() => resolve(f()), delay));
  }
}

// ---------------------------------------------------------------------------------------------
// The web app

/** The web app's store: nothing is sold, everything is unlocked. */
export class AlwaysUnlocked implements Purchases {
  getProduct(): Promise<ProProduct | null> {
    return Promise.resolve(null);
  }
  isUnlocked(): Promise<boolean> {
    return Promise.resolve(true);
  }
  purchase(): Promise<PurchaseResult> {
    return Promise.resolve('purchased');
  }
  restore(): Promise<RestoreResult> {
    return Promise.resolve('restored');
  }
  onChange(_cb: (unlocked: boolean) => void): () => void {
    return () => {};
  }
}

let instance: Purchases | null = null;

/** The app's store (created on first use; see the module comment for which one). */
export function getPurchases(): Purchases {
  instance ??= createPurchases();
  return instance;
}

function createPurchases(): Purchases {
  // The import.meta.env tests are build-time constants, so each build keeps only the store it can
  // use (the PWA build keeps AlwaysUnlocked alone); isNative and paywallEnabled decide at run time.
  if (import.meta.env.VITE_NATIVE === '1' && isNative) return new NativePurchases();
  if (import.meta.env.VITE_PAYWALL === '1' && paywallEnabled) return new MockPurchases();
  return new AlwaysUnlocked();
}
