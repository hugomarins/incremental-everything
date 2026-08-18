// lib/card_priority/legacy_slot_cleanup.ts
//
// Clears the values the hidden-slot migration left behind in the deprecated
// VISIBLE `priority` slot.
//
// WHY THIS EXISTS
//
// The migration deleted the visible property CHILD on every tagged rem, on the
// assumption that a visible slot's value IS that child and dies with it. It is
// not. Measured on a migrated knowledge base days later:
//
//   getPowerupProperty(cardPriority, 'priority')   → "30"   (pre-migration rem)
//   getPowerupProperty(cardPriority, 'priorityValue') → "25"   (the live value)
//   …and on a rem created AFTER the migration, the same visible read → empty.
//
// So the row is gone from the outline while the number stays on the rem, frozen
// at whatever it was when the migration ran. That is a second, silently
// diverging copy of every priority in the knowledge base.
//
// It is harmless only while the visible slot is retired, because
// rawCardPriorityReads then skips it. The moment it is read again — a realm that
// has not warmed the retired flag, an undo, a future reader that forgets — the
// fallback resurrects a stale number for any rem whose hidden slot is empty.
//
// WHY THIS IS A SEPARATE PASS AND NOT PART OF THE MIGRATION
//
// The migration cannot run here at all: it resolves the visible slot DEFINITION
// rem first (it has to, to identify the property children it deletes), and on a
// retired knowledge base that resolution returns nothing and the run aborts by
// design. This pass never asks for the slot definition. It works purely through
// getPowerupProperty / setPowerupProperty on slot CODES, which the evidence above
// shows still resolve after retirement.
//
// A RETIRED SLOT CAN BE READ AND NOT WRITTEN — MEASURED
//
// Reads on a retired slot demonstrably work, so writes plausibly might too. They
// do not. Probed on a 45k-rem library: setPowerupProperty on the retired code
// did NOT throw — it returned normally, RemNote showed the user a toast
// ("Plugin … attempted to setPowerupProperty for a slot which doesn't exist"),
// and the read-back still returned the old number. A silent no-op is the worst
// shape this could have taken, which is why {@link probeLegacyPrioritySlotWrite}
// clears exactly ONE rem and reads it back before anything else is touched: the
// wrong assumption costs one rem, not a 45,000-rem pass that appears to work and
// changes nothing.
//
// AND RE-REGISTERING DOES NOT GIVE THEM BACK — IT ORPHANS THEM
//
// The obvious repair is to register the slot again and clear the values through
// it. Tried, 18/08/2026, and it does something else entirely: slot values bind to
// the slot DEFINITION REM, not to the code string. The old definition rem was
// gone (the powerup's slot children were Priority Source and Last Updated only,
// with no Priority among them, while reads still returned values), so
// re-registering minted a NEW one — `getPowerupSlotByCode` returned an id that
// had never been seen before — and the code now resolves to that empty slot. The
// rem that read "30" before the reload read empty after it, with nothing written.
//
// The leftovers are therefore not clearable on a retired knowledge base; they are
// ORPHANED by the act of trying, which reaches the same end state by a different
// route: nothing can read them, and nothing can write them. The three-step flow
// the command drives (un-retire → reload → run again → re-retire) is still the
// right sequence, but what it actually does on such a KB is orphan-then-verify,
// and the second run correctly reports nothing left to clear.
//
// Where the pass does real work is a knowledge base migrated but NOT yet retired:
// there the slot definition rem is the original one, the values are genuinely
// reachable, and clearing them is a clearing.
//
// SAFETY
//
// A rem is only cleared when the hidden slot holds a value — the visible number
// must never be the last copy. Where it IS the last copy (hidden empty, visible
// set) the value is RESCUED first: written to the hidden slot, read back, and
// only then cleared, which is the same order the migration uses and for the same
// reason.

import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { CARD_PRIORITY_CODE, PRIORITY_SLOT, PRIORITY_VALUE_SLOT } from './types';
import {
  patchHiddenSlotRecord,
  readHiddenSlotRecord,
  isVisiblePrioritySlotRetired,
  unretireVisiblePrioritySlot,
  markHiddenSlotMigrationComplete,
} from './slot_access';
import {
  captureCardPrioritySnapshot,
  downloadCardPrioritySnapshotFile,
  loadSnapshot,
} from '../card_priority_snapshot';

