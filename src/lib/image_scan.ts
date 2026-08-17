import { RNPlugin, PluginRem, RemId, RichTextInterface } from '@remnote/plugin-sdk';
import { hasImagePowerupCode } from './consts';
import { SuppressionLease } from './operation_suppression';

/**
 * Scanning for images and marking what is found with the HasImage powerup.
 *
 * Why this exists: RemNote's search indexes text. An image element contributes
 * no searchable token, so neither Ctrl+F nor the query language can isolate the
 * images inside a document. Marking them with a tag turns the problem into one
 * RemNote's own document Filter — and Search Portals — already solve.
 *
 * An image is a rich-text element with `i: 'i'` (RICH_TEXT_ELEMENT_TYPE.IMAGE).
 * Both `text` and `backText` are checked, so an image sitting only on the back
 * of a flashcard still counts.
 */

/** What to walk: one rem's subtree, or every rem in the knowledge base. */
export type ImageScanScope = { kind: 'rem'; remId: RemId } | { kind: 'kb' };

export interface ImageScanResult {
  /** Rems visited. */
  scanned: number;
  /** Rems found to hold at least one image. */
  withImages: number;
  /** Rems that gained the tag on this run. */
  tagged: number;
  /** Rems that carried the tag but no longer hold an image, so it was removed. */
  untagged: number;
  /** Rems whose tag write threw; counted rather than aborting the whole scan. */
  failed: number;
  /** Where the wall clock actually went. */
  timing: ImageScanTiming;
}

/**
 * Where the time goes, split so a slow run can be attributed rather than
 * guessed at.
 *
 * This exists because a measured whole-KB run — 413,439 rems, 22,916 writes, ~90
 * minutes — matched none of the plausible explanations. Attributing it to the
 * writes implies ~234ms per addPowerup; attributing it to the event-loop yields
 * implies ~2.6s per yield, which is beyond even Chrome's worst timer throttling.
 * The observed rate was also near-CONSTANT per rem, which a write-bound loop
 * should not be: only 5.6% of rems are written and images cluster by document,
 * so throughput should visibly lump.
 *
 * A constant per-rem cost points instead at the supposedly-free part: the
 * synchronous predicate. If `getAll()` returns reactive proxies rather than
 * plain snapshots, then `rem.text` is not a field read and the "walk" is where
 * the time is. `walkMs` is what settles that.
 */
export interface ImageScanTiming {
  /** The bulk enumeration, before the walk starts. */
  collectMs: number;
  /** The one taggedRem() membership read. */
  membershipMs: number;
  /** Cumulative time inside addPowerup/removePowerup. */
  writeMs: number;
  /** How many writes that covers, so a per-write cost can be derived. */
  writeCount: number;
  /** Cumulative time parked in the event-loop yields, and how many there were. */
  yieldMs: number;
  yieldCount: number;
  /** Cumulative time renewing the suppression lease. */
  leaseMs: number;
  /**
   * Everything else in the loop — dominated by remHasImage. Derived by
   * subtraction rather than timed per rem, which keeps the measurement itself
   * off the hot path.
   */
  walkMs: number;
  /** Wall clock for the whole call. */
  totalMs: number;
}

export interface ImageTagRemovalResult {
  /** Rems that carried the tag within the scope, i.e. removal candidates. */
  considered: number;
  /** Rems the tag was actually taken off. */
  removed: number;
  /** Rems whose removal threw; counted rather than aborting the whole run. */
  failed: number;
  timing: ImageScanTiming;
}

/** Progress callback: a human-readable line, counts once the walk starts, and
 *  the running cost breakdown so a run can be diagnosed without finishing. */
export type ImageScanProgress = (
  message: string,
  done?: number,
  total?: number,
  timing?: ImageScanTiming
) => void;

/**
 * How often the walk yields to the event loop.
 *
 * Without a yield the popup's progress line never repaints — the scan holds the
 * widget's single thread from start to finish, which looks exactly like a hang.
 *
 * The count is high on purpose. `setTimeout(0)` is never actually 0: browsers
 * clamp it to ~4ms, and up to 1s under intensive throttling of a hidden frame.
 * At 200 the whole-KB run paid that toll 2,067 times, which in the throttled
 * case is over half an hour of pure waiting. The work between yields is
 * microseconds per rem, so 5,000 rems blocks the thread for single-digit
 * milliseconds — imperceptible — while cutting the toll 25x.
 */
