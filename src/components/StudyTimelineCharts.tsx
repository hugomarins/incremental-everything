/**
 * Study Dashboard → Graphs tab.
 *
 * Two synchronized timeline charts over the dashboard's selected period:
 *   1. Reviews — flashcard reps (left axis) vs IncRem reps (right axis)
 *   2. Time    — flashcard time vs IncRem time, stacked or side by side
 *   3. Retention — the Summary's "Ret." column over time, on its reps
 *   4. Speed     — the Summary's cpm column over time, on its reps
 *
 * Flashcard *counts* dwarf IncRem counts in a typical KB, so the Reviews chart
 * gives each series its own y-axis; the times are comparable, so that chart
 * keeps a single scale and can stack them — stacked, the bar height *is* the
 * total, which beats drawing the total again as its own mark. Unstacking puts
 * both series back on a shared baseline for comparing them, at the cost of that
 * per-bucket total. Every axis is fitted to the *visible* maximum (the
 * "Optimize Zoom" behaviour of the Priority Shield graphs, applied
 * automatically) so the plot area is never wasted on empty headroom.
 *
 * The input is the sparse per-day series the dashboard builds from the same
 * loaded histories the Summary card counts, so the bars always add up to the
 * Summary. Rolling days up to weeks/months/years happens here, which keeps a
 * granularity switch free of any recompute over the KB.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalStorageState } from '@remnote/plugin-sdk';
import {
    Bar,
    CartesianGrid,
    ComposedChart,
    Legend,
    Line,
    ReferenceArea,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import {
    TimelineBucket,
    TimelineDay,
    TimelineGranularity,
    TIMELINE_GRANULARITIES,
    formatCount,
    formatCpm,
    formatPercent,
    formatSecPerCard,
    formatTimeFull,
    formatTimeTick,
    fitAxis,
    fitPercentAxis,
    fitRateAxis,
    retentionOf,
    cpmOf,
    secPerCardOf,
    rollUpWithinBudget,
} from '../lib/study_timeline';

export type { TimelineDay, TimelineGranularity };
export { TIMELINE_GRANULARITIES };

const CARD_COLOR = '#ef4444';
const INC_COLOR = '#3b82f6';
const TOTAL_COLOR = '#8b5cf6';
const RETENTION_COLOR = '#16a34a';
const SPEED_COLOR = '#0891b2';

/**
 * Unit for the Speed chart. Shares the Practiced Queues summary table's storage
 * key on purpose: one speed unit for the whole plugin, per device.
 */
type SpeedUnit = 'cpm' | 'spc';
const SPEED_UNIT_KEY = 'summarySpeedUnit';

const sumOf = (view: TimelineBucket[], key: 'cardReps' | 'cardForgot' | 'cardTimeMs') =>
    view.reduce((total, b) => total + b[key], 0);

const formatOrDash = (v: number | null, format: (n: number) => string) =>
    v == null ? null : format(v);

/**
 * How a series' numbers are read. Counts and times grow from a zero baseline;
 * percentages and rates are fitted to a band around their values instead.
 */
type ValueKind = 'count' | 'time' | 'percent' | 'rate';

const isBanded = (kind: ValueKind) => kind === 'percent' || kind === 'rate';

const tickFormatterFor = (kind: ValueKind) =>
    kind === 'count' ? formatCount : kind === 'time' ? formatTimeTick : formatPercent;
const fullFormatterFor = (kind: ValueKind) =>
    kind === 'count' ? formatCount : kind === 'time' ? formatTimeFull : formatPercent;

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

interface SeriesDef {
    key: keyof TimelineBucket;
    name: string;
    color: string;
    kind: ValueKind;
    /** Overrides the kind's default formatting — a rate can be cpm or s/card. */
    format?: (v: number) => string;
}

const formatWith = (series: SeriesDef, v: number) =>
    series.format ? series.format(v) : fullFormatterFor(series.kind)(v);

interface ZoomState {
    startIndex: number | null;
    endIndex: number | null;
    refAreaLeft: string | null;
    refAreaRight: string | null;
}

const EMPTY_ZOOM: ZoomState = {
    startIndex: null,
    endIndex: null,
    refAreaLeft: null,
    refAreaRight: null,
};