const LOG = '[CardPriority legacy-slot]';

/** Rems per batch. Matches the migration: reads overlap freely, writes do not. */
const BATCH = 50;

/**
 * The probe walks the WHOLE population looking for its candidate, stopping at the
 * first hit.
 *
 * It used to stop after 2,000 rems, which produced a false "this knowledge base
 * has none": `taggedRem()` order is not related to age, so a run of rems with no
 * leftover says nothing about the rest. Reads run at roughly 1,800/s, so even a
 * fruitless full walk of 45,000 rems is under a minute — cheap enough that the
 * probe should answer the question properly rather than sample it.
 *
 * A walk that finds nothing is therefore evidence, not a shrug: it means the slot
 * is genuinely empty across the knowledge base.
 */

async function taggedRems(plugin: RNPlugin): Promise<PluginRem[]> {
  const powerup = await plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE);
  return ((await powerup?.taggedRem()) || []) as PluginRem[];
}

function readBothSlots(rem: PluginRem): Promise<[string | null, string | null]> {
  return Promise.all([
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT).catch(() => null),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT).catch(() => null),
  ]) as Promise<[string | null, string | null]>;
}

// ── The probe ───────────────────────────────────────────────────────────────

export interface LegacyWriteProbe {
  /** A rem carrying a leftover was found and the clear was attempted. */
  attempted: boolean;
  remId: string | null;
  /** What the visible slot held before the clear. */
  before: string | null;
  /** What it held after — empty means the write landed. */
  after: string | null;
  /** The hidden value, which had to be present for this rem to be chosen. */
  hidden: string | null;
  /** How many rems were walked to find the candidate. */
  scanned: number;
  /** Rems seen carrying ANY value in the deprecated slot, candidate or not. */
  leftoversSeen: number;
  /** Of those, ones whose hidden slot is empty — the value's only copy, so the
   *  probe will not experiment on them. */
  rescueOnlySeen: number;
  cleared: boolean;
  error?: string;
  verdict: string;
}

/**
 * Clears ONE rem's leftover and reads it back, to establish whether a retired
 * slot can be written at all.
 *
 * Chooses a rem whose hidden slot already holds a value, so the attempt cannot
 * cost anything even if it half-works. Nothing is restored on success: a cleared
 * leftover is the desired end state, not a side effect to undo.
 */