const YIELD_EVERY = 5000;

/**
 * Progress cadence for a loop that writes on EVERY iteration (the removal pass).
 *
 * YIELD_EVERY is tuned for the scan, where iterations are sub-microsecond and
 * 5,000 of them pass in single-digit milliseconds. A removal loop spends ~10ms+
 * per iteration, so the same interval would leave the popup frozen for a minute
 * at a time. Reporting every few hundred writes keeps it alive while the yield
 * toll stays trivial next to the writes themselves.
 */
const PROGRESS_EVERY = 250;

/** A cheap monotonic clock, falling back to Date.now() where absent. */
const now = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/** Formats the breakdown for the progress line — the diagnostic output. */
export const formatScanTiming = (t: ImageScanTiming): string => {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const per = t.writeCount > 0 ? ` (${Math.round(t.writeMs / t.writeCount)}ms ea)` : '';
  return (
    `walk ${s(t.walkMs)} · ` +
    `writes ${t.writeCount} ${s(t.writeMs)}${per} · ` +
    `yields ${t.yieldCount} ${s(t.yieldMs)} · ` +
    `collect ${s(t.collectMs)} · tags ${s(t.membershipMs)}`
  );
};

/**
 * True when a rich text array holds at least one image element.
 *
 * RichTextInterface entries are either plain strings or element objects, so the
 * string case has to be excluded before reading `.i` — otherwise a rem whose
 * text is a bare string would throw on a property access.
 */
const richTextHasImage = (text: RichTextInterface | undefined): boolean =>
  !!text?.some((el) => typeof el !== 'string' && (el as { i?: string }).i === 'i');

/** True when the rem holds an image in its text or its back text. */
export const remHasImage = (rem: PluginRem): boolean =>
  richTextHasImage(rem.text) || richTextHasImage(rem.backText);

/**
 * Resolves the rems a scope covers.
 *
 * The whole-KB branch leans on `plugin.rem.getAll()`. That call has been removed
 * from the plugin API before and could be again (see lib/synced_key_audit.ts),
 * so the failure is re-thrown with a sentence the popup can show rather than
 * being left as an opaque bridge error.
 */
async function collectScopeRems(
  plugin: RNPlugin,
  scope: ImageScanScope,
  onProgress?: ImageScanProgress
): Promise<PluginRem[]> {
  if (scope.kind === 'kb') {
    onProgress?.('Enumerating every Rem in the knowledge base…');
    try {
      return await plugin.rem.getAll();
    } catch (e) {
      console.error('[ImageScan] plugin.rem.getAll() failed:', e);
      throw new Error(
        'RemNote would not enumerate the knowledge base (plugin.rem.getAll is unavailable in this build). Scan a document instead.'
      );
    }
  }

  const root = await plugin.rem.findOne(scope.remId);
  if (!root) throw new Error('The Rem to scan no longer exists.');
  onProgress?.('Collecting descendants…');
  return [root, ...(await root.getDescendants())];
}

/**
 * Walks the scope, applying the HasImage powerup to every rem that holds an
 * image and removing it from every rem in the same scope that carries the tag
 * but no longer holds one — so re-running after deleting an image leaves no
 * stale marks behind.
 *
 * Membership is resolved with ONE `taggedRem()` call rather than a `hasPowerup`
 * per rem: the latter is a round trip across the plugin bridge for every rem in
 * the scope, which is exactly the pattern that saturates it on large subtrees.
 * Only rems whose state actually changes are written to.
 *
 * With a `rem` scope, rems outside the subtree are never touched, so tags
 * applied to other documents survive a scan run here.
 */
