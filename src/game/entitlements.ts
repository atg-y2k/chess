/**
 * Chess Coach Pro: which features are free and which need Pro, whether Pro is unlocked, and the
 * paywall's state.
 *
 * The App Store app is a free download with one non-consumable in-app purchase, "Pro" (StoreKit 2,
 * Family Sharing on; see src/native/purchases.ts). `FEATURE_TIERS` below is the one place that says
 * which features need it. Everything else is always free and has no gate: every bot at any Elo, the
 * rating, the evaluation bar and graph, move-quality labels and badges, accuracy numbers, takebacks
 * and Retry.
 *
 * `paywallEnabled` (src/native/platform.ts) is true in the App Store app and in a web build made
 * with VITE_PAYWALL=1 (which uses a mock store, for tests). Otherwise, as in the PWA, everything is
 * allowed and no paywall, lock or Pro row shows.
 *
 * `pro` starts from the flag cached in localStorage (PRO_CACHE_KEY), so the first frame is already
 * right, then follows the store: `isUnlocked()` at start, `onChange` (refunds and revocations, Ask
 * to Buy approvals, purchases on another device), and the purchases and restores made here. The
 * cache only speeds up the first frame: the store's verified entitlement always wins.
 */
import { batch, computed, signal, type ReadonlySignal } from '@preact/signals';
import { APP_NAME, paywallEnabled } from '../native/platform';
import {
  getPurchases,
  type ProProduct,
  type PurchaseResult,
  type Purchases,
  type RestoreResult,
} from '../native/purchases';

export type { RestoreResult };

/** Features that can be sold as part of Pro. */
export type ProFeature =
  | 'coachExplanations'
  | 'hint'
  | 'showBest'
  | 'bestMoveArrows'
  | 'reviewDetails'
  | 'explorer'
  | 'openingGuides'
  | 'openingDrills';

export type Tier = 'free' | 'pro';

/**
 * THE free / Pro split: change a feature to 'free' here to give it away (its gate then never
 * shows). See the module comment for what is always free.
 */
export const FEATURE_TIERS: Readonly<Record<ProFeature, Tier>> = {
  /** The coach's plain-English "why" after each move (the class label and badge stay free). */
  coachExplanations: 'pro',
  /** The toolbar's Hint. */
  hint: 'pro',
  /** "Show best": the better move, with arrows and its explanation. */
  showBest: 'pro',
  /** The live best-move arrows option. */
  bestMoveArrows: 'pro',
  /** Game Review's key moments and per-move explanations (accuracy and counts stay free). */
  reviewDetails: 'pro',
  /** The explorer: try moves for both sides, with the engine's eval, arrows and ratings. */
  explorer: 'pro',
  /**
   * The Openings section's guide text: summaries, both sides' plans, traps, key variations and the
   * "why" of each move. Browsing, searching, the move tree, stepping through any line and playing
   * an opening stay free (see OPENINGS_FEATURE_TIERS in src/openings/index.ts).
   */
  openingGuides: 'pro',
  /** Drilling opening lines move by move, with saved progress and mastery. */
  openingDrills: 'pro',
};

/** The purchase's name as the player sees it, e.g. "Chess Coach Pro" (follows the app's name). */
export const PRO_NAME = `${APP_NAME} Pro`;

/** localStorage key of the cached "Pro is unlocked" flag ('1'); mirrored to native storage. */
export const PRO_CACHE_KEY = 'chesscoach.pro';

export interface FeatureInfo {
  /** Paywall bullet, e.g. "Hints". */
  title: string;
  /** What it gives, one line. */
  detail: string;
  /** The paywall's first line when this feature opened it. */
  context: string;
}

