import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_INFO,
  FEATURE_TIERS,
  PRO_CACHE_KEY,
  PRO_NAME,
  createEntitlements,
  lockedFeatures,
  proFeatures,
  type Entitlements,
  type ProFeature,
} from '../../src/game/entitlements';
import { NativePurchases, type ProProduct, type Purchases, type StorePlugin } from '../../src/native/purchases';
import { MemoryStorage } from '../helpers/fakeEngine';
import { FakePurchases, deferred } from './fakePurchases';

const ALL: ProFeature[] = [
  'coachExplanations',
  'hint',
  'showBest',
  'explorer',
  'bestMoveArrows',
  'reviewDetails',
  'openingGuides',
  'openingDrills',
];
const PRODUCT: ProProduct = { id: 'io.github.atgy2k.chesscoach.pro', title: 'Pro', description: 'Everything', displayPrice: '$9.99' };

const made: Entitlements[] = [];
function make(opts: { cached?: boolean; storage?: MemoryStorage; purchases?: FakePurchases } = {}) {
  const storage = opts.storage ?? new MemoryStorage();
  if (opts.cached) storage.setItem(PRO_CACHE_KEY, '1');
  const store = opts.purchases ?? new FakePurchases();
  const ent = createEntitlements({ enabled: true, purchases: store, storage });
  made.push(ent);
  return { ent, store, storage };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  for (const e of made.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

describe('the free / Pro split (FEATURE_TIERS)', () => {
  it('sells the coach’s explanations, Hint, Show best, the explorer, best-move arrows, the review details and the opening lessons and drills', () => {
    expect(proFeatures()).toEqual(ALL);
    for (const f of ALL) expect(FEATURE_TIERS[f]).toBe('pro');
    for (const f of ALL) expect(FEATURE_INFO[f].title.length).toBeGreaterThan(0);
    expect(PRO_NAME).toBe('Chess Coach Pro');
  });

  it('locks the Pro features only while the paywall is on and Pro is not unlocked', () => {
    expect([...lockedFeatures(true, false)]).toEqual(ALL);
    expect(lockedFeatures(true, true).size).toBe(0);
    expect(lockedFeatures(false, false).size).toBe(0);
    // A feature switched to 'free' in the config is never locked.
    const tiers = { ...FEATURE_TIERS, hint: 'free' as const };
    expect(lockedFeatures(true, false, tiers).has('hint')).toBe(false);
    expect(proFeatures(tiers)).not.toContain('hint');
  });
});

describe('without the paywall (the PWA)', () => {
  it('allows everything and never shows a paywall', async () => {
    const getProduct = vi.fn();
    const ent = createEntitlements({ enabled: false, purchases: { getProduct } as unknown as Purchases });
    expect(ent.enabled).toBe(false);
    expect(ent.pro.value).toBe(true);
    expect(ent.locked.value.size).toBe(0);
    for (const f of ALL) {
      expect(ent.isAllowed(f)).toBe(true);
      expect(ent.requirePro(f)).toBe(true);
    }
    ent.openPaywall('hint');
    expect(ent.paywall.value.open).toBe(false);
    expect(getProduct).not.toHaveBeenCalled(); // the store is not even asked
    expect(await ent.restore()).toBe('restored');
  });
});

describe('with the paywall', () => {
  it('starts locked without a cached flag, then follows the store’s verified answer', async () => {
    const { ent, store, storage } = make();
    expect(ent.pro.value).toBe(false);
    for (const f of ALL) expect(ent.isAllowed(f)).toBe(false);
    store.unlocked.resolve(true);
    await flush();
    expect(ent.pro.value).toBe(true);
    expect(ent.locked.value.size).toBe(0);
    expect(storage.getItem(PRO_CACHE_KEY)).toBe('1');
  });

  it('starts unlocked from the cached flag (instant UI), and locks again if the store says no', async () => {
    const { ent, store, storage } = make({ cached: true });
    expect(ent.pro.value).toBe(true);
    expect(ent.isAllowed('hint')).toBe(true);
    store.unlocked.resolve(false); // e.g. refunded while the app was closed
    await flush();
    expect(ent.pro.value).toBe(false);
    expect(ent.isAllowed('hint')).toBe(false);
    expect(storage.getItem(PRO_CACHE_KEY)).toBeNull();
  });

  it('keeps the cached flag when the store cannot be asked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ent, store } = make({ cached: true });
    store.unlocked.reject(new Error('offline'));
    await flush();
    expect(ent.pro.value).toBe(true);
  });

  it('follows onChange: a refund locks, an Ask to Buy approval unlocks', async () => {
    const { ent, store, storage } = make({ cached: true });
    store.unlocked.resolve(true);
    await flush();
    store.emit(false);
    expect(ent.pro.value).toBe(false);
    expect(ent.locked.value.has('coachExplanations')).toBe(true);
    expect(storage.getItem(PRO_CACHE_KEY)).toBeNull();
    store.emit(true);
    expect(ent.pro.value).toBe(true);
    expect(storage.getItem(PRO_CACHE_KEY)).toBe('1');
  });

  it('a slower first check does not undo newer news', async () => {
    const { ent, store } = make();
    store.emit(true); // bought on another device, before the first check answered
    store.unlocked.resolve(false); // the stale answer
    await flush();
    expect(ent.pro.value).toBe(true);
  });

  it('requirePro opens the paywall for the feature when locked, and does nothing when unlocked', async () => {
    const { ent, store } = make();
    expect(ent.requirePro('hint')).toBe(false);
    expect(ent.paywall.value).toEqual({ open: true, feature: 'hint' });
    ent.closePaywall();
    expect(ent.paywall.value).toEqual({ open: false, feature: 'hint' }); // kept while it slides away
    store.unlocked.resolve(true);
    await flush();
    expect(ent.requirePro('hint')).toBe(true);
    expect(ent.paywall.value.open).toBe(false);
  });

  it('loads the product (price) at start; tries again when the paywall opens after a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ent, store } = make();
    expect(ent.productState.value).toBe('loading');
    store.product.reject(new Error('offline'));
    await flush();
    expect(ent.productState.value).toBe('unavailable');
    expect(ent.product.value).toBeNull();
    store.product = deferred();
    ent.openPaywall();
    expect(store.getProductCalls).toBe(2);
    store.product.resolve(PRODUCT);
    await flush();
    expect(ent.productState.value).toBe('ready');
    expect(ent.product.value?.displayPrice).toBe('$9.99');
    ent.openPaywall();
    expect(store.getProductCalls).toBe(2); // known: not asked again
  });

  describe('buy()', () => {
    it('purchased: unlocks, caches, and the open paywall says thanks', async () => {
      const { ent, store, storage } = make();
      ent.openPaywall('coachExplanations');
      const p = ent.buy();
      expect(ent.status.value).toBe('buying');
      expect(ent.buy()).toBe(p); // one purchase at a time
      expect(store.purchases).toHaveLength(1);
      store.purchases[0].resolve('purchased');
      expect(await p).toBe('purchased');
      expect(ent.pro.value).toBe(true);
      expect(storage.getItem(PRO_CACHE_KEY)).toBe('1');
      expect(ent.status.value).toBe('success');
      ent.closePaywall();
      expect(ent.status.value).toBe('idle');
    });

    it('cancelled: back to idle, still locked', async () => {
      const { ent, store } = make();
      ent.openPaywall();
      const p = ent.buy();
      store.purchases[0].resolve('cancelled');
      expect(await p).toBe('cancelled');
      expect(ent.status.value).toBe('idle');
      expect(ent.pro.value).toBe(false);
    });

    it('pending (Ask to Buy): waits; the approval arrives through onChange', async () => {
      const { ent, store } = make();
      ent.openPaywall();
      const p = ent.buy();
      store.purchases[0].resolve('pending');
      expect(await p).toBe('pending');
      expect(ent.status.value).toBe('pending');
      expect(ent.pro.value).toBe(false);
      ent.closePaywall();
      expect(ent.status.value).toBe('pending'); // still waiting
      store.emit(true);
      expect(ent.pro.value).toBe(true);
      expect(ent.status.value).toBe('idle'); // the paywall is closed: the app shows a toast
    });

    it('failed (or the store threw): an error status; buying again retries', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ent, store } = make();
      ent.openPaywall();
      const p = ent.buy();
      store.purchases[0].resolve('failed');
      expect(await p).toBe('failed');
      expect(ent.status.value).toBe('failed');
      const q = ent.buy();
      store.purchases[1].reject(new Error('network'));
      expect(await q).toBe('failed');
      expect(ent.status.value).toBe('failed');
      const r = ent.buy();
      store.purchases[2].resolve('purchased');
      expect(await r).toBe('purchased');
      expect(ent.pro.value).toBe(true);
      // Reopening clears an old message.
      ent.closePaywall();
      ent.openPaywall();
      expect(ent.status.value).toBe('idle');
    });
  });

  describe('restore()', () => {
    it('restored: unlocks', async () => {
      const { ent, store } = make();
      ent.openPaywall();
      const p = ent.restore();
      expect(ent.status.value).toBe('restoring');
      store.restores[0].resolve('restored');
      expect(await p).toBe('restored');
      expect(ent.pro.value).toBe(true);
      expect(ent.status.value).toBe('success');
    });

    it('nothing to restore, or the store cannot be reached', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ent, store } = make();
      const p = ent.restore();
      store.restores[0].resolve('none');
      expect(await p).toBe('none');
      expect(ent.status.value).toBe('restoreNone');
      expect(ent.pro.value).toBe(false);
      const q = ent.restore();
      store.restores[1].resolve('failed'); // e.g. offline: not "nothing was bought"
      expect(await q).toBe('failed');
      expect(ent.status.value).toBe('restoreFailed');
      const r = ent.restore();
      store.restores[2].reject(new Error('offline'));
      expect(await r).toBe('failed');
      expect(ent.status.value).toBe('restoreFailed');
    });

    it('a cancelled sign-in says nothing', async () => {
      const { ent, store } = make();
      ent.openPaywall();
      const p = ent.restore();
      store.restores[0].resolve('cancelled');
      expect(await p).toBe('cancelled');
      expect(ent.status.value).toBe('idle');
      expect(ent.pro.value).toBe(false);
    });
  });

  describe('with the real NativePurchases', () => {
    /** A native "Store" plugin whose answers the test sets. */
    const plugin = (over: Partial<Record<keyof StorePlugin, () => Promise<unknown>>> = {}) =>
      ({
        getProduct: async () => PRODUCT,
        isUnlocked: async () => ({ unlocked: false }),
        purchase: async () => ({ result: 'purchased' }),
        restore: async () => ({ unlocked: false }),
        addListener: async () => ({ remove: async () => {} }),
        ...over,
      }) as unknown as StorePlugin;
    const withNative = (load: () => Promise<{ store: StorePlugin }>, cached = true) => {
      const storage = new MemoryStorage();
      if (cached) storage.setItem(PRO_CACHE_KEY, '1');
      const ent = createEntitlements({ enabled: true, purchases: new NativePurchases(load), storage });
      made.push(ent);
      return { ent, storage };
    };

    it('a missing or failing plugin keeps a paying player’s cached Pro (unknown is not "locked")', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const load of [
        () => Promise.reject(new Error('"Store" plugin is not implemented on ios')),
        async () => ({ store: plugin({ isUnlocked: () => Promise.reject(new Error('UNIMPLEMENTED')) }) }),
      ]) {
        const { ent, storage } = withNative(load);
        await flush();
        await flush();
        expect(ent.pro.value).toBe(true);
        expect(storage.getItem(PRO_CACHE_KEY)).toBe('1');
      }
    });

    it('the plugin’s own "not unlocked" answer still locks (e.g. refunded while closed)', async () => {
      const { ent, storage } = withNative(async () => ({ store: plugin() }));
      await flush();
      await flush();
      expect(ent.pro.value).toBe(false);
      expect(storage.getItem(PRO_CACHE_KEY)).toBeNull();
    });

    it('Restore: an App Store sync that failed or was cancelled is not "nothing to restore"', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cases: [{ unlocked: boolean; error?: string }, string, string][] = [
        [{ unlocked: false, error: 'The Internet connection appears to be offline.' }, 'failed', 'restoreFailed'],
        [{ unlocked: false, error: 'cancelled' }, 'cancelled', 'idle'],
        [{ unlocked: false }, 'none', 'restoreNone'],
        [{ unlocked: true, error: 'The Internet connection appears to be offline.' }, 'restored', 'success'],
      ];
      for (const [answer, result, status] of cases) {
        const { ent } = withNative(async () => ({ store: plugin({ restore: async () => answer }) }), false);
        ent.openPaywall();
        expect(await ent.restore()).toBe(result);
        expect(ent.status.value).toBe(status);
      }
      const { ent } = withNative(() => Promise.reject(new Error('no plugin')), false);
      expect(await ent.restore()).toBe('failed');
      expect(ent.status.value).toBe('restoreFailed');
    });
  });

  it('dispose stops following the store', async () => {
    const { ent, store } = make();
    ent.dispose();
    store.emit(true);
    store.unlocked.resolve(true);
    await flush();
    expect(ent.pro.value).toBe(false);
    expect(store.listeners.size).toBe(0);
  });
});