export async function probeLegacyPrioritySlotWrite(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<LegacyWriteProbe> {
  const probe: LegacyWriteProbe = {
    attempted: false,
    remId: null,
    before: null,
    after: null,
    hidden: null,
    scanned: 0,
    leftoversSeen: 0,
    rescueOnlySeen: 0,
    cleared: false,
    verdict: '',
  };

  const tagged = await taggedRems(plugin);
  for (let i = 0; i < tagged.length; i += BATCH) {
    const batch = tagged.slice(i, i + BATCH);
    const values = await Promise.all(batch.map((rem) => readBothSlots(rem)));
    probe.scanned += batch.length;
    // Counted whether or not a candidate turns up, so a walk that ends without one
    // can say WHY: no leftovers at all, or leftovers that all need a rescue.
    probe.leftoversSeen += values.filter(([, visible]) => !!visible).length;
    probe.rescueOnlySeen += values.filter(([hidden, visible]) => !!visible && !hidden).length;

    const hit = values.findIndex(([hidden, visible]) => !!visible && !!hidden);
    if (hit === -1) {
      onProgress?.(`Looking for a leftover: ${probe.scanned}/${tagged.length}`);
      continue;
    }

    const rem = batch[hit];
    const [hidden, visible] = values[hit];
    probe.attempted = true;
    probe.remId = rem._id;
    probe.before = visible;
    probe.hidden = hidden;

    try {
      await rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, []);
    } catch (err) {
      probe.error = String(err);
    }
    // Read back through a FRESH handle: a rem object is a snapshot taken when it
    // was fetched, so the one we just wrote through can report the pre-write
    // value and turn a working write into a false negative.
    const fresh = await plugin.rem.findOne(rem._id).catch(() => undefined);
    const [hiddenAfter, visibleAfter] = fresh
      ? await readBothSlots(fresh)
      : [hidden, visible];
    probe.after = visibleAfter;
    probe.cleared = !visibleAfter;

    // The hidden value is re-read too: the one number that must NOT change.
    if (hiddenAfter !== hidden) {
      probe.verdict =
        `DO NOT PROCEED: clearing the visible slot on ${rem._id} also changed the hidden ` +
        `value (${hidden} → ${hiddenAfter ?? 'empty'}). The two slots are not independent on ` +
        `this build.`;
      return probe;
    }

    probe.verdict = probe.cleared
      ? `The write lands: ${rem._id} held "${visible}" in the retired slot and now holds ` +
        `nothing, with its real priority (${hidden}) untouched.`
      : `The write does NOT land: ${rem._id} still reads "${probe.after}" after being cleared` +
        (probe.error
          ? ` (setPowerupProperty threw: ${probe.error})`
          : ' (setPowerupProperty returned without error — a silent no-op)') +
        `. A retired slot can be read but not written, so the values are only reachable while ` +
        `the slot is registered again.`;
    return probe;
  }

  probe.verdict =
    probe.rescueOnlySeen > 0
      ? `All ${probe.rescueOnlySeen} leftover(s) found across ${probe.scanned} tagged rem(s) are ` +
        `the ONLY copy of their value — their hidden slot is empty. The probe will not experiment ` +
        `on those; the full pass moves each value across and verifies it before clearing.`
      : `Nothing to clear: none of the ${probe.scanned} tagged rem(s) holds a value in the old ` +
        `visible slot. Every one of them was read, so this is the whole knowledge base, not a ` +
        `sample.`;
  return probe;
}

// ── The sweep ───────────────────────────────────────────────────────────────

export interface LegacyCleanupReport {
  /** Tagged rems walked. */
  scanned: number;
  /** Carried a value in the deprecated visible slot. */
  withLeftover: number;
  /** Cleared, verified by a read-back. */
  cleared: number;
  /** The visible slot held the ONLY copy: moved to the hidden slot, then cleared. */
  rescued: number;
  /** Cleared, but the read-back still showed the old value. Left as they are. */
  didNotStick: number;
  /** A rescue whose hidden write did not read back — the visible value is KEPT. */
  rescueFailed: number;
  errors: number;
  errorSamples: string[];
  verdict: string;
}

/**
 * Walks every tagged rem and empties the deprecated visible slot.
 *
 * Read-then-write per rem, and only rems that actually carry a leftover are
 * written — on a knowledge base whose migration was clean this is a read-only
 * pass over the population, which is the common case and must not cost 45,000
 * pointless writes.
 */
