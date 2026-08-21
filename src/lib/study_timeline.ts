/**
 * Bucketing and axis maths behind the Study Dashboard's Graphs tab.
 *
 * Kept free of React and recharts so it can be reasoned about (and exercised)
 * on its own: the chart component only turns what these functions return into
 * bars.
 */
import dayjs from 'dayjs';
import { formatDuration } from './utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One calendar day of activity. Sparse: days with no reps are absent. */
export interface TimelineDay {
    startMs: number;
    cardReps: number;
    incReps: number;
    cardTimeMs: number;
    incTimeMs: number;
}

export type TimelineGranularity = 'day' | 'week' | 'month' | 'year';

export const TIMELINE_GRANULARITIES: { value: TimelineGranularity; label: string }[] = [
    { value: 'day', label: 'Daily' },
    { value: 'week', label: 'Weekly' },
    { value: 'month', label: 'Monthly' },
    { value: 'year', label: 'Yearly' },
];

export interface TimelineBucket {
    key: string; // unique + sortable — the XAxis dataKey, and what zoom indexes on
    label: string; // what the tick actually renders
    startMs: number;
    cardReps: number;
    incReps: number;
    cardTimeMs: number;
    incTimeMs: number;
    totalTimeMs: number;
}

/**
 * Beyond this, bars are sub-pixel and recharts starts to crawl; the chart
 * coarsens the granularity a step at a time until it fits.
 */
export const MAX_BUCKETS = 800;

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

function bucketStart(ms: number, gran: TimelineGranularity): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    if (gran === 'week') d.setDate(d.getDate() - d.getDay());
    else if (gran === 'month') d.setDate(1);
    else if (gran === 'year') d.setMonth(0, 1);
    return d.getTime();
}

function nextBucketStart(ms: number, gran: TimelineGranularity): number {
    const d = new Date(ms);
    if (gran === 'day') d.setDate(d.getDate() + 1);
    else if (gran === 'week') d.setDate(d.getDate() + 7);
    else if (gran === 'month') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
}

function bucketKey(startMs: number, gran: TimelineGranularity): string {
    if (gran === 'year') return dayjs(startMs).format('YYYY');
    if (gran === 'month') return dayjs(startMs).format('YYYY-MM');
    return dayjs(startMs).format('YYYY-MM-DD');
}

function bucketLabel(startMs: number, gran: TimelineGranularity, multiYear: boolean): string {
    if (gran === 'year') return dayjs(startMs).format('YYYY');
    if (gran === 'month') return dayjs(startMs).format(multiYear ? 'MMM YY' : 'MMM');
    return dayjs(startMs).format(multiYear ? 'D MMM YY' : 'D MMM');
}

/**
 * Roll the sparse day series up to `gran`, filling the gaps so the x-axis reads
 * as a real timeline (a day with no reviews is a zero bar, not a missing one).
 * The span runs first-activity → last-activity rather than edge-to-edge of the
 * selected period: trailing empty months of "This Year" would only squeeze the
 * bars that carry data.
 */
export function rollUp(days: TimelineDay[], gran: TimelineGranularity): TimelineBucket[] {
    if (days.length === 0) return [];

    const byStart = new Map<number, TimelineDay>();
    for (const day of days) {
        const s = bucketStart(day.startMs, gran);
        const acc = byStart.get(s);
        if (acc) {
            acc.cardReps += day.cardReps;
            acc.incReps += day.incReps;
            acc.cardTimeMs += day.cardTimeMs;
            acc.incTimeMs += day.incTimeMs;
        } else {
            byStart.set(s, { ...day, startMs: s });
        }
    }

    const starts = Array.from(byStart.keys()).sort((a, b) => a - b);
    const first = starts[0];
    const last = starts[starts.length - 1];
    const multiYear = new Date(first).getFullYear() !== new Date(last).getFullYear();

    const buckets: TimelineBucket[] = [];
    let cur = first;
    // Hard stop: a corrupt timestamp must not spin the loop forever.
    while (cur <= last && buckets.length < 20000) {
        const d = byStart.get(cur);
        buckets.push({
            key: bucketKey(cur, gran),
            label: bucketLabel(cur, gran, multiYear),
            startMs: cur,
            cardReps: d?.cardReps ?? 0,
            incReps: d?.incReps ?? 0,
            cardTimeMs: d?.cardTimeMs ?? 0,
            incTimeMs: d?.incTimeMs ?? 0,
            totalTimeMs: (d?.cardTimeMs ?? 0) + (d?.incTimeMs ?? 0),
        });
        cur = nextBucketStart(cur, gran);
    }
    return buckets;
}