function ChartTooltip({
    active,
    payload,
    seriesByKey,
    granularity,
    showTotal,
    totalKind,
}: {
    active?: boolean;
    payload?: any[];
    /** Each series formats itself — a chart can mix a rate and a count. */
    seriesByKey: Record<string, SeriesDef>;
    granularity: TimelineGranularity;
    showTotal: boolean;
    totalKind?: ValueKind;
}) {
    if (!active || !payload || payload.length === 0) return null;
    const bucket = payload[0]?.payload as TimelineBucket | undefined;
    if (!bucket) return null;
    return (
        <div
            style={{
                borderRadius: 8,
                boxShadow: '0 4px 6px -1px rgba(0,0,0,0.15)',
                background: 'var(--rn-clr-background-primary)',
                border: '1px solid var(--rn-clr-border-primary)',
                color: 'var(--rn-clr-content-primary)',
                padding: '8px 10px',
                fontSize: 12,
                lineHeight: 1.5,
            }}
        >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {granularity === 'week' ? `Week of ${bucket.label}` : bucket.label}
            </div>
            {payload.map((p: any) => {
                const series = seriesByKey[p.dataKey];
                return (
                    <div key={p.dataKey} style={{ color: p.color, fontWeight: 600 }}>
                        {p.name}:{' '}
                        {p.value == null || !series ? '—' : formatWith(series, p.value)}
                    </div>
                );
            })}
            {showTotal && payload.length > 1 && (
                <div
                    style={{
                        color: TOTAL_COLOR,
                        fontWeight: 600,
                        marginTop: 3,
                        paddingTop: 3,
                        borderTop: '1px solid var(--rn-clr-border-primary)',
                    }}
                >
                    Total:{' '}
                    {fullFormatterFor(totalKind ?? 'count')(
                        payload.reduce((sum: number, p: any) => sum + (p.value || 0), 0)
                    )}
                </div>
            )}
        </div>
    );
}