export async function scanAndTagImages(
  plugin: RNPlugin,
  scope: ImageScanScope,
  onProgress?: ImageScanProgress
): Promise<ImageScanResult> {
  const t0 = now();
  const timing: ImageScanTiming = {
    collectMs: 0,
    membershipMs: 0,
    writeMs: 0,
    writeCount: 0,
    yieldMs: 0,
    yieldCount: 0,
    leaseMs: 0,
    walkMs: 0,
    totalMs: 0,
  };

  const tCollect = now();
  const rems = await collectScopeRems(plugin, scope, onProgress);
  timing.collectMs = now() - tCollect;

  // One read of the tag's current members, turned into a set for O(1) tests.
  const tMembership = now();
  const powerup = await plugin.powerup.getPowerupByCode(hasImagePowerupCode);
  const alreadyTagged = new Set(
    powerup ? (await powerup.taggedRem()).map((r) => r._id) : []
  );
  timing.membershipMs = now() - tMembership;

  const result: ImageScanResult = {
    scanned: rems.length,
    withImages: 0,
    tagged: 0,
    untagged: 0,
    failed: 0,
    timing,
  };

  // Every tag write fires GlobalRemChanged straight back into this plugin's own
  // listener, which per event costs a findOne, session reads, and a debounced
  // tail — work that is pointless for a write we just made ourselves. Every
  // other bulk operation here suppresses it (tracker.ts, extract.ts,
  // priority_bands.ts, outline_restructure.ts); this one did not.
  //
  // A renewable lease rather than a bare `true`, because this scan runs in a
  // popup the user is invited to close, and a torn-down iframe never reaches the
  // `finally`. See lib/operation_suppression.ts.
  const lease = new SuppressionLease(plugin);
  const tLeaseStart = now();
  await lease.start();
  timing.leaseMs += now() - tLeaseStart;

  try {
    const tLoop = now();
    for (let i = 0; i < rems.length; i++) {
      if (i % YIELD_EVERY === 0) {
        onProgress?.(`Scanning ${i} / ${rems.length} Rems…`, i, rems.length, {
          ...timing,
          // Derived live so an aborted run is still diagnosable: everything in
          // the loop that is not a write, a yield, or a lease renewal.
          walkMs: now() - tLoop - timing.writeMs - timing.yieldMs - timing.leaseMs,
          totalMs: now() - t0,
        });

        const tYield = now();
        await new Promise((r) => setTimeout(r, 0));
        timing.yieldMs += now() - tYield;
        timing.yieldCount++;

        // Cheap: only writes when the renewal interval has elapsed.
        const tLease = now();
        await lease.renew();
        timing.leaseMs += now() - tLease;
      }

      const rem = rems[i];
      const hasImage = remHasImage(rem);
      const isTagged = alreadyTagged.has(rem._id);
      if (hasImage) result.withImages++;

      // Already in the right state — no write, which is what keeps a re-run cheap.
      if (hasImage === isTagged) continue;

      const tWrite = now();
      try {
        if (hasImage) {
          await rem.addPowerup(hasImagePowerupCode);
          result.tagged++;
        } else {
          await rem.removePowerup(hasImagePowerupCode);
          result.untagged++;
        }
      } catch (e) {
        result.failed++;
        console.error('[ImageScan] tag write failed for', rem._id, e);
      }
      timing.writeMs += now() - tWrite;
      timing.writeCount++;
    }

    timing.walkMs =
      now() - tLoop - timing.writeMs - timing.yieldMs - timing.leaseMs;
  } finally {
    await lease.release();
  }

  timing.totalMs = now() - t0;
  console.log(`[ImageScan] ${formatScanTiming(timing)} · total ${(timing.totalMs / 1000).toFixed(1)}s`);

  onProgress?.(`Scanned ${rems.length} Rems.`, rems.length, rems.length, timing);
  return result;
}