/** Paywall wording per feature (in the paywall's order). */
export const FEATURE_INFO: Readonly<Record<ProFeature, FeatureInfo>> = {
  coachExplanations: {
    title: 'The coach explains every move',
    detail: 'Why it’s good or bad, and what was better',
    context: 'Find out why each move is good or bad.',
  },
  hint: {
    title: 'Hints',
    detail: 'The best move and the idea behind it',
    context: 'Hints are part of Pro.',
  },
  showBest: {
    title: 'Show best',
    detail: 'The move you should have played, and why',
    context: 'Show best is part of Pro.',
  },
  bestMoveArrows: {
    title: 'Best-move arrows',
    detail: 'The engine’s top moves as you play',
    context: 'Best-move arrows are part of Pro.',
  },
  reviewDetails: {
    title: 'Full Game Review',
    detail: 'Key moments and coaching on every move',
    context: 'See the moments that decided the game.',
  },
  explorer: {
    title: 'Explorer',
    detail: 'Test your ideas with the engine’s verdict',
    context: 'Try moves before you play them.',
  },
  openingGuides: {
    title: 'Opening lessons',
    detail: 'Why every move is played, the plans and the traps',
    context: 'Learn why every move is played, and drill lines until you know them.',
  },
  openingDrills: {
    title: 'Opening drills',
    detail: 'Practice lines until you know them, with your progress saved',
    context: 'Drill lines until you know them, and learn why every move is played.',
  },
};

/** The paywall's list order. */
const FEATURE_ORDER: readonly ProFeature[] = [
  'coachExplanations',
  'hint',
  'showBest',
  'explorer',
  'bestMoveArrows',
  'reviewDetails',
  'openingGuides',
  'openingDrills',
];

/** The features sold as Pro, in the paywall's order. */
export function proFeatures(tiers: Readonly<Record<ProFeature, Tier>> = FEATURE_TIERS): ProFeature[] {
  return FEATURE_ORDER.filter((f) => tiers[f] === 'pro');
}

const NONE: ReadonlySet<ProFeature> = new Set();

/** The features locked right now: the Pro ones, while the paywall is on and Pro is not unlocked. */
export function lockedFeatures(
  enabled: boolean,
  pro: boolean,
  tiers: Readonly<Record<ProFeature, Tier>> = FEATURE_TIERS,
): ReadonlySet<ProFeature> {
  return enabled && !pro ? new Set(proFeatures(tiers)) : NONE;
}

/**
 * Where a purchase or restore stands (the paywall and the Menu show it):
 * 'buying' / 'restoring' while the store works; 'pending' = waiting for approval (Ask to Buy);
 * 'success' = just unlocked (the paywall thanks and closes); 'failed' = the purchase failed;
 * 'restoreNone' = nothing to restore; 'restoreFailed' = the store could not be reached (a cancelled
 * sign-in goes back to 'idle', with nothing to say).
 */
export type PurchaseStatus = 'idle' | 'buying' | 'restoring' | 'pending' | 'success' | 'failed' | 'restoreNone' | 'restoreFailed';

/** 'unavailable': the store gave no product (offline, or not set up); tried again when the paywall opens. */
export type ProductState = 'loading' | 'ready' | 'unavailable';

export interface PaywallState {
  open: boolean;
  /** The feature that opened it (its line comes first), or null (opened from the Menu). */
  feature: ProFeature | null;
}

