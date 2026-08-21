/**
 * Study Dashboard → Graphs tab.
 *
 * Two synchronized timeline charts over the dashboard's selected period:
 *   1. Reviews — flashcard reps (left axis) vs IncRem reps (right axis)
 *   2. Time    — flashcard time, IncRem time and total, on one shared scale
 *
 * Flashcard *counts* dwarf IncRem counts in a typical KB, so the Reviews chart
 * gives each series its own y-axis; the times are comparable, so that chart
 * keeps a single scale. Every axis is fitted to the *visible* maximum (the
 * "Optimize Zoom" behaviour of the Priority Shield graphs, applied
 * automatically) so the plot area is never wasted on empty headroom.
 *
 * The input is the sparse per-day series the dashboard builds from the same
 * loaded histories the Summary card counts, so the bars always add up to the
 * Summary. Rolling days up to weeks/months/years happens here, which keeps a
 * granularity switch free of any recompute over the KB.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
    formatTimeFull,
    formatTimeTick,
    fitAxis,
    rollUpWithinBudget,
} from '../lib/study_timeline';

export type { TimelineDay, TimelineGranularity };
export { TIMELINE_GRANULARITIES };

const CARD_COLOR = '#ef4444';
const INC_COLOR = '#3b82f6';
const TOTAL_COLOR = '#8b5cf6';

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

interface SeriesDef {
    key: keyof TimelineBucket;
    name: string;
    color: string;
}

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
    kind,
    granularity,
}: {
    active?: boolean;
    payload?: any[];
    kind: 'count' | 'time';
    granularity: TimelineGranularity;
}) {
    if (!active || !payload || payload.length === 0) return null;
    const bucket = payload[0]?.payload as TimelineBucket | undefined;
    if (!bucket) return null;
    const fmt = kind === 'count' ? formatCount : formatTimeFull;
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
            {payload.map((p: any) => (
                <div key={p.dataKey} style={{ color: p.color, fontWeight: 600 }}>
                    {p.name}: {fmt(p.value || 0)}
                </div>
            ))}
        </div>
    );
}

function TimelineChart({
    title,
    subtitle,
    data,
    kind,
    leftSeries,
    rightSeries,
    totalSeries,
    dualAxis,
    granularity,
    zoom,
    setZoom,
}: {
    title: string;
    subtitle: string;
    data: TimelineBucket[];
    kind: 'count' | 'time';
    leftSeries: SeriesDef;
    rightSeries: SeriesDef;
    totalSeries?: SeriesDef;
    /** false = every series shares the left axis (comparable magnitudes). */
    dualAxis: boolean;
    granularity: TimelineGranularity;
    zoom: ZoomState;
    setZoom: React.Dispatch<React.SetStateAction<ZoomState>>;
}) {
    const view = useMemo(() => {
        if (typeof zoom.startIndex === 'number' && typeof zoom.endIndex === 'number') {
            return data.slice(zoom.startIndex, zoom.endIndex + 1);
        }
        return data;
    }, [data, zoom.startIndex, zoom.endIndex]);

    // On a single axis every series has to fit under the same ceiling.
    const leftMax = Math.max(
        0,
        ...view.map((b) =>
            Math.max(
                b[leftSeries.key] as number,
                totalSeries ? (b[totalSeries.key] as number) : 0,
                dualAxis ? 0 : (b[rightSeries.key] as number)
            )
        )
    );
    const rightMax = Math.max(0, ...view.map((b) => b[rightSeries.key] as number));
    const leftAxis = fitAxis(leftMax, kind);
    const rightAxis = fitAxis(rightMax, kind);
    const rightAxisId = dualAxis ? 'right' : 'left';

    const leftTotal = view.reduce((sum, b) => sum + (b[leftSeries.key] as number), 0);
    const rightTotal = view.reduce((sum, b) => sum + (b[rightSeries.key] as number), 0);
    const fmt = kind === 'count' ? formatCount : formatTimeFull;

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
                {zoom.startIndex !== null && (
                    <button
                        className="rn-button rn-button--secondary shadow-sm"
                        style={{ margin: 0, fontSize: '11px', minHeight: '22px', padding: '0 8px' }}
                        onClick={() => setZoom(EMPTY_ZOOM)}
                    >
                        Reset Data Range
                    </button>
                )}
            </div>

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
                        domain={[0, leftAxis.max]}
                        ticks={leftAxis.ticks}
                        tickFormatter={kind === 'count' ? formatCount : formatTimeTick}
                        tick={{ fontSize: 10 }}
                        width={48}
                    />
                    {dualAxis && (
                        <YAxis
                            yAxisId="right"
                            orientation="right"
                            stroke={rightSeries.color}
                            domain={[0, rightAxis.max]}
                            ticks={rightAxis.ticks}
                            tickFormatter={kind === 'count' ? formatCount : formatTimeTick}
                            tick={{ fontSize: 10 }}
                            width={48}
                        />
                    )}
                    <Tooltip
                        content={<ChartTooltip kind={kind} granularity={granularity} />}
                        cursor={{ fill: 'rgba(128,128,128,0.12)' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                    <Bar
                        yAxisId="left"
                        dataKey={leftSeries.key as string}
                        name={leftSeries.name}
                        fill={leftSeries.color}
                        radius={[2, 2, 0, 0]}
                        isAnimationActive={false}
                    />
                    <Bar
                        yAxisId={rightAxisId}
                        dataKey={rightSeries.key as string}
                        name={rightSeries.name}
                        fill={rightSeries.color}
                        radius={[2, 2, 0, 0]}
                        isAnimationActive={false}
                    />
                    {totalSeries && (
                        <Line
                            yAxisId="left"
                            type="monotone"
                            dataKey={totalSeries.key as string}
                            name={totalSeries.name}
                            stroke={totalSeries.color}
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                        />
                    )}
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

            <div className="text-xs mt-1 flex gap-4 flex-wrap" style={{ opacity: 0.75 }}>
                <span>
                    <span style={{ color: leftSeries.color, fontWeight: 600 }}>{leftSeries.name}:</span>{' '}
                    {fmt(leftTotal)}
                </span>
                <span>
                    <span style={{ color: rightSeries.color, fontWeight: 600 }}>{rightSeries.name}:</span>{' '}
                    {fmt(rightTotal)}
                </span>
                {totalSeries && (
                    <span>
                        <span style={{ color: totalSeries.color, fontWeight: 600 }}>
                            {totalSeries.name}:
                        </span>{' '}
                        {fmt(leftTotal + rightTotal)}
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
    accentColor,
}: {
    days: TimelineDay[];
    granularity: TimelineGranularity;
    onGranularityChange: (g: TimelineGranularity) => void;
    accentColor: string;
}) {
    // Zoom is shared: the two charts are two readings of one timeline, so a
    // range picked on either should frame both.
    const [zoom, setZoom] = useState<ZoomState>(EMPTY_ZOOM);

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
                        kind="count"
                        leftSeries={{ key: 'cardReps', name: 'Flashcards', color: CARD_COLOR }}
                        rightSeries={{ key: 'incReps', name: 'IncRems', color: INC_COLOR }}
                        dualAxis
                        granularity={effectiveGranularity}
                        zoom={zoom}
                        setZoom={setZoom}
                    />
                    <TimelineChart
                        title="Time"
                        subtitle="Flashcard time, IncRem time and their total per bucket, on one shared scale."
                        data={buckets}
                        kind="time"
                        leftSeries={{ key: 'cardTimeMs', name: 'Flashcards', color: CARD_COLOR }}
                        rightSeries={{ key: 'incTimeMs', name: 'IncRems', color: INC_COLOR }}
                        totalSeries={{ key: 'totalTimeMs', name: 'Total', color: TOTAL_COLOR }}
                        dualAxis={false}
                        granularity={effectiveGranularity}
                        zoom={zoom}
                        setZoom={setZoom}
                    />
                </>
            )}
        </div>
    );
}