/**
 * Takes the HasImage tag off every rem that carries it within the scope.
 *
 * The cleanup half of the feature: the scan can mark 20k+ rems, and a user who
 * decides they no longer want the tag has no way to undo that in bulk from
 * RemNote's own UI. Nothing is lost — the tag is derived from the images
 * themselves, so re-running the scan rebuilds it exactly, which is also why this
 * needs no undo of its own. Same relationship "Remove All Priority Band Tags"
 * has to "Refresh Priority Badges".
 *
 * Membership comes from ONE `taggedRem()` call, so a whole-KB cleanup never
 * enumerates the knowledge base at all — it asks the tag who its members are.
 * Only a rem-scoped cleanup pays for a descendant walk, and even then just to
 * build the set it intersects against.
 *
 * Deliberately uses `removePowerup` rather than `removeTag(powerup._id)`, even
 * though the latter skips a code→rem resolution per write and is likely faster.
 * The point of this run is to measure the write cost against the tagging pass on
 * equal terms; changing the write API at the same time would leave two variables
 * moving at once, and the per-write cost is the open question here.
 */
export async function removeImageTags(
  plugin: RNPlugin,
  scope: ImageScanScope,
  onProgress?: ImageScanProgress
): Promise<ImageTagRemovalResult> {
  const t0 = now();
  const timing: ImageScanTiming = {
    collectMs: 0,
    membershipMs: 0,
    writeMs: 0,
    writeCount: 0,
    yieldMs: 0,
    yieldCount: 0,
    leaseMs: 0,
    walkMs: 0,
    totalMs: 0,
  };

  onProgress?.('Finding tagged Rems…');
  const tMembership = now();
  const powerup = await plugin.powerup.getPowerupByCode(hasImagePowerupCode);
  let tagged: PluginRem[] = powerup ? await powerup.taggedRem() : [];
  timing.membershipMs = now() - tMembership;

  // A rem scope narrows the tagged list to the subtree. The descendant walk is
  // the only reason to touch the knowledge base here, and its result is used
  // purely as a membership set.
  if (scope.kind === 'rem') {
    const tCollect = now();
    const inScope = new Set((await collectScopeRems(plugin, scope, onProgress)).map((r) => r._id));
    timing.collectMs = now() - tCollect;
    tagged = tagged.filter((r) => inScope.has(r._id));
  }

  const result: ImageTagRemovalResult = {
    considered: tagged.length,
    removed: 0,
    failed: 0,
    timing,
  };

  // Same reasoning as the tagging pass: every removal fires GlobalRemChanged
  // back into this plugin's own listener, and this popup may be closed mid-run.
  const lease = new SuppressionLease(plugin);
  const tLeaseStart = now();
  await lease.start();
  timing.leaseMs += now() - tLeaseStart;

  try {
    const tLoop = now();
    for (let i = 0; i < tagged.length; i++) {
      if (i % YIELD_EVERY === 0 || i % PROGRESS_EVERY === 0) {
        onProgress?.(`Removing ${i} / ${tagged.length} tags…`, i, tagged.length, {
          ...timing,
          walkMs: now() - tLoop - timing.writeMs - timing.yieldMs - timing.leaseMs,
          totalMs: now() - t0,
        });
      }

      // Unlike the scan, EVERY iteration here writes, so the loop cannot run
      // long without yielding and the progress line would otherwise sit still
      // for the whole run. Yielding on the progress cadence rather than
      // YIELD_EVERY costs a few ms of timer clamp per few hundred writes —
      // negligible against a write, and it keeps the popup repainting.
      if (i > 0 && i % PROGRESS_EVERY === 0) {
        const tYield = now();
        await new Promise((r) => setTimeout(r, 0));
        timing.yieldMs += now() - tYield;
        timing.yieldCount++;

        const tLease = now();
        await lease.renew();
        timing.leaseMs += now() - tLease;
      }

      const tWrite = now();
      try {
        await tagged[i].removePowerup(hasImagePowerupCode);
        result.removed++;
      } catch (e) {
        result.failed++;
        console.error('[ImageScan] tag removal failed for', tagged[i]._id, e);
      }
      timing.writeMs += now() - tWrite;
      timing.writeCount++;
    }

    timing.walkMs = now() - tLoop - timing.writeMs - timing.yieldMs - timing.leaseMs;
  } finally {
    await lease.release();
  }

  timing.totalMs = now() - t0;
  console.log(
    `[ImageScan] removal: ${formatScanTiming(timing)} · total ${(timing.totalMs / 1000).toFixed(1)}s`
  );

  onProgress?.(`Removed ${result.removed} tags.`, tagged.length, tagged.length, timing);
  return result;
}
