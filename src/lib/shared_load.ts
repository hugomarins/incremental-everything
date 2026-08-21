/**
 * A one-slot in-flight cache for an expensive load.
 *
 * The Study Dashboard's data load is period- and filter-independent: the same
 * bytes answer every period. Without this, changing a filter *while* the load
 * runs starts a second full load, and the first one's result is thrown away
 * when its run turns out to be stale — so the progress bar restarts from zero
 * and the knowledge base is walked twice.
 *
 * Callers share the promise instead: the second asker joins the load already
 * running, and whoever wins the race, the result lands in the slot for
 * everyone. Same idea as the in-flight ancestor-chain cache inside
 * `loadGlobalData`, one level up.
 *
 * A rejected load clears itself, or every later caller would inherit the
 * failure forever with no way to retry.
 */
export interface SharedLoadSlot<T> {
    key: string | null;
    promise: Promise<T> | null;
}

export function emptySlot<T>(): SharedLoadSlot<T> {
    return { key: null, promise: null };
}

/**
 * The load in flight (or a fresh one) for `key`. A different key supersedes the
 * slot: the previous load keeps running for whoever already awaits it, but no
 * new caller joins it.
 */
export function sharedLoad<T>(
    slot: SharedLoadSlot<T>,
    key: string,
    load: () => Promise<T>
): Promise<T> {
    if (slot.promise && slot.key === key) return slot.promise;
    const promise = load();
    slot.key = key;
    slot.promise = promise;
    promise.catch(() => {
        // Only clear if nothing has superseded this load in the meantime.
        if (slot.promise === promise) {
            slot.promise = null;
            slot.key = null;
        }
    });
    return promise;
}
