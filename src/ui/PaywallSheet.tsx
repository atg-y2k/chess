/**
 * The paywall: what Pro unlocks, its price (from the store), Buy, Restore Purchases, and the
 * privacy policy and terms (App Review wants all of them next to a purchase). Also the lock glyphs
 * that mark Pro features elsewhere (`IconLock`, `LockedIcon`).
 */
import type { ComponentChild } from 'preact';
import { FEATURE_INFO, PRO_NAME, proFeatures, type ProFeature, type PurchaseStatus } from '../game/entitlements';
import { LEGAL_URLS } from '../native/platform';
import { Sheet } from './Sheet';
import './PaywallSheet.css';

export interface PaywallSheetProps {
  open: boolean;
  /** The feature the player tried to use (its line comes first and its row is marked), or null (Menu). */
  feature: ProFeature | null;
  /** The store's localized price (StoreKit `displayPrice`); null while loading or unavailable ("—"). */
  price: string | null;
  /** The store gave no product (offline, or not set up): the sheet says so; Buy still tries. */
  unavailable?: boolean;
  status: PurchaseStatus;
  onBuy: () => void;
  onRestore: () => void;
  /** Close button, backdrop, swipe down, Escape, and "Done" after a purchase. */
  onClose: () => void;
  /** The list (default: every Pro feature, see FEATURE_TIERS). */
  features?: readonly ProFeature[];
}

/** What stays free, so nobody buys Pro for something they already have. */
export const ALWAYS_FREE =
  'Always free: every opponent at any level, your rating, the evaluation bar, move ratings, accuracy, trying moves in the explorer, and browsing, stepping through and playing openings.';

/** The purchase terms under the list. */
export const PURCHASE_TERMS = ['One-time purchase', 'No subscription', 'Family Sharing'] as const;

/** The Buy button's label for a price (an en dash while the store has not given one). */
export function buyLabel(price: string | null): string {
  return `Unlock for ${price ?? '—'}`;
}

interface Message {
  text: string;
  tone: 'info' | 'error';
  retry?: 'buy' | 'restore';
}

/** The message over the Buy button for a status (null: none). */
export function paywallMessage(status: PurchaseStatus, unavailable = false): Message | null {
  switch (status) {
    case 'pending':
      return { text: 'Waiting for approval (Ask to Buy). Pro unlocks as soon as it’s approved.', tone: 'info' };
    case 'failed':
      return { text: 'The purchase didn’t go through.', tone: 'error', retry: 'buy' };
    case 'restoreNone':
      return { text: 'No earlier purchase of Pro was found for this Apple Account.', tone: 'info' };
    case 'restoreFailed':
      return { text: 'Couldn’t reach the App Store. Check your connection.', tone: 'error', retry: 'restore' };
    case 'idle':
      return unavailable ? { text: 'The App Store isn’t available right now. Check your connection.', tone: 'info' } : null;
    default:
      return null;
  }
}

/** The bottom sheet that sells Pro (open it with `Entitlements.openPaywall`). */
export function PaywallSheet({
  open,
  feature,
  price,
  unavailable = false,
  status,
  onBuy,
  onRestore,
  onClose,
  features = proFeatures(),
}: PaywallSheetProps) {
  const buying = status === 'buying';
  const restoring = status === 'restoring';
  const busy = buying || restoring;
  const done = status === 'success';
  const message = paywallMessage(status, unavailable);
  const lead = done
    ? 'Thank you! Every coaching feature is yours now.'
    : feature
      ? FEATURE_INFO[feature].context
      : 'Learn from every move you make.';

  const footer = (
    <div class="paywall-foot">
      {message && (
        <div
          class="paywall-msg"
          data-tone={message.tone}
          data-status={status}
          role={message.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{message.text}</span>
          {message.retry && (
            <button
              type="button"
              class="paywall-retry"
              data-id="paywall-retry"
              onClick={message.retry === 'buy' ? onBuy : onRestore}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {done ? (
        <button type="button" class="btn btn-primary paywall-buy" data-id="paywall-done" onClick={onClose}>
          Done
        </button>
      ) : (
        <button
          type="button"
          class="btn btn-primary paywall-buy"
          data-id="paywall-buy"
          disabled={busy}
          aria-busy={buying ? 'true' : undefined}
          onClick={onBuy}
        >
          {buying ? (
            <>
              <span class="paywall-spin" aria-hidden="true" />
              Purchasing…
            </>
          ) : (
            buyLabel(price)
          )}
        </button>
      )}
      {!done && (
        <button
          type="button"
          class="paywall-restore"
          data-id="paywall-restore"
          disabled={busy}
          aria-busy={restoring ? 'true' : undefined}
          onClick={onRestore}
        >
          {restoring ? 'Restoring…' : 'Restore Purchases'}
        </button>
      )}
      <p class="paywall-legal">
        <a href={LEGAL_URLS.privacy} target="_blank" rel="noopener noreferrer" data-id="paywall-privacy">
          Privacy Policy
        </a>
        <span aria-hidden="true">·</span>
        <a href={LEGAL_URLS.terms} target="_blank" rel="noopener noreferrer" data-id="paywall-terms">
          Terms of Use (EULA)
        </a>
      </p>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} title={`Unlock ${PRO_NAME}`} hideTitle class="paywall" footer={footer}>
      <div class="paywall-hero" data-done={done ? '' : undefined}>
        <div class="paywall-mark" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={68} height={68} />
          <span class="paywall-badge">{done ? <IconCheck size={16} /> : 'PRO'}</span>
        </div>
        <p class="paywall-title" aria-hidden="true">
          {done ? `${PRO_NAME} is unlocked` : `Unlock ${PRO_NAME}`}
        </p>
        <p class="paywall-lead" data-id="paywall-lead" role={done ? 'status' : undefined}>
          {lead}
        </p>
      </div>

      <ul class="paywall-list" aria-label={`What ${PRO_NAME} unlocks`}>
        {features.map((f) => (
          <li key={f} class="paywall-item" data-feature={f} data-current={f === feature ? '' : undefined}>
            <span class="paywall-check" aria-hidden="true">
              <IconCheck size={14} />
            </span>
            <span class="paywall-item-text">
              <span class="paywall-item-title">{FEATURE_INFO[f].title}</span>
              <span class="paywall-item-detail">{FEATURE_INFO[f].detail}</span>
            </span>
          </li>
        ))}
      </ul>

      <p class="paywall-terms" data-id="paywall-terms-line">
        {PURCHASE_TERMS.map((t, i) => (
          <span key={t}>
            {i > 0 && (
              <span class="paywall-dot" aria-hidden="true">
                {' · '}
              </span>
            )}
            {t}
          </span>
        ))}
      </p>
      <p class="paywall-free">{ALWAYS_FREE}</p>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ glyphs */

interface GlyphProps {
  size?: number;
  class?: string;
}

function IconCheck({ size = 16 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  );
}

/** A padlock (24x24 grid, stroke = currentColor), for Pro features that are locked. */
export function IconLock({ size = 24, class: cls }: GlyphProps) {
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
    </svg>
  );
}

/** An icon with a small lock badge on its corner (e.g. the toolbar's Hint while it is locked). */
export function LockedIcon({ children }: { children: ComponentChild }) {
  return (
    <span class="locked-icon">
      {children}
      <span class="locked-icon-badge" aria-hidden="true">
        <IconLock size={10} />
      </span>
    </span>
  );
}
