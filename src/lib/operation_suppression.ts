// lib/operation_suppression.ts
//
// Reading and writing the `plugin_operation_active` session flag, which tells
// the GlobalRemChanged listener in register/events.ts to stand down while this
// plugin is making bulk writes of its own.
//
// WHY A LEASE EXISTS ALONGSIDE THE BOOLEAN
//
// Every existing caller sets the flag to `true`, does its writes, and clears it
// in a `finally` — tracker.ts, extract.ts, priority_bands.ts, outline_restructure.ts.
// That is safe because those jobs run to completion inside the realm that
// started them.
//
// It is NOT safe for a job that can be killed mid-flight. The image scan runs
// inside a popup whose own copy tells the user they may close it, and closing a
// popup tears the iframe down — the `finally` never runs, and the flag stays
// `true` for the rest of the session. The GlobalRemChanged listener would then
// be silently dead: no history capture, no powerup-removal detection, no
// inheritance cascade, with nothing on screen to suggest anything is wrong.
//
// So a long or interruptible job writes a DEADLINE (an epoch ms number) instead
// of `true`, and renews it as it works. If the job dies, suppression expires on
// its own within one lease period.
//
// WHY THE SAME KEY RATHER THAN A SECOND ONE
//
// The listener's suppression check sits above the debounce on a path that fires
// thousands of times a session, and it already costs one session read. A second
// key would double that. Overloading the value's TYPE keeps it at one read, and
// every boolean caller keeps working untouched.
//
// THE SHARED-KEY CAVEAT (pre-existing, not introduced here)
//
// One key means concurrent jobs can clobber each other: a boolean caller
// finishing its `finally` writes `false` and cancels a lease that is still in
// use. That race already exists between the boolean callers themselves. It is
// tolerable because the consequence is un-suppression — extra listener work,
// not lost work — and because these jobs are user-initiated and do not normally
// overlap.

import { RNPlugin } from '@remnote/plugin-sdk';

export const OPERATION_ACTIVE_KEY = 'plugin_operation_active';

/**
 * How far ahead a renewal pushes the deadline.
 *
 * Sized to comfortably exceed the gap between renewals rather than the length
 * of the job: a scan renews as it walks, so this bounds only how long a DEAD
 * job leaves the listener suppressed. 120s against a 30s renewal interval
 * leaves 4x headroom, so a chunk running long — or a main thread stalled by
 * something else in the app — cannot make suppression flicker off mid-run.
 */
export const SUPPRESSION_LEASE_MS = 120_000;

/** How often a running job pushes the deadline forward. Wall-clock, so the
 *  cadence does not depend on how fast the job happens to be moving. */
export const SUPPRESSION_RENEW_INTERVAL_MS = 30_000;

/**
 * Interprets the flag's value. `true` suppresses indefinitely (the legacy
 * shape); a number suppresses only until that instant has passed.
 */
export const isSuppressionActive = (flag: boolean | number | null | undefined): boolean =>
  typeof flag === 'number' ? Date.now() < flag : !!flag;

/**
 * Reads and interprets the flag in one call — the form the listener uses, so
 * both of its check sites stay in step.
 */
export async function isOperationSuppressed(plugin: RNPlugin): Promise<boolean> {
  const flag = await plugin.storage.getSession<boolean | number>(OPERATION_ACTIVE_KEY);
  return isSuppressionActive(flag);
}

/**
 * A renewable suppression lease for a long or interruptible job.
 *
 * `renew()` is cheap to call on every iteration: it writes only when the
 * interval has elapsed, so the session-write rate is bounded at one per
 * SUPPRESSION_RENEW_INTERVAL_MS however often it is called.
 */
export class SuppressionLease {
  private lastWrite = 0;

  constructor(private plugin: RNPlugin) {}

  /** Takes the lease. Call before the first write. */
  async start(): Promise<void> {
    await this.write();
  }

  /** Pushes the deadline forward if the interval has elapsed. Safe on a hot path. */
  async renew(): Promise<void> {
    if (Date.now() - this.lastWrite < SUPPRESSION_RENEW_INTERVAL_MS) return;
    await this.write();
  }

  /**
   * Releases the lease. Clears to `false` rather than to a past deadline so the
   * stored value matches what every other caller leaves behind.
   */
  async release(): Promise<void> {
    await this.plugin.storage.setSession(OPERATION_ACTIVE_KEY, false);
  }

  private async write(): Promise<void> {
    this.lastWrite = Date.now();
    await this.plugin.storage.setSession(OPERATION_ACTIVE_KEY, Date.now() + SUPPRESSION_LEASE_MS);
  }
}
