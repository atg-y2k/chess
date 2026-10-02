import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlwaysUnlocked,
  MOCK_PRO_KEY,
  MockPurchases,
  NativePurchases,
  PRO_PRODUCT_ID,
  type EntitlementChangedEvent,
  type MockStore,
  type PurchaseResult,
  type StorePlugin,
} from '../../src/native/purchases';
import { importAs, MemoryStorage, resetPlatform } from './helpers';

const core = vi.hoisted(() => ({ registerPlugin: vi.fn(), Capacitor: { isPluginAvailable: vi.fn(() => true) } }));
vi.mock('@capacitor/core', () => core);

const load = () => import('../../src/native/purchases');
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Settles `p`, or fails after `ms` (a promise resolved with a Capacitor proxy never settles). */
function settle<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('never settled')), ms))]);
}

/** A fake native "Store" plugin; `emit` sends an entitlementChanged event to its listener. */
function fakePlugin() {
  const listeners: ((event: EntitlementChangedEvent) => void)[] = [];
  const plugin = {
    getProduct: vi.fn(async (_o: { productId: string }): Promise<unknown> => ({
      id: PRO_PRODUCT_ID,
      title: 'Pro',
      description: 'Coach explanations',
      displayPrice: '$9.99',
    })),
    isUnlocked: vi.fn(async (_o: { productId: string }): Promise<{ unlocked: unknown }> => ({ unlocked: false })),
    purchase: vi.fn(async (_o: { productId: string }): Promise<{ result: unknown; error?: string }> => ({
      result: 'purchased',
    })),
    restore: vi.fn(async (_o: { productId: string }): Promise<{ unlocked: unknown; error?: string }> => ({
      unlocked: true,
    })),
    addListener: vi.fn(async (_event: string, listener: (event: EntitlementChangedEvent) => void) => {
      listeners.push(listener);
      return { remove: async () => {} };
    }),
  };
  return {
    plugin,
    store: plugin as unknown as StorePlugin,
    emit: (event: EntitlementChangedEvent) => listeners.forEach((l) => l(event)),
  };
}

/**
 * Like the proxy Capacitor's registerPlugin returns: it answers every property name with a "native
 * method", `then` included (which never calls back).
 */
function capacitorProxy(methods: object): object {
  return new Proxy(
    {},
    {
      get: (_, prop) => (prop in methods ? (methods as Record<PropertyKey, unknown>)[prop] : () => new Promise(() => {})),
    },
  );
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  resetPlatform();
  vi.useRealTimers();
  vi.restoreAllMocks();
  core.registerPlugin.mockReset();
  delete (globalThis as { __mockStore?: unknown }).__mockStore;
});

describe('getPurchases', () => {
  it('the web app sells nothing: everything is unlocked', async () => {
    for (const env of [{ native: false }, { native: true, runtime: false }]) {
      const { getPurchases } = await importAs(load, env);
      const p = getPurchases();
      expect(p.constructor.name).toBe('AlwaysUnlocked');
      expect(getPurchases()).toBe(p);
    }
    expect(core.registerPlugin).not.toHaveBeenCalled();
  });

  it('a VITE_PAYWALL=1 web build uses the mock store, kept in localStorage', async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    const { getPurchases } = await importAs(load, { native: false, paywall: true });
    const p = getPurchases();
    expect(p.constructor.name).toBe('MockPurchases');
    const mock = (globalThis as { __mockStore?: MockStore }).__mockStore!;
    mock.delayMs = 0;
    expect(await p.purchase()).toBe('purchased');
    expect(storage.getItem(MOCK_PRO_KEY)).toBe('1');
    expect(await p.isUnlocked()).toBe(true);
  });

  it('the App Store app uses the native Store plugin', async () => {
    const { plugin } = fakePlugin();
    plugin.isUnlocked.mockResolvedValue({ unlocked: true });
    core.registerPlugin.mockReturnValue(capacitorProxy(plugin));
    const { getPurchases } = await importAs(load, { native: true });
    const p = getPurchases();
    expect(p.constructor.name).toBe('NativePurchases');
    expect(await settle(p.isUnlocked())).toBe(true);
    expect(await settle(p.getProduct())).toMatchObject({ displayPrice: '$9.99' });
    expect(core.registerPlugin.mock.calls).toEqual([['Store']]); // registered once
    expect(plugin.isUnlocked).toHaveBeenCalledWith({ productId: PRO_PRODUCT_ID });
  });
});

