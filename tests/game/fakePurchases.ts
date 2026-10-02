/** Test double for the StoreKit layer (src/native/purchases.ts contract): every answer is scripted. */
import type { ProProduct, PurchaseResult, Purchases, RestoreResult } from '../../src/native/purchases';

/** A promise that the test settles. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A scripted store: every call is a deferred the test settles (or a fixed answer). */
export class FakePurchases implements Purchases {
  unlocked = deferred<boolean>();
  product = deferred<ProProduct | null>();
  purchases: ReturnType<typeof deferred<PurchaseResult>>[] = [];
  restores: ReturnType<typeof deferred<RestoreResult>>[] = [];
  listeners = new Set<(unlocked: boolean) => void>();
  getProductCalls = 0;
  getProduct() {
    this.getProductCalls++;
    return this.product.promise;
  }
  isUnlocked() {
    return this.unlocked.promise;
  }
  purchase() {
    const d = deferred<PurchaseResult>();
    this.purchases.push(d);
    return d.promise;
  }
  restore() {
    const d = deferred<RestoreResult>();
    this.restores.push(d);
    return d.promise;
  }
  onChange(cb: (unlocked: boolean) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(unlocked: boolean) {
    for (const cb of this.listeners) cb(unlocked);
  }
}
