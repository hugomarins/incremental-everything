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
    /** Card reps graded AGAIN — what retention is measured against. */
    cardForgot: number;
    cardHard: number;
    cardGood: number;
    cardEasy: number;
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
    cardForgot: number;
    cardHard: number;
    cardGood: number;
    cardEasy: number;
    incReps: number;
    cardTimeMs: number;
    incTimeMs: number;
    /**
     * Each grade's share of this bucket's card reps. Skips never reach here, so
     * the four add up to 100 — which is what makes them comparable between a
     * 40-rep bucket and an 800-rep one.
     */
    pctAgain: number | null;
    pctHard: number | null;
    pctGood: number | null;
    pctEasy: number | null;
    /**
     * Percentage of this bucket's card reps that were *not* graded AGAIN, or
     * null when the bucket holds no card reps — a bucket you did not study has
     * no retention, which is not the same as 0%.
     *
     * Taken from the bucket's summed reps rather than by averaging the days
     * inside it, so a day with 3 reps cannot outweigh a day with 300.
     */
    retention: number | null;
    /** Flashcard review speed, in both units — null with nothing to measure. */
    speedCpm: number | null;
    speedSecPerCard: number | null;
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

    // Buckets are keyed by their *calendar* identity ("2018-11-05"), never by a
    // raw timestamp.
    //
    // Timestamps look like the obvious key and are a trap. In São Paulo, DST
    // used to begin at midnight: on 4 Nov 2018 the clock jumped straight from
    // 23:59:59 to 01:00, so local midnight did not exist that day and
    // `setHours(0,0,0,0)` lands on 01:00 instead. Walking the timeline by adding
    // a day at a time preserves that 01:00 forever after, while every bucket key
    // computed from a rep's own date is back at 00:00 — so from the transition
    // on, the walk misses every bucket, and the whole timeline after it renders
    // as empty. A calendar key cannot drift: both sides ask what day it is, not
    // what instant it is.
    interface Acc {
        startMs: number;
        cardReps: number;
        cardForgot: number;
        cardHard: number;
        cardGood: number;
        cardEasy: number;
        incReps: number;
        cardTimeMs: number;
        incTimeMs: number;
    }
    const byKey = new Map<string, Acc>();
    for (const day of days) {
        const start = bucketStart(day.startMs, gran);
        const key = bucketKey(start, gran);
        const acc = byKey.get(key);
        if (acc) {
            acc.cardReps += day.cardReps;
            acc.cardForgot += day.cardForgot;
            acc.cardHard += day.cardHard;
            acc.cardGood += day.cardGood;
            acc.cardEasy += day.cardEasy;
            acc.incReps += day.incReps;
            acc.cardTimeMs += day.cardTimeMs;
            acc.incTimeMs += day.incTimeMs;
        } else {
            byKey.set(key, {
                startMs: start,
                cardReps: day.cardReps,
                cardForgot: day.cardForgot,
                cardHard: day.cardHard,
                cardGood: day.cardGood,
                cardEasy: day.cardEasy,
                incReps: day.incReps,
                cardTimeMs: day.cardTimeMs,
                incTimeMs: day.incTimeMs,
            });
        }
    }

    // Every key in one roll-up shares a format, so lexicographic order is
    // chronological order.
    const keys = Array.from(byKey.keys()).sort();
    const firstKey = keys[0];
    const lastKey = keys[keys.length - 1];
    const multiYear =
        new Date(byKey.get(firstKey)!.startMs).getFullYear() !==
        new Date(byKey.get(lastKey)!.startMs).getFullYear();

    const buckets: TimelineBucket[] = [];
    let cur = byKey.get(firstKey)!.startMs;
    let curKey = firstKey;
    // Hard stop: a corrupt timestamp must not spin the loop forever.
    while (curKey <= lastKey && buckets.length < 20000) {
        const d = byKey.get(curKey);
        const startMs = bucketStart(cur, gran);
        buckets.push({
            key: curKey,
            label: bucketLabel(startMs, gran, multiYear),
            startMs,
            cardReps: d?.cardReps ?? 0,
            cardForgot: d?.cardForgot ?? 0,
            cardHard: d?.cardHard ?? 0,
            cardGood: d?.cardGood ?? 0,
            cardEasy: d?.cardEasy ?? 0,
            incReps: d?.incReps ?? 0,
            cardTimeMs: d?.cardTimeMs ?? 0,
            incTimeMs: d?.incTimeMs ?? 0,
            pctAgain: shareOf(d?.cardForgot ?? 0, d?.cardReps ?? 0),
            pctHard: shareOf(d?.cardHard ?? 0, d?.cardReps ?? 0),
            pctGood: shareOf(d?.cardGood ?? 0, d?.cardReps ?? 0),
            pctEasy: shareOf(d?.cardEasy ?? 0, d?.cardReps ?? 0),
            retention: retentionOf(d?.cardReps ?? 0, d?.cardForgot ?? 0),
            speedCpm: cpmOf(d?.cardReps ?? 0, d?.cardTimeMs ?? 0),
            speedSecPerCard: secPerCardOf(d?.cardReps ?? 0, d?.cardTimeMs ?? 0),
        });
        cur = nextBucketStart(cur, gran);
        const nextKey = bucketKey(bucketStart(cur, gran), gran);
        // A step that fails to advance the calendar would loop forever.
        if (nextKey <= curKey) break;
        curKey = nextKey;
    }
    return buckets;
}