describe('AlwaysUnlocked', () => {
  it('is unlocked, buys and restores at once, has no product and no changes', async () => {
    const p = new AlwaysUnlocked();
    expect(await p.isUnlocked()).toBe(true);
    expect(await p.purchase()).toBe('purchased');
    expect(await p.restore()).toBe('restored');
    expect(await p.getProduct()).toBeNull();
    const off = p.onChange(() => {
      throw new Error('never called');
    });
    off();
  });
});

describe('MockPurchases', () => {
  const make = (init: Record<string, string> = {}, target: { __mockStore?: unknown } = {}) => {
    const storage = new MemoryStorage(init);
    const p = new MockPurchases({ storage, target });
    p.controls.delayMs = 0;
    return { p, storage, target, store: target.__mockStore as MockStore };
  };

  it('defaults: a $9.99 product, locked until purchased, then unlocked for good', async () => {
    const { p, storage } = make();
    expect(await p.getProduct()).toEqual({
      id: PRO_PRODUCT_ID,
      title: expect.stringMatching(/ Pro$/),
      description: expect.any(String),
      displayPrice: '$9.99',
    });
    expect(await p.isUnlocked()).toBe(false);
    expect(await p.purchase()).toBe('purchased');
    expect(storage.getItem(MOCK_PRO_KEY)).toBe('1');
    expect(await p.isUnlocked()).toBe(true);
    expect(await new MockPurchases({ storage, target: {} }).isUnlocked()).toBe(true); // after a reload
  });

  it('window.__mockStore sets what purchase() gives; nothing but "purchased" unlocks', async () => {
    const { p, target } = make();
    for (const result of ['cancelled', 'pending', 'failed'] as const) {
      target.__mockStore = { result };
      expect(await p.purchase()).toBe(result);
      expect(await p.isUnlocked()).toBe(false);
    }
    target.__mockStore = { result: 'nonsense' };
    expect(await p.purchase()).toBe('failed');
    (target.__mockStore as MockStore).result = 'purchased';
    expect(await p.purchase()).toBe('purchased');
  });

  it('assigning merges the settings, keeps the controls, and ignores unknown or bad values', () => {
    const { target } = make();
    target.__mockStore = { price: '€10,99', available: false, unlocked: true, setUnlocked: 'x', delayMs: 'slow' };
    const store = target.__mockStore as MockStore;
    expect(store).toMatchObject({ result: 'purchased', price: '€10,99', available: false, owned: false, delayMs: 0 });
    expect(store.unlocked).toBe(false);
    expect(typeof store.setUnlocked).toBe('function');
    target.__mockStore = undefined;
    expect(target.__mockStore).toBe(store);
  });

  it('picks up settings a test put on window.__mockStore before the app started', async () => {
    const target: { __mockStore?: unknown } = { __mockStore: { result: 'pending', price: '$4.99', delayMs: 0 } };
    const p = new MockPurchases({ storage: new MemoryStorage(), target });
    expect(await p.purchase()).toBe('pending');
    expect((await p.getProduct())?.displayPrice).toBe('$4.99');
  });

  it('available: false makes the store unavailable', async () => {
    const { p, target } = make();
    target.__mockStore = { available: false };
    expect(await p.getProduct()).toBeNull();
  });

  it('restore() finds Pro only when the Apple ID owns it', async () => {
    const { p, target } = make();
    expect(await p.restore()).toBe('none');
    target.__mockStore = { owned: true };
    expect(await p.restore()).toBe('restored');
    expect(await p.isUnlocked()).toBe(true);
  });

  it('restoreError: a cancelled sign-in or a failed sync (an unlock already on the device still wins)', async () => {
    const { p, target, store } = make();
    target.__mockStore = { owned: true, restoreError: 'cancelled' };
    expect(await p.restore()).toBe('cancelled');
    target.__mockStore = { restoreError: 'failed' };
    expect(await p.restore()).toBe('failed');
    expect(store.unlocked).toBe(false);
    store.setUnlocked(true);
    expect(await p.restore()).toBe('restored');
    target.__mockStore = { restoreError: null };
    expect(store.restoreError).toBeNull();
  });

  it('setUnlocked: outside changes (Ask to Buy approval, refund) fire onChange when they change something', async () => {
    const { p, store } = make();
    const seen: boolean[] = [];
    const other: boolean[] = [];
    p.onChange(() => {
      throw new Error('a broken listener');
    });
    const off = p.onChange((u) => seen.push(u));
    p.onChange((u) => other.push(u));
    store.setUnlocked(true); // e.g. Ask to Buy approved
    expect(store.unlocked).toBe(true);
    expect(await p.isUnlocked()).toBe(true);
    store.setUnlocked(true); // no change
    off();
    store.setUnlocked(false); // e.g. refunded
    expect(await p.isUnlocked()).toBe(false);
    expect(seen).toEqual([true]);
    expect(other).toEqual([true, false]);
    expect(warn).toHaveBeenCalledWith('[store] an onChange listener failed', expect.any(Error));
  });

  it('a purchase does not fire onChange (its result says it)', async () => {
    const { p } = make();
    const seen: boolean[] = [];
    p.onChange((u) => seen.push(u));
    await p.purchase();
    expect(seen).toEqual([]);
  });

  it('answers after a small pretend delay (300 ms by default)', async () => {
    vi.useFakeTimers();
    const p = new MockPurchases({ storage: new MemoryStorage(), target: {} });
    let done = false;
    void p.isUnlocked().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(299);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('never throws when storage fails or is missing', async () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const p = new MockPurchases({ storage: broken, target: {} });
    p.controls.delayMs = 0;
    expect(await p.purchase()).toBe('purchased');
    expect(await p.isUnlocked()).toBe(false);
    const none = new MockPurchases({ storage: null, target: {} });
    none.controls.delayMs = 0;
    expect(await none.purchase()).toBe('purchased');
    expect(await none.isUnlocked()).toBe(false);
  });
});

describe('NativePurchases', () => {
  const make = () => {
    const fake = fakePlugin();
    const loader = vi.fn(async () => ({ store: fake.store }));
    return { ...fake, loader, p: new NativePurchases(loader) };
  };

  it('passes PRO_PRODUCT_ID with every call and loads the plugin once', async () => {
    const { p, plugin, loader } = make();
    await p.getProduct();
    await p.isUnlocked();
    await p.purchase();
    await p.restore();
    for (const m of [plugin.getProduct, plugin.isUnlocked, plugin.purchase, plugin.restore])
      expect(m.mock.calls).toEqual([[{ productId: PRO_PRODUCT_ID }]]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('getProduct: the product, or null when the store fails or answers nonsense', async () => {
    const { p, plugin } = make();
    expect(await p.getProduct()).toEqual({
      id: PRO_PRODUCT_ID,
      title: 'Pro',
      description: 'Coach explanations',
      displayPrice: '$9.99',
    });
    plugin.getProduct.mockRejectedValueOnce(new Error('The App Store has no product'));
    expect(await p.getProduct()).toBeNull();
    plugin.getProduct.mockResolvedValueOnce({ id: PRO_PRODUCT_ID });
    expect(await p.getProduct()).toBeNull();
    plugin.getProduct.mockResolvedValueOnce({ id: PRO_PRODUCT_ID, displayPrice: '$9.99' });
    expect(await p.getProduct()).toEqual({ id: PRO_PRODUCT_ID, title: '', description: '', displayPrice: '$9.99' });
    expect(warn).toHaveBeenCalled();
  });

  it('isUnlocked: only a true from the plugin unlocks; a failed call rejects (unknown, not locked)', async () => {
    const { p, plugin } = make();
    plugin.isUnlocked.mockResolvedValueOnce({ unlocked: true });
    expect(await p.isUnlocked()).toBe(true);
    plugin.isUnlocked.mockResolvedValueOnce({ unlocked: 'yes' });
    expect(await p.isUnlocked()).toBe(false);
    plugin.isUnlocked.mockRejectedValueOnce(new Error('bridge'));
    await expect(p.isUnlocked()).rejects.toThrow('bridge');
  });

  it('purchase: passes the four results through; anything else, or a rejection, is "failed"', async () => {
    const { p, plugin } = make();
    for (const result of ['purchased', 'cancelled', 'pending', 'failed'] satisfies PurchaseResult[]) {
      plugin.purchase.mockResolvedValueOnce({ result });
      expect(await p.purchase()).toBe(result);
    }
    plugin.purchase.mockResolvedValueOnce({ result: 'refunded' });
    expect(await p.purchase()).toBe('failed');
    plugin.purchase.mockRejectedValueOnce(new Error('bridge'));
    expect(await p.purchase()).toBe('failed');
    plugin.purchase.mockResolvedValueOnce({ result: 'failed', error: 'Purchases are not allowed' });
    expect(await p.purchase()).toBe('failed');
    expect(warn).toHaveBeenCalledWith('[store] purchase failed:', 'Purchases are not allowed');
  });

  it('restore: restored, none, cancelled, or failed (a failed sync is not "nothing to restore")', async () => {
    const { p, plugin } = make();
    expect(await p.restore()).toBe('restored');
    plugin.restore.mockResolvedValueOnce({ unlocked: false });
    expect(await p.restore()).toBe('none');
    plugin.restore.mockResolvedValueOnce({ unlocked: false, error: 'cancelled' });
    expect(await p.restore()).toBe('cancelled');
    expect(warn).not.toHaveBeenCalled();
    plugin.restore.mockResolvedValueOnce({ unlocked: false, error: 'The Internet connection appears to be offline.' });
    expect(await p.restore()).toBe('failed');
    expect(warn).toHaveBeenCalledWith('[store] App Store sync failed:', 'The Internet connection appears to be offline.');
    // The entitlement on the device is checked even when the sync failed: it wins.
    plugin.restore.mockResolvedValueOnce({ unlocked: true, error: 'The Internet connection appears to be offline.' });
    expect(await p.restore()).toBe('restored');
    plugin.restore.mockRejectedValueOnce(new Error('bridge'));
    expect(await p.restore()).toBe('failed');
  });

  it('onChange: one native listener; tells every subscriber about changes to Pro only', async () => {
    const { p, plugin, emit } = make();
    const a: boolean[] = [];
    const b: boolean[] = [];
    const offA = p.onChange((u) => a.push(u));
    p.onChange((u) => b.push(u));
    await flush();
    expect(plugin.addListener).toHaveBeenCalledTimes(1);
    expect(plugin.addListener.mock.calls[0]?.[0]).toBe('entitlementChanged');

    emit({ productId: PRO_PRODUCT_ID, unlocked: true }); // e.g. Ask to Buy approved
    emit({ productId: 'some.other.product', unlocked: false });
    emit({ productId: PRO_PRODUCT_ID, unlocked: true }); // no change
    offA();
    emit({ unlocked: false }); // e.g. refunded (an event without a product ID counts)
    expect(a).toEqual([true]);
    expect(b).toEqual([true, false]);
  });

  it('onChange stays quiet about what isUnlocked, purchase or restore already said', async () => {
    const { p, plugin, emit } = make();
    const seen: boolean[] = [];
    p.onChange((u) => seen.push(u));
    await flush();
    plugin.isUnlocked.mockResolvedValueOnce({ unlocked: true });
    await p.isUnlocked();
    emit({ productId: PRO_PRODUCT_ID, unlocked: true }); // e.g. an unfinished transaction at launch
    expect(seen).toEqual([]);
    emit({ productId: PRO_PRODUCT_ID, unlocked: false }); // refunded
    expect(seen).toEqual([false]);
    await p.purchase(); // bought again
    emit({ productId: PRO_PRODUCT_ID, unlocked: true });
    expect(seen).toEqual([false]);
  });

  it('without the plugin: safe answers, and it tries to load it again next time', async () => {
    const fake = fakePlugin();
    const loader = vi
      .fn<() => Promise<{ store: StorePlugin }>>()
      .mockRejectedValueOnce(new Error('"Store" plugin is not implemented on ios'))
      .mockResolvedValue({ store: fake.store });
    const p = new NativePurchases(loader);
    expect(await p.getProduct()).toBeNull();
    expect(await p.isUnlocked()).toBe(false); // loaded on the second try
    expect(await p.purchase()).toBe('purchased');
    expect(loader).toHaveBeenCalledTimes(2);
    const missing = new NativePurchases(() => Promise.reject(new Error('"Store" plugin is not implemented on ios')));
    await expect(missing.isUnlocked()).rejects.toThrow(/not implemented/);
    expect(await missing.restore()).toBe('failed');
    expect(await missing.purchase()).toBe('failed');
    expect(warn).toHaveBeenCalledWith('[store] getProduct: the Store plugin is unavailable', expect.any(Error));
  });

  it('onChange tries to listen again if the first attempt failed', async () => {
    const { p, plugin, emit } = make();
    plugin.addListener.mockRejectedValueOnce(new Error('bridge'));
    const seen: boolean[] = [];
    p.onChange((u) => seen.push(u));
    await flush();
    p.onChange(() => {});
    await flush();
    expect(plugin.addListener).toHaveBeenCalledTimes(2);
    emit({ productId: PRO_PRODUCT_ID, unlocked: true });
    expect(seen).toEqual([true]);
  });

  it('works with the real loader and a Capacitor-like proxy (never resolves a promise with the proxy)', async () => {
    const { plugin, emit } = fakePlugin();
    core.registerPlugin.mockReturnValue(capacitorProxy(plugin));
    const { NativePurchases: Native } = await importAs(load, { native: true });
    const p = new Native();
    const seen: boolean[] = [];
    p.onChange((u) => seen.push(u));
    expect(await settle(p.getProduct())).not.toBeNull();
    expect(await settle(p.isUnlocked())).toBe(false);
    expect(await settle(p.purchase())).toBe('purchased');
    expect(await settle(p.restore())).toBe('restored');
    await flush();
    emit({ productId: PRO_PRODUCT_ID, unlocked: false });
    expect(seen).toEqual([false]);
  });
});

describe('loadStorePlugin', () => {
  it('rejects, and says loudly once, when the app did not register the "Store" plugin', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    core.Capacitor.isPluginAvailable.mockReturnValue(false);
    try {
      const { loadStorePlugin, NativePurchases: Native } = await importAs(load, { native: true });
      await expect(loadStorePlugin()).rejects.toThrow(/not registered/);
      await expect(loadStorePlugin()).rejects.toThrow(/not registered/);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toMatch(/MainViewController/);
      expect(core.registerPlugin).not.toHaveBeenCalled();
      await expect(new Native().isUnlocked()).rejects.toThrow(); // so the cached Pro is kept
    } finally {
      core.Capacitor.isPluginAvailable.mockReturnValue(true);
    }
    expect(core.Capacitor.isPluginAvailable).toHaveBeenCalledWith('Store');
  });
});

describe('the native side agrees with this module', () => {
  it('Products.storekit sells PRO_PRODUCT_ID as a $9.99 non-consumable with Family Sharing', () => {
    const config = JSON.parse(read('ios/App/App/Products.storekit')) as {
      products: { productID: string; type: string; familyShareable: boolean; displayPrice: string }[];
    };
    expect(config.products).toEqual([
      expect.objectContaining({
        productID: PRO_PRODUCT_ID,
        type: 'NonConsumable',
        familyShareable: true,
        displayPrice: '9.99',
      }),
    ]);
  });

  it('StorePlugin.swift is "Store" with the methods and event of the StorePlugin interface', () => {
    const swift = read('ios/App/App/StorePlugin.swift');
    expect(swift).toMatch(/public let jsName = "Store"/);
    const declared = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)", returnType: CAPPluginReturnPromise\)/g)].map(
      (m) => m[1],
    );
    const implemented = [...swift.matchAll(/@objc func (\w+)\(_ call: CAPPluginCall\)/g)].map((m) => m[1]);
    expect(declared).toEqual(['getProduct', 'isUnlocked', 'purchase', 'restore']);
    expect(implemented).toEqual(declared);
    expect(swift).toMatch(/notifyListeners\("entitlementChanged"/);
  });

  it('the Xcode project compiles the plugin, registers it at launch, and tests with Products.storekit', () => {
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    for (const file of ['StorePlugin.swift', 'MainViewController.swift'])
      expect(pbx.split(`/* ${file} in Sources */`).length - 1, file).toBe(2); // the build file and the Sources phase
    expect(pbx).not.toMatch(/Products\.storekit in Resources/); // a test file: not shipped in the app
    expect(read('ios/App/App/MainViewController.swift')).toMatch(/registerPluginInstance\(StorePlugin\(\)\)/);
    expect(read('ios/App/App/SceneDelegate.swift')).toMatch(/rootViewController = MainViewController\(\)/);
    expect(read('ios/App/App/Base.lproj/Main.storyboard')).toMatch(/customClass="MainViewController" customModule="App"/);
    // Xcode resolves the path from App.xcodeproj/xcshareddata/.
    expect(read('ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme')).toMatch(
      /<StoreKitConfigurationFileReference\s+identifier = "\.\.\/\.\.\/App\/Products\.storekit">/,
    );
  });
});