export interface Entitlements {
  /** Pro is sold here (paywallEnabled). When false, everything is allowed and no Pro UI shows. */
  readonly enabled: boolean;
  /** Pro is unlocked (always true when not `enabled`). */
  readonly pro: ReadonlySignal<boolean>;
  /** The features locked right now (empty once Pro is unlocked, or when not `enabled`). */
  readonly locked: ReadonlySignal<ReadonlySet<ProFeature>>;
  readonly product: ReadonlySignal<ProProduct | null>;
  readonly productState: ReadonlySignal<ProductState>;
  readonly status: ReadonlySignal<PurchaseStatus>;
  readonly paywall: ReadonlySignal<PaywallState>;
  isAllowed(feature: ProFeature): boolean;
  /** True when `feature` may be used; else opens the paywall for it and returns false. */
  requirePro(feature: ProFeature): boolean;
  openPaywall(feature?: ProFeature | null): void;
  closePaywall(): void;
  /** Asks the store for the product (price) unless it is already known. */
  loadProduct(): Promise<void>;
  /** Buys Pro (one purchase at a time: a second call gets the first one's result). Never rejects. */
  buy(): Promise<PurchaseResult>;
  /** Restore Purchases: syncs with the store and checks again (see RestoreResult). Never rejects. */
  restore(): Promise<RestoreResult>;
  /** Stops listening to the store (tests). */
  dispose(): void;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface EntitlementsOptions {
  /** Sell Pro (default: paywallEnabled). */
  enabled: boolean;
  /** The store (default: getPurchases()); only used when enabled. */
  purchases?: Purchases;
  /** Where the flag is cached (default: localStorage; null = no cache). */
  storage?: KeyValue | null;
  tiers?: Readonly<Record<ProFeature, Tier>>;
}

function defaultStorage(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

function readCache(storage: KeyValue | null): boolean {
  try {
    return storage?.getItem(PRO_CACHE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCache(storage: KeyValue | null, unlocked: boolean): void {
  try {
    if (unlocked) storage?.setItem(PRO_CACHE_KEY, '1');
    else storage?.removeItem(PRO_CACHE_KEY);
  } catch {
    // Full or blocked storage: the store is asked again at the next start anyway.
  }
}

/** Statuses that are only news while the paywall that showed them is open. */
const TRANSIENT: ReadonlySet<PurchaseStatus> = new Set<PurchaseStatus>(['success', 'failed', 'restoreNone', 'restoreFailed']);

/** Creates the entitlement state (the app uses one, `getEntitlements()`; tests make their own). */
export function createEntitlements(opts: EntitlementsOptions): Entitlements {
  const enabled = opts.enabled;
  const tiers = opts.tiers ?? FEATURE_TIERS;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const pro = signal(enabled ? readCache(storage) : true);
  const locked = computed(() => lockedFeatures(enabled, pro.value, tiers));
  const product = signal<ProProduct | null>(null);
  const productState = signal<ProductState>('loading');
  const status = signal<PurchaseStatus>('idle');
  const paywall = signal<PaywallState>({ open: false, feature: null });

  const isAllowed = (feature: ProFeature): boolean => !locked.value.has(feature);

  if (!enabled) {
    productState.value = 'unavailable';
    return {
      enabled,
      pro,
      locked,
      product,
      productState,
      status,
      paywall,
      isAllowed,
      requirePro: () => true,
      openPaywall: () => {},
      closePaywall: () => {},
      loadProduct: () => Promise.resolve(),
      buy: () => Promise.resolve('failed'),
      restore: () => Promise.resolve('restored'),
      dispose: () => {},
    };
  }

  const store = opts.purchases ?? getPurchases();
  let disposed = false;
  /** Bumped by every newer piece of news about the entitlement, so a slower, older answer cannot undo it. */
  let version = 0;
  let buying: Promise<PurchaseResult> | null = null;
  let restoring: Promise<RestoreResult> | null = null;
  let loading: Promise<void> | null = null;

  const setPro = (unlocked: boolean): void => {
    version++;
    writeCache(storage, unlocked);
    batch(() => {
      pro.value = unlocked;
      // Unlocked (here, by Ask to Buy approval, or on another device): the open paywall says thanks.
      if (unlocked && status.value !== 'buying' && status.value !== 'restoring') {
        status.value = paywall.value.open ? 'success' : 'idle';
      }
    });
  };

  const loadProduct = (): Promise<void> => {
    if (disposed || productState.value === 'ready') return Promise.resolve();
    loading ??= (async () => {
      productState.value = 'loading';
      let p: ProProduct | null = null;
      try {
        p = await store.getProduct();
      } catch (e) {
        console.warn('[pro] could not load the product', e);
      }
      if (disposed) return;
      batch(() => {
        product.value = p;
        productState.value = p ? 'ready' : 'unavailable';
      });
    })().finally(() => {
      loading = null;
    });
    return loading;
  };

  const openPaywall = (feature: ProFeature | null = null): void => {
    if (disposed) return;
    batch(() => {
      paywall.value = { open: true, feature };
      if (TRANSIENT.has(status.value)) status.value = 'idle';
    });
    if (productState.value !== 'ready') void loadProduct();
  };

  const closePaywall = (): void => {
    batch(() => {
      // Keep the feature, so the sheet does not change while it slides away.
      if (paywall.value.open) paywall.value = { ...paywall.value, open: false };
      if (TRANSIENT.has(status.value)) status.value = 'idle';
    });
  };

  const buy = (): Promise<PurchaseResult> => {
    if (buying) return buying;
    if (disposed) return Promise.resolve('failed');
    status.value = 'buying';
    buying = (async (): Promise<PurchaseResult> => {
      let r: PurchaseResult;
      try {
        r = await store.purchase();
      } catch (e) {
        console.warn('[pro] purchase failed', e);
        r = 'failed';
      }
      if (disposed) return r;
      if (r === 'purchased') {
        setPro(true);
        status.value = paywall.value.open ? 'success' : 'idle';
      } else {
        // Approved later (Ask to Buy) or bought elsewhere: onChange unlocks it then.
        status.value = r === 'pending' ? 'pending' : r === 'failed' ? 'failed' : 'idle';
      }
      return r;
    })().finally(() => {
      buying = null;
    });
    return buying;
  };

  const restore = (): Promise<RestoreResult> => {
    if (restoring) return restoring;
    if (disposed) return Promise.resolve('failed');
    status.value = 'restoring';
    restoring = (async (): Promise<RestoreResult> => {
      let r: RestoreResult;
      try {
        r = await store.restore();
      } catch (e) {
        console.warn('[pro] restore failed', e);
        r = 'failed';
      }
      if (disposed) return r;
      if (r === 'restored') {
        setPro(true);
        status.value = paywall.value.open ? 'success' : 'idle';
      } else {
        // 'none' only when the App Store answered; a failed sync must not say "nothing was bought".
        status.value = r === 'none' ? 'restoreNone' : r === 'failed' ? 'restoreFailed' : 'idle';
      }
      return r;
    })().finally(() => {
      restoring = null;
    });
    return restoring;
  };

  // Confirm the cached flag, then follow the store's news.
  const first = version;
  store.isUnlocked().then(
    (unlocked) => {
      if (!disposed && version === first) setPro(unlocked);
    },
    (e: unknown) => console.warn('[pro] could not check the purchase; keeping the cached state', e),
  );
  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = store.onChange((unlocked) => {
      if (!disposed) setPro(unlocked);
    });
  } catch (e) {
    console.warn('[pro] cannot follow purchase updates', e);
  }
  void loadProduct();

  return {
    enabled,
    pro,
    locked,
    product,
    productState,
    status,
    paywall,
    isAllowed,
    requirePro(feature) {
      if (isAllowed(feature)) return true;
      openPaywall(feature);
      return false;
    },
    openPaywall,
    closePaywall,
    loadProduct,
    buy,
    restore,
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

let app: Entitlements | null = null;

/** The app's entitlements (created on first use: Pro is sold where `paywallEnabled`). */
export function getEntitlements(): Entitlements {
  app ??= createEntitlements({ enabled: paywallEnabled });
  return app;
}

/** Pro is unlocked (always true where Pro is not sold). */
export const pro: ReadonlySignal<boolean> = computed(() => getEntitlements().pro.value);

/** Whether `feature` may be used now. */
export const isAllowed = (feature: ProFeature): boolean => getEntitlements().isAllowed(feature);

/** True when `feature` may be used; else opens the paywall for it and returns false. */
export const requirePro = (feature: ProFeature): boolean => getEntitlements().requirePro(feature);

/** Buys Pro (see Entitlements.buy). */
export const buy = (): Promise<PurchaseResult> => getEntitlements().buy();

/** Restore Purchases (see Entitlements.restore). */
export const restore = (): Promise<RestoreResult> => getEntitlements().restore();