function TimelineChart({
    title,
    subtitle,
    data,
    leftSeries,
    rightSeries,
    leftAsLine,
    dualAxis,
    stacked,
    showTotal,
    granularity,
    leftAggregate,
    zoom,
    setZoom,
    headerExtra,
}: {
    title: string;
    subtitle: string;
    data: TimelineBucket[];
    leftSeries: SeriesDef;
    rightSeries: SeriesDef;
    /**
     * Draw the left series as a line instead of a bar. Rates are not quantities
     * that stack up from zero, so a bar would misrepresent them.
     */
    leftAsLine?: boolean;
    /** false = every series shares the left axis (comparable magnitudes). */
    dualAxis: boolean;
    /** Single-axis only: stack the two series so the bar height is their total. */
    stacked?: boolean;
    /** Report the two series' sum in the tooltip and the totals line. */
    showTotal?: boolean;
    granularity: TimelineGranularity;
    /**
     * Replaces the left series' figure in the totals line. A rate over a range
     * is not the sum of its buckets — it has to be recomputed from the reps and
     * time inside them.
     */
    leftAggregate?: (view: TimelineBucket[]) => string | null;
    zoom: ZoomState;
    setZoom: React.Dispatch<React.SetStateAction<ZoomState>>;
    headerExtra?: React.ReactNode;
}) {
    const view = useMemo(() => {
        if (typeof zoom.startIndex === 'number' && typeof zoom.endIndex === 'number') {
            return data.slice(zoom.startIndex, zoom.endIndex + 1);
        }
        return data;
    }, [data, zoom.startIndex, zoom.endIndex]);

    // On a single axis both series share one ceiling — the sum of the two when
    // they are stacked, the taller of the two when they sit side by side.
    const isStacked = !dualAxis && !!stacked;
    const leftValues = view
        .map((b) => b[leftSeries.key] as number | null)
        .filter((v): v is number => v != null);
    const leftMax = Math.max(
        0,
        ...view.map((b) => {
            const left = (b[leftSeries.key] as number) ?? 0;
            const right = (b[rightSeries.key] as number) ?? 0;
            if (dualAxis) return left;
            return isStacked ? left + right : Math.max(left, right);
        })
    );
    const rightMax = Math.max(0, ...view.map((b) => (b[rightSeries.key] as number) ?? 0));

    // Percentages and rates are fitted to a band around their values; counts
    // and times grow from a zero baseline.
    const leftBandAxis = !isBanded(leftSeries.kind)
        ? null
        : (leftSeries.kind === 'percent' ? fitPercentAxis : fitRateAxis)(
              leftValues.length ? Math.min(...leftValues) : 0,
              leftValues.length ? Math.max(...leftValues) : leftSeries.kind === 'percent' ? 100 : 1
          );
    const leftCountAxis = fitAxis(leftMax, leftSeries.kind === 'time' ? 'time' : 'count');
    const leftDomain: [number, number] = leftBandAxis
        ? [leftBandAxis.min, leftBandAxis.max]
        : [0, leftCountAxis.max];
    const leftTicks = leftBandAxis ? leftBandAxis.ticks : leftCountAxis.ticks;
    const rightAxis = fitAxis(rightMax, rightSeries.kind === 'time' ? 'time' : 'count');
    const rightAxisId = dualAxis ? 'right' : 'left';

    const leftTotal = view.reduce((sum, b) => sum + ((b[leftSeries.key] as number) ?? 0), 0);
    const rightTotal = view.reduce((sum, b) => sum + ((b[rightSeries.key] as number) ?? 0), 0);
    const seriesByKey: Record<string, SeriesDef> = {
        [leftSeries.key as string]: leftSeries,
        [rightSeries.key as string]: rightSeries,
    };

    const commitZoom = () => {
        const { refAreaLeft, refAreaRight } = zoom;
        if (!refAreaLeft || !refAreaRight || refAreaLeft === refAreaRight) {
            setZoom((prev) => ({ ...prev, refAreaLeft: null, refAreaRight: null }));
            return;
        }
        // Indexes are resolved against the full series, not the current view, so
        // zooming while already zoomed keeps pointing at the right buckets.
        const offset = zoom.startIndex ?? 0;
        let left = view.findIndex((b) => b.key === refAreaLeft);
        let right = view.findIndex((b) => b.key === refAreaRight);
        if (left === -1 || right === -1) {
            setZoom((prev) => ({ ...prev, refAreaLeft: null, refAreaRight: null }));
            return;
        }
        if (left > right) [left, right] = [right, left];
        setZoom({
            refAreaLeft: null,
            refAreaRight: null,
            startIndex: offset + left,
            endIndex: offset + right,
        });
    };

    // A rate chart with nothing to measure would render an empty plot with a
    // silent axis; say so instead. Only rate/percent series can be null — a
    // count of zero is data.
    const noRateData = !!leftAsLine && !view.some((b) => b[leftSeries.key] != null);

    const tickFormatter = (key: string) => {
        const b = view.find((x) => x.key === key);
        return b ? b.label : key;
    };

    return (
        <div
            className="mb-6 relative"
            style={{ userSelect: 'none' }}
            onDragStart={(e) => e.preventDefault()}
        >
            <div className="flex items-start justify-between gap-2 mb-1">
                <div>
                    <div
                        className="font-semibold text-sm"
                        style={{ color: 'var(--rn-clr-content-primary)' }}
                    >
                        {title}
                    </div>
                    <div className="text-xs opacity-60">{subtitle}</div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    {headerExtra}
                    {zoom.startIndex !== null && (
                        <button
                            className="rn-button rn-button--secondary shadow-sm"
                            style={{
                                margin: 0,
                                fontSize: '11px',
                                minHeight: '22px',
                                padding: '0 8px',
                            }}
                            onClick={() => setZoom(EMPTY_ZOOM)}
                        >
                            Reset Data Range
                        </button>
                    )}
                </div>
            </div>

            {noRateData ? (
                <div
                    style={{
                        height: 120,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        color: 'var(--rn-clr-content-tertiary)',
                        border: '1px dashed var(--rn-clr-border-primary)',
                        borderRadius: 8,
                    }}
                >
                    No flashcard reviews in this range.
                </div>
            ) : (
            <ResponsiveContainer width="100%" height={320} debounce={50}>
                <ComposedChart
                    data={view}
                    margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                    onMouseDown={(e: any) => {
                        if (e && e.activeLabel) {
                            setZoom((prev) => ({
                                ...prev,
                                refAreaLeft: e.activeLabel,
                                refAreaRight: e.activeLabel,
                            }));
                        }
                    }}
                    onMouseMove={(e: any) => {
                        setZoom((prev) =>
                            prev.refAreaLeft && e && e.activeLabel && e.activeLabel !== prev.refAreaRight
                                ? { ...prev, refAreaRight: e.activeLabel }
                                : prev
                        );
                    }}
                    onMouseUp={commitZoom}
                    onMouseLeave={() => {
                        if (zoom.refAreaLeft) commitZoom();
                    }}
                >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.35} />
                    <XAxis
                        dataKey="key"
                        tickFormatter={tickFormatter}
                        tick={{ fontSize: 10 }}
                        minTickGap={16}
                        interval="preserveStartEnd"
                        angle={-35}
                        textAnchor="end"
                        height={52}
                    />
                    <YAxis
                        yAxisId="left"
                        orientation="left"
                        stroke={leftSeries.color}
                        domain={leftDomain}
                        ticks={leftTicks}
                        tickFormatter={(v: number) =>
                            leftSeries.format
                                ? leftSeries.format(v)
                                : tickFormatterFor(leftSeries.kind)(v)
                        }
                        tick={{ fontSize: 10 }}
                        width={48}
                        allowDataOverflow
                    />
                    {dualAxis && (
                        <YAxis
                            yAxisId="right"
                            orientation="right"
                            stroke={rightSeries.color}
                            domain={[0, rightAxis.max]}
                            ticks={rightAxis.ticks}
                            tickFormatter={tickFormatterFor(rightSeries.kind)}
                            tick={{ fontSize: 10 }}
                            width={48}
                        />
                    )}
                    <Tooltip
                        content={
                            <ChartTooltip
                                seriesByKey={seriesByKey}
                                granularity={granularity}
                                showTotal={!!showTotal}
                                totalKind={leftSeries.kind}
                            />
                        }
                        cursor={{ fill: 'rgba(128,128,128,0.12)' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                    {leftAsLine ? (
                        <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey={leftSeries.key as string}
                            name={leftSeries.name}
                            stroke={leftSeries.color}
                            strokeWidth={2}
                            // Buckets with nothing to measure stay a gap: joining
                            // across them would draw a rate that was never observed.
                            connectNulls={false}
                            dot={view.length <= 60 ? { r: 2.5 } : false}
                            activeDot={{ r: 5 }}
                            isAnimationActive={false}
                        />
                    ) : (
                        <Bar
                            yAxisId="left"
                            stackId={isStacked ? 'stack' : undefined}
                            dataKey={leftSeries.key as string}
                            name={leftSeries.name}
                            fill={leftSeries.color}
                            // Only the top of a stack gets rounded corners, or the
                            // segments read as separate bars sitting on each other.
                            radius={isStacked ? undefined : [2, 2, 0, 0]}
                            isAnimationActive={false}
                        />
                    )}
                    <Bar
                        yAxisId={rightAxisId}
                        stackId={isStacked ? 'stack' : undefined}
                        dataKey={rightSeries.key as string}
                        name={rightSeries.name}
                        fill={rightSeries.color}
                        // Backing volume for a rate is context, not the subject —
                        // it must not out-shout the line in front of it.
                        fillOpacity={leftAsLine ? 0.3 : 1}
                        radius={[2, 2, 0, 0]}
                        isAnimationActive={false}
                    />
                    {zoom.refAreaLeft && zoom.refAreaRight ? (
                        <ReferenceArea
                            yAxisId="left"
                            x1={zoom.refAreaLeft}
                            x2={zoom.refAreaRight}
                            strokeOpacity={0.3}
                            fill="#8884d8"
                        />
                    ) : null}
                </ComposedChart>
            </ResponsiveContainer>
            )}

            <div className="text-xs mt-1 flex gap-4 flex-wrap" style={{ opacity: 0.75 }}>
                <span>
                    <span style={{ color: leftSeries.color, fontWeight: 600 }}>
                        {leftSeries.name}:
                    </span>{' '}
                    {leftAggregate ? leftAggregate(view) ?? '—' : formatWith(leftSeries, leftTotal)}
                </span>
                <span>
                    <span style={{ color: rightSeries.color, fontWeight: 600 }}>
                        {rightSeries.name}:
                    </span>{' '}
                    {formatWith(rightSeries, rightTotal)}
                </span>
                {showTotal && (
                    <span>
                        <span style={{ color: TOTAL_COLOR, fontWeight: 600 }}>Total:</span>{' '}
                        {fullFormatterFor(leftSeries.kind)(leftTotal + rightTotal)}
                    </span>
                )}
                <span style={{ opacity: 0.7 }}>
                    over {view.length} {view.length === 1 ? 'bucket' : 'buckets'}
                </span>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Tab body
// ---------------------------------------------------------------------------

export function StudyTimelineCharts({
    days,
    granularity,
    onGranularityChange,
    stacked,
    onStackedChange,
    accentColor,
}: {
    days: TimelineDay[];
    granularity: TimelineGranularity;
    onGranularityChange: (g: TimelineGranularity) => void;
    stacked: boolean;
    onStackedChange: (stacked: boolean) => void;
    accentColor: string;
}) {
    // Zoom is shared: the charts are four readings of one timeline, so a range
    // picked on any of them should frame them all.
    const [zoom, setZoom] = useState<ZoomState>(EMPTY_ZOOM);

    const [storedSpeedUnit, setSpeedUnit] = useLocalStorageState<SpeedUnit>(
        SPEED_UNIT_KEY,
        'cpm'
    );
    // Guard a stale or garbled stored value so the chart never renders blank.
    const speedUnit: SpeedUnit = storedSpeedUnit === 'spc' ? 'spc' : 'cpm';

    const { buckets, effectiveGranularity } = useMemo(
        () => rollUpWithinBudget(days, granularity),
        [days, granularity]
    );

    // A new period, scope, or granularity invalidates the indexes the zoom holds.
    const bucketsRef = useRef(buckets);
    useEffect(() => {
        if (bucketsRef.current !== buckets) {
            bucketsRef.current = buckets;
            setZoom(EMPTY_ZOOM);
        }
    }, [buckets]);

    const buttonStyle = (selected: boolean): React.CSSProperties => ({
        backgroundColor: selected ? accentColor : 'var(--rn-clr-background-primary)',
        color: selected ? '#fff' : 'var(--rn-clr-content-secondary)',
        border: selected ? 'none' : '1px solid var(--rn-clr-border-primary)',
        fontWeight: selected ? 600 : 400,
        borderRadius: 6,
        padding: '3px 12px',
        fontSize: 12,
        cursor: 'pointer',
        transition: 'all 0.15s ease-in-out',
    });

    return (
        <div>
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                    {TIMELINE_GRANULARITIES.map((g) => (
                        <button
                            key={g.value}
                            style={buttonStyle(g.value === granularity)}
                            onClick={() => onGranularityChange(g.value)}
                        >
                            {g.label}
                        </button>
                    ))}
                </div>
                <div className="text-xs opacity-60">
                    Drag across a chart to zoom into a range.
                </div>
            </div>

            {effectiveGranularity !== granularity && (
                <div className="text-xs mb-2" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                    Too many bars for this period — showing{' '}
                    {TIMELINE_GRANULARITIES.find((g) => g.value === effectiveGranularity)?.label.toLowerCase()}{' '}
                    buckets instead.
                </div>
            )}

            {buckets.length === 0 ? (
                <div
                    style={{
                        padding: 24,
                        textAlign: 'center',
                        color: 'var(--rn-clr-content-tertiary)',
                        fontSize: 12,
                    }}
                >
                    No reviews in the selected period.
                </div>
            ) : (
                <>
                    <TimelineChart
                        title="Reviews"
                        subtitle="Flashcard reps (left axis) and IncRem reps (right axis) per bucket."
                        data={buckets}
                        leftSeries={{ key: 'cardReps', name: 'Flashcards', color: CARD_COLOR, kind: 'count' }}
                        rightSeries={{ key: 'incReps', name: 'IncRems', color: INC_COLOR, kind: 'count' }}
                        dualAxis
                        granularity={effectiveGranularity}
                        zoom={zoom}
                        setZoom={setZoom}
                    />
                    <TimelineChart
                        title="Time"
                        subtitle={
                            stacked
                                ? 'Flashcard and IncRem time per bucket — the bar height is the total.'
                                : 'Flashcard and IncRem time per bucket, side by side on one shared scale.'
                        }
                        data={buckets}
                        leftSeries={{ key: 'cardTimeMs', name: 'Flashcards', color: CARD_COLOR, kind: 'time' }}
                        rightSeries={{ key: 'incTimeMs', name: 'IncRems', color: INC_COLOR, kind: 'time' }}
                        dualAxis={false}
                        stacked={stacked}
                        showTotal
                        granularity={effectiveGranularity}
                        zoom={zoom}
                        setZoom={setZoom}
                        headerExtra={
                            <label
                                className="flex items-center gap-1.5 cursor-pointer text-xs whitespace-nowrap"
                                title="Stacked, the bar height is the total time. Unstacked, both series sit on the same baseline so their evolution is easier to compare — at the cost of the per-bucket total."
                            >
                                <input
                                    type="checkbox"
                                    checked={stacked}
                                    onChange={(e) => onStackedChange(e.target.checked)}
                                    className="form-checkbox h-3.5 w-3.5"
                                    style={{ accentColor }}
                                />
                                <span className="opacity-80">Stacked</span>
                            </label>
                        }
                    />
                    <TimelineChart
                        title="Retention"
                        subtitle="Share of flashcard reps not graded Again, over the reps behind it."
                        data={buckets}
                        leftSeries={{
                            key: 'retention',
                            name: 'Retention',
                            color: RETENTION_COLOR,
                            kind: 'percent',
                        }}
                        rightSeries={{
                            key: 'cardReps',
                            name: 'Flashcard reps',
                            color: CARD_COLOR,
                            kind: 'count',
                        }}
                        leftAsLine
                        dualAxis
                        granularity={effectiveGranularity}
                        leftAggregate={(v) =>
                            formatOrDash(
                                retentionOf(sumOf(v, 'cardReps'), sumOf(v, 'cardForgot')),
                                formatPercent
                            )
                        }
                        zoom={zoom}
                        setZoom={setZoom}
                    />
                    <TimelineChart
                        title="Speed"
                        subtitle={
                            speedUnit === 'cpm'
                                ? 'Flashcards reviewed per minute, over the reps behind it.'
                                : 'Seconds spent per flashcard, over the reps behind it.'
                        }
                        data={buckets}
                        leftSeries={{
                            key: speedUnit === 'cpm' ? 'speedCpm' : 'speedSecPerCard',
                            name: speedUnit === 'cpm' ? 'Speed (cpm)' : 'Speed (s/card)',
                            color: SPEED_COLOR,
                            kind: 'rate',
                            format: speedUnit === 'cpm' ? formatCpm : formatSecPerCard,
                        }}
                        rightSeries={{
                            key: 'cardReps',
                            name: 'Flashcard reps',
                            color: CARD_COLOR,
                            kind: 'count',
                        }}
                        leftAsLine
                        dualAxis
                        granularity={effectiveGranularity}
                        leftAggregate={(v) =>
                            speedUnit === 'cpm'
                                ? formatOrDash(
                                      cpmOf(sumOf(v, 'cardReps'), sumOf(v, 'cardTimeMs')),
                                      formatCpm
                                  )
                                : formatOrDash(
                                      secPerCardOf(sumOf(v, 'cardReps'), sumOf(v, 'cardTimeMs')),
                                      formatSecPerCard
                                  )
                        }
                        zoom={zoom}
                        setZoom={setZoom}
                        headerExtra={
                            <button
                                onClick={() => setSpeedUnit(speedUnit === 'cpm' ? 'spc' : 'cpm')}
                                className="px-1.5 py-0.5 text-[10px] font-medium rounded border rn-clr-border-opaque rn-clr-content-tertiary hover:rn-clr-background-primary transition-colors"
                                title={
                                    speedUnit === 'cpm'
                                        ? 'Showing cards per minute — click for seconds per card'
                                        : 'Showing seconds per card — click for cards per minute'
                                }
                            >
                                {speedUnit === 'cpm' ? 'cpm' : 's/card'}
                            </button>
                        }
                    />
                </>
            )}
        </div>
    );
}