export async function clearLegacyPriorityValues(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<LegacyCleanupReport> {
  const tagged = await taggedRems(plugin);

  let withLeftover = 0;
  let cleared = 0;
  let rescued = 0;
  let didNotStick = 0;
  let rescueFailed = 0;
  let errors = 0;
  const errorSamples: string[] = [];

  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (let i = 0; i < tagged.length; i += BATCH) {
      const batch = tagged.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (rem) => {
          try {
            const [hidden, visible] = await readBothSlots(rem);
            if (!visible) return; // nothing left behind on this one
            withLeftover++;

            // The visible slot holds the only copy. Move it before removing it —
            // same order as the migration, and for the same reason: a write that
            // did not land must not cost the value.
            if (!hidden) {
              await rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT, [visible]);
              const check = await rem
                .getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT)
                .catch(() => null);
              if (check !== visible) {
                rescueFailed++;
                if (errorSamples.length < 10) {
                  errorSamples.push(
                    `${rem._id}: rescue write read back as ${check ?? 'empty'} — visible value kept`
                  );
                }
                return;
              }
            }

            await rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, []);
            const fresh = await plugin.rem.findOne(rem._id).catch(() => undefined);
            const after = fresh
              ? await fresh.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT).catch(() => null)
              : null;
            if (after) {
              didNotStick++;
              if (errorSamples.length < 10) {
                errorSamples.push(`${rem._id}: still reads "${after}" after being cleared`);
              }
              return;
            }
            if (hidden) cleared++;
            else rescued++;
          } catch (err) {
            errors++;
            if (errorSamples.length < 10) errorSamples.push(`${rem._id}: ${err}`);
          }
        })
      );
      if (i % (BATCH * 10) === 0) {
        onProgress?.(`Clearing: ${Math.min(i + BATCH, tagged.length)}/${tagged.length}`);
      }
    }
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }

  const clean = didNotStick === 0 && rescueFailed === 0 && errors === 0;
  if (clean && withLeftover > 0) {
    // Recorded so the debug panel can say the knowledge base is clean, and so a
    // second run has something to report other than "found nothing".
    await patchHiddenSlotRecord(plugin, {
      legacyValuesClearedAt: Date.now(),
      legacyValuesCleared: cleared + rescued,
    }).catch(() => undefined);
  }

  const notes: string[] = [];
  if (rescued > 0) {
    notes.push(
      `${rescued} rem(s) had the number ONLY in the old slot; it was moved to the hidden slot ` +
        `and verified before the old one was emptied.`
    );
  }
  if (rescueFailed > 0) {
    notes.push(`${rescueFailed} rescue write(s) did not read back; those kept their old value.`);
  }
  if (didNotStick > 0) {
    notes.push(
      `${didNotStick} rem(s) still read the old number after being cleared — the write did not ` +
        `land on them.`
    );
  }

  const verdict =
    `Walked ${tagged.length} tagged rem(s): ${withLeftover} carried a leftover in the old ` +
    `visible slot, ${cleared + rescued} were cleared.` +
    (notes.length ? ' ' + notes.join(' ') : ' Nothing failed.');

  console.log(`${LOG} ${verdict}`);

  return {
    scanned: tagged.length,
    withLeftover,
    cleared,
    rescued,
    didNotStick,
    rescueFailed,
    errors,
    errorSamples,
    verdict,
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface LegacyCleanupRunResult {
  probe: LegacyWriteProbe;
  report: LegacyCleanupReport | null;
  backupNote: string;
  aborted?: string;
  /** The slot is retired, so nothing can be written until it is registered again.
   *  The command turns this into the offer to un-retire and reload. */
  needsUnretire?: boolean;
  /** This run put the retirement back, so the caller must ask for a reload. */
  reRetired?: boolean;
}

/**
 * Step one of the three-step flow: registers the deprecated slot again, leaving
 * the migration itself alone.
 *
 * Separate from the run because it needs a RELOAD to take effect — slots are
 * registered at activation — and because opening that window is a decision with a
 * visible cost, not a detail of the cleanup.
 */
export async function unretireForLegacyCleanup(plugin: RNPlugin): Promise<void> {
  await unretireVisiblePrioritySlot(plugin);
  console.log(`${LOG} visible slot un-retired for cleanup; reload required before it registers.`);
}

/**
 * Backup, probe one rem, then sweep — the only entry point callers should use.
 *
 * The backup rule is the migration's: an existing snapshot is reused rather than
 * captured over (it holds the pre-migration state, which is the rollback point
 * worth keeping), and the run aborts if no copy of any kind can be written.
 */
export async function runLegacyPrioritySlotCleanup(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<LegacyCleanupRunResult> {
  let backupTaken = false;
  let backupNote = '';

  const existing = await loadSnapshot(plugin).catch(() => null);
  if (existing) {
    backupTaken = true;
    backupNote =
      `Using the existing backup of ${existing.rows.length} priorities, taken ` +
      `${new Date(existing.meta.capturedAt).toLocaleString()}. It records BOTH slots, so the ` +
      `values being cleared here are in it.`;
  } else {
    onProgress?.('Backing up every card priority…');
    try {
      const snapshot = await captureCardPrioritySnapshot(plugin, onProgress);
      const downloaded = downloadCardPrioritySnapshotFile(snapshot);
      backupTaken = snapshot.storedLocally || downloaded;
      backupNote =
        `${snapshot.meta.count} priorities captured. ` +
        `Local copy: ${snapshot.storedLocally ? 'written' : `FAILED — ${snapshot.storeError}`}. ` +
        `JSON file: ${downloaded ? 'downloaded' : 'FAILED'}.`;
    } catch (err) {
      backupNote = `Backup failed: ${err}`;
    }
  }

  const probeStub: LegacyWriteProbe = {
    attempted: false,
    remId: null,
    before: null,
    after: null,
    hidden: null,
    scanned: 0,
    leftoversSeen: 0,
    rescueOnlySeen: 0,
    cleared: false,
    verdict: 'Not reached.',
  };

  if (!backupTaken) {
    return {
      probe: probeStub,
      report: null,
      backupNote,
      aborted: `No backup could be written, so nothing was changed. ${backupNote}`,
    };
  }

  // A retired slot cannot be written (measured — see the header), so the sweep
  // would be a silent no-op on every one of tens of thousands of rems. Stop here
  // and let the command offer the un-retire step instead of burning the pass.
  if (await isVisiblePrioritySlotRetired(plugin)) {
    return {
      probe: probeStub,
      report: null,
      backupNote,
      needsUnretire: true,
      aborted:
        'The old Priority slot is retired, so the plugin cannot write to it — a write returns ' +
        'without error and changes nothing. It has to be registered again before its leftovers ' +
        'can be cleared.',
    };
  }

  onProgress?.('Testing whether the slot can be written…');
  const probe = await probeLegacyPrioritySlotWrite(plugin, onProgress);

  // Nothing found, or the write does not land: either way the sweep would be
  // 45,000 rems of nothing. Report the probe and stop.
  if (!probe.attempted || !probe.cleared) {
    return {
      probe,
      report: null,
      backupNote,
      aborted: probe.verdict,
    };
  }

  const report = await clearLegacyPriorityValues(plugin, onProgress);
  // The probe cleared one rem before the sweep started, so it is not in the
  // counts. Add it, or the report under-states by one and reads as an error.
  report.withLeftover++;
  report.cleared++;

  // Close the window this flow opened. Only on a clean sweep: re-retiring while
  // values are still in there would make them unreadable rather than merely
  // stale, which is the one outcome worse than leaving them.
  let reRetired = false;
  const record = await readHiddenSlotRecord(plugin);
  const cleanSweep =
    report.didNotStick === 0 && report.rescueFailed === 0 && report.errors === 0;
  if (record?.legacyCleanupUnretiredAt && cleanSweep) {
    await markHiddenSlotMigrationComplete(plugin, { legacyCleanupUnretiredAt: undefined });
    reRetired = true;
    console.log(`${LOG} sweep clean — visible slot retired again.`);
  }

  return { probe, report, backupNote, reRetired };
}

/**
 * Puts the retirement back after an abandoned cleanup.
 *
 * The flow un-retires the slot BEFORE it knows whether the sweep will work, so
 * every exit that is not a clean sweep has to be able to close the window again —
 * otherwise a failed attempt leaves the knowledge base with the empty "Priority"
 * rows back for good.
 */
export async function reRetireAfterLegacyCleanup(plugin: RNPlugin): Promise<void> {
  await markHiddenSlotMigrationComplete(plugin, { legacyCleanupUnretiredAt: undefined });
  console.log(`${LOG} cleanup abandoned — visible slot retired again.`);
}

/** Whether a cleanup un-retired the slot and has not put it back yet. */
export async function isMidLegacyCleanup(plugin: RNPlugin): Promise<boolean> {
  return !!(await readHiddenSlotRecord(plugin))?.legacyCleanupUnretiredAt;
}

/** What a previous run recorded, for the debug panel and the command dialog. */
export async function readLegacyCleanupState(
  plugin: RNPlugin
): Promise<{ clearedAt: number | null; count: number }> {
  const record = await readHiddenSlotRecord(plugin);
  return {
    clearedAt: record?.legacyValuesClearedAt ?? null,
    count: record?.legacyValuesCleared ?? 0,
  };
}