// ---------------------------------------------------------------------------
// Axis fitting
// ---------------------------------------------------------------------------

/** Round steps for count axes: 1, 2, 5 × 10ⁿ. */
function niceCountStep(range: number, targetTicks: number): number {
    const raw = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    const norm = raw / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return Math.max(1, step * mag);
}

// Human step sizes for a time axis — a 15m or 2h gridline reads instantly where
// a "nice" round number of milliseconds does not.
const TIME_STEPS_MS = [
    5_000, 10_000, 15_000, 30_000,
    60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
    3_600_000, 2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
    24 * 3_600_000, 48 * 3_600_000, 7 * 24 * 3_600_000,
];

function niceTimeStep(range: number, targetTicks: number): number {
    const raw = range / targetTicks;
    for (const step of TIME_STEPS_MS) {
        if (step >= raw) return step;
    }
    return TIME_STEPS_MS[TIME_STEPS_MS.length - 1];
}

/**
 * Fit an axis to the data it actually has to show: a rounded ceiling just above
 * the visible maximum, plus the tick list that goes with it.
 */
export function fitAxis(
    maxValue: number,
    kind: 'count' | 'time',
    targetTicks = 5
): { max: number; ticks: number[] } {
    if (!(maxValue > 0)) {
        return kind === 'count' ? { max: 4, ticks: [0, 1, 2, 3, 4] } : { max: 60_000, ticks: [0, 30_000, 60_000] };
    }
    const step =
        kind === 'count'
            ? niceCountStep(maxValue, targetTicks)
            : niceTimeStep(maxValue, targetTicks);
    // A hair of headroom so the tallest bar doesn't touch the top gridline.
    const max = Math.ceil((maxValue * 1.02) / step) * step;
    const ticks: number[] = [];
    for (let t = 0; t <= max + step / 2; t += step) ticks.push(t);
    return { max, ticks };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Compact enough for an axis tick: "45s", "12m", "1.5h". */
export function formatTimeTick(ms: number): string {
    if (!ms) return '0';
    const seconds = ms / 1000;
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = seconds / 60;
    if (minutes < 60) return `${Math.round(minutes)}m`;
    const hours = minutes / 60;
    return hours < 10 ? `${Math.round(hours * 10) / 10}h` : `${Math.round(hours)}h`;
}

export function formatTimeFull(ms: number): string {
    return formatDuration(Math.round(ms / 1000)) || '0s';
}

export function formatCount(n: number): string {
    return n.toLocaleString();
}

/**
 * Roll up at the requested granularity, coarsening a step at a time while the
 * result would be too dense to read. Returns what was actually used so the UI
 * can say so.
 */
export function rollUpWithinBudget(
    days: TimelineDay[],
    granularity: TimelineGranularity
): { buckets: TimelineBucket[]; effectiveGranularity: TimelineGranularity } {
    const order: TimelineGranularity[] = ['day', 'week', 'month', 'year'];
    let gran = granularity;
    let buckets = rollUp(days, gran);
    let idx = order.indexOf(gran);
    while (buckets.length > MAX_BUCKETS && idx < order.length - 1) {
        idx += 1;
        gran = order[idx];
        buckets = rollUp(days, gran);
    }
    return { buckets, effectiveGranularity: gran };
}