/** One grade's share of a bucket's reps, as a percentage. Null with no reps. */
export function shareOf(count: number, total: number): number | null {
    if (total <= 0) return null;
    return (count / total) * 100;
}

/**
 * Share of reps that were not graded AGAIN, as a percentage — the same figure
 * the Summary's "Ret." column reports. Null with no reps to measure.
 */
export function retentionOf(cardReps: number, cardForgot: number): number | null {
    if (cardReps <= 0) return null;
    return (Math.max(0, cardReps - cardForgot) / cardReps) * 100;
}

/** Cards per minute over a bucket's own reps and time. Null with nothing to measure. */
export function cpmOf(cardReps: number, cardTimeMs: number): number | null {
    if (cardReps <= 0 || cardTimeMs <= 0) return null;
    return cardReps / (cardTimeMs / 60000);
}

/** The same speed the other way round: seconds spent per card. */
export function secPerCardOf(cardReps: number, cardTimeMs: number): number | null {
    if (cardReps <= 0 || cardTimeMs <= 0) return null;
    return cardTimeMs / 1000 / cardReps;
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

/** Percentage axes read in fives; anything finer is noise on a retention curve. */
const PERCENT_STEPS = [1, 2, 5, 10, 20, 25, 50];

/** 1, 2, 5 × 10ⁿ without the integer floor — a cpm axis needs 0.5 steps. */
function niceStepUnclamped(range: number, targetTicks: number): number {
    const raw = Math.max(range, 1e-9) / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
}

const roundTo = (v: number, decimals: number) => {
    const f = Math.pow(10, decimals);
    return Math.round(v * f) / f;
};

/**
 * Fit an axis to a band around the data rather than to a zero baseline.
 *
 * Rates and percentages are not quantities that accumulate from zero: retention
 * lives between 85% and 100%, review speed between 2 and 4 cards a minute. Drawn
 * against zero, their entire range is squeezed into the top sliver of the plot
 * and every real movement flattens into a straight line. So the domain is the
 * data's own span plus a margin, and the *ticks* — not the domain edges — are
 * the round numbers: snapping the edges to a step is what re-opens the gap the
 * band was meant to close.
 *
 * This is the same reasoning as the Priority Shield graphs' "Optimize Priorities
 * Zoom", which pads the visible min/max by 5 points.
 */
function fitBandAxis(
    minValue: number,
    maxValue: number,
    opts: {
        targetTicks: number;
        /** Hard limits the data cannot exceed (percentages stop at 0 and 100). */
        clampMin?: number;
        clampMax?: number;
        /** Restricts steps to a ladder, e.g. multiples of 5 for percentages. */
        steps?: number[];
        decimals: number;
        /** Minimum band width, so a flat series still gets a plot to sit in. */
        minSpan: number;
    }
): { min: number; max: number; ticks: number[] } {
    const { targetTicks, clampMin, clampMax, steps, decimals, minSpan } = opts;
    let span = Math.max(maxValue - minValue, minSpan);
    const pad = span * 0.15;
    let lo = minValue - pad;
    let hi = maxValue + pad;
    if (hi - lo < minSpan) {
        const mid = (hi + lo) / 2;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
    }
    if (clampMin !== undefined) lo = Math.max(clampMin, lo);
    if (clampMax !== undefined) hi = Math.min(clampMax, hi);
    span = hi - lo;

    const step = steps
        ? steps.find((c) => span / c <= targetTicks) ?? steps[steps.length - 1]
        : niceStepUnclamped(span, targetTicks);

    const ticks: number[] = [];
    const first = Math.ceil(lo / step) * step;
    for (let i = 0; first + i * step <= hi + step / 1e6; i++) {
        ticks.push(roundTo(first + i * step, decimals));
    }
    // A band too narrow to contain two round ticks labels its own edges instead.
    if (ticks.length < 2) {
        return {
            min: roundTo(lo, decimals),
            max: roundTo(hi, decimals),
            ticks: [roundTo(lo, decimals), roundTo((lo + hi) / 2, decimals), roundTo(hi, decimals)],
        };
    }
    return { min: roundTo(lo, decimals), max: roundTo(hi, decimals), ticks };
}

/** Band-fit a percentage series (retention), never leaving 0–100. */
export function fitPercentAxis(
    minValue: number,
    maxValue: number,
    // Higher than the rate axis on purpose: a retention band is narrow, and too
    // few gridlines make a 3-point swing impossible to read off.
    targetTicks = 6
): { min: number; max: number; ticks: number[] } {
    if (!isFinite(minValue) || !isFinite(maxValue)) {
        return { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };
    }
    return fitBandAxis(minValue, maxValue, {
        targetTicks,
        clampMin: 0,
        clampMax: 100,
        steps: PERCENT_STEPS,
        decimals: 0,
        minSpan: 10,
    });
}

/** Band-fit a rate series (cards/min, seconds/card). Floors at zero. */
export function fitRateAxis(
    minValue: number,
    maxValue: number,
    targetTicks = 5
): { min: number; max: number; ticks: number[] } {
    if (!isFinite(minValue) || !isFinite(maxValue)) {
        return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    }
    return fitBandAxis(minValue, maxValue, {
        targetTicks,
        clampMin: 0,
        decimals: 3,
        minSpan: Math.max(maxValue, 1) * 0.1,
    });
}

/**
 * Weighted least-squares fit through (x, y) points — the trend lines.
 *
 * Weighted, because everything else on these charts is reps-weighted and a
 * trend that contradicted the aggregate beneath it would be worse than none: a
 * bucket holding three reps at 0% retention must not pull the line as hard as
 * one holding eight hundred. Weight is the rep count behind each point.
 *
 * Returns null when there is nothing to fit — no weight at all, or every point
 * stacked on one x, where the slope is undefined rather than zero.
 */
export function weightedLinearFit(
    points: { x: number; y: number; w: number }[]
): { slope: number; intercept: number } | null {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let used = 0;
    for (const p of points) {
        if (!(p.w > 0) || !isFinite(p.y)) continue;
        sw += p.w;
        sx += p.w * p.x;
        sy += p.w * p.y;
        sxx += p.w * p.x * p.x;
        sxy += p.w * p.x * p.y;
        used++;
    }
    if (used < 2 || sw <= 0) return null;
    const denom = sw * sxx - sx * sx;
    if (Math.abs(denom) < 1e-12) return null;
    const slope = (sw * sxy - sx * sy) / denom;
    return { slope, intercept: (sy - slope * sx) / sw };
}

/** Short name for a bucket's width, for reading a slope as "per week". */
export const GRANULARITY_UNIT: Record<TimelineGranularity, string> = {
    day: 'day',
    week: 'wk',
    month: 'mo',
    year: 'yr',
};

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

export function formatPercent(v: number): string {
    return `${Math.round(v)}%`;
}

export function formatCpm(v: number): string {
    return `${v.toFixed(1)}`;
}

export function formatSecPerCard(v: number): string {
    return v >= 100 ? `${Math.round(v)}s` : `${v.toFixed(1)}s`;
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
