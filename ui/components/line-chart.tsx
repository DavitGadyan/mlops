"use client";

import { useEffect, useRef, useState } from "react";

export type Series = { id: string; label: string; color: string; points: { x: number; y: number }[] };

type Props = {
  title: string;
  xLabel: string;
  series: Series[];
  format: (y: number) => string;
  reference?: { y: number; label: string }; // a level to read the lines against, e.g. 1.0x
  // A line encodes position, not length, so a ratio chart may start near its
  // data instead of at zero. Pass false for that.
  fromZero?: boolean;
};

const HEIGHT = 250;
const PAD = { top: 16, bottom: 46, left: 46 };
const LABEL_GAP = 15; // minimum vertical distance between two end labels

/** Axis step so that about four steps cover `max`: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(max: number): number {
  const rough = (max || 1) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((step) => step >= rough)!;
}

export function LineChart({ title, xLabel, series, format, reference, fromZero = true }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null); // index into xs under the pointer or keyboard

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(frame.current!);
    return () => observer.disconnect();
  }, []);

  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const valueAt = (s: Series, x: number) => s.points.find((p) => p.x === x)?.y;

  // Room on the right for the end labels, which name each line where it ends.
  const right = series.length > 1 ? Math.max(...series.map((s) => s.label.length)) * 6.6 + 20 : 20;
  const innerW = Math.max(width - PAD.left - right, 0);
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  const values = series.flatMap((s) => s.points.map((p) => p.y)).concat(reference ? [reference.y] : []);
  const top = Math.max(...values);
  const bottom = fromZero ? 0 : Math.min(...values);
  const step = niceStep(top - bottom);
  const yMin = Math.floor(bottom / step) * step;
  const yMax = Math.max(Math.ceil(top / step) * step, yMin + step);
  const ticks = Array.from({ length: Math.round((yMax - yMin) / step) + 1 }, (_, i) => yMin + i * step);

  // Concurrency doubles from one level to the next, so the levels are spaced
  // evenly (a log axis in effect) instead of crowding the low end.
  const px = (x: number) =>
    PAD.left + (xs.length > 1 ? (xs.indexOf(x) / (xs.length - 1)) * innerW : innerW / 2);
  const py = (y: number) => PAD.top + innerH - ((y - yMin) / (yMax - yMin)) * innerH;

  // End labels: keep them LABEL_GAP apart (push down, then pull back up from the
  // axis) and draw a short leader when a label had to leave its line's height.
  const ends = series
    .map((s) => ({ s, x: px(s.points.at(-1)!.x), y: py(s.points.at(-1)!.y), at: 0 }))
    .sort((a, b) => a.y - b.y);
  ends.forEach((end, i) => (end.at = Math.max(end.y, i ? ends[i - 1].at + LABEL_GAP : -Infinity)));
  for (let i = ends.length - 1, floor = PAD.top + innerH; i >= 0; floor = ends[i].at - LABEL_GAP, i--) {
    ends[i].at = Math.min(ends[i].at, floor);
  }

  const move = (by: number) => setActive((i) => Math.min(xs.length - 1, Math.max(0, (i ?? -1) + by)));
  const activeX = active === null ? null : px(xs[active]);

  return (
    <figure>
      <figcaption className="font-medium">{title}</figcaption>

      {series.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-ink-2">
          {series.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}

      <div
        ref={frame}
        className="relative mt-2 rounded-md"
        role="group"
        tabIndex={0}
        aria-label={`${title}. Use the left and right arrow keys to read values.`}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") move(1);
          if (event.key === "ArrowLeft") move(-1);
        }}
        onBlur={() => setActive(null)}
      >
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            className="block text-[11px] tabular-nums"
            onPointerLeave={() => setActive(null)}
            onPointerMove={(event) => {
              // The pointer only has to be nearest to a level, never on a 2px line.
              const x = event.clientX - event.currentTarget.getBoundingClientRect().left - PAD.left;
              setActive(Math.min(xs.length - 1, Math.max(0, Math.round((x / innerW) * (xs.length - 1)))));
            }}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                {/* Only a true zero gets the heavier baseline. */}
                <line
                  x1={PAD.left}
                  x2={PAD.left + innerW}
                  y1={py(tick)}
                  y2={py(tick)}
                  stroke={tick === 0 ? "var(--line-strong)" : "var(--line)"}
                />
                <text x={PAD.left - 8} y={py(tick)} dy="0.32em" textAnchor="end" fill="var(--axis)">
                  {format(tick)}
                </text>
              </g>
            ))}
            {xs.map((x) => (
              <text key={x} x={px(x)} y={HEIGHT - PAD.bottom + 16} textAnchor="middle" fill="var(--axis)">
                {x}
              </text>
            ))}
            <text x={PAD.left + innerW / 2} y={HEIGHT - 6} textAnchor="middle" fill="var(--axis)">
              {xLabel}
            </text>

            {reference && (
              <g>
                <line
                  x1={PAD.left}
                  x2={PAD.left + innerW}
                  y1={py(reference.y)}
                  y2={py(reference.y)}
                  stroke="var(--ink-2)"
                />
                <text x={PAD.left + 4} y={py(reference.y) - 5} fill="var(--ink-2)">
                  {reference.label}
                </text>
              </g>
            )}

            {activeX !== null && (
              <line
                x1={activeX}
                x2={activeX}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke="var(--line-strong)"
              />
            )}

            {series.map((s) => (
              <path
                key={s.id}
                d={s.points.map((p, i) => `${i ? "L" : "M"}${px(p.x)},${py(p.y)}`).join("")}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {/* Dots carry a ring in the surface colour so they stay legible where lines cross. */}
            {ends.map(({ s, x, y, at }) => (
              <g key={s.id}>
                <circle cx={x} cy={y} r={4} fill={s.color} stroke="var(--page)" strokeWidth={2} />
                {series.length > 1 && (
                  <>
                    {at !== y && <line x1={x + 6} x2={x + 11} y1={y} y2={at} stroke="var(--line-strong)" />}
                    <text x={x + 13} y={at} dy="0.32em" fill="var(--ink-2)">
                      {s.label}
                    </text>
                  </>
                )}
              </g>
            ))}
            {active !== null &&
              series.map((s) => {
                const y = valueAt(s, xs[active]);
                return y === undefined ? null : (
                  <circle
                    key={s.id}
                    cx={activeX!}
                    cy={py(y)}
                    r={4}
                    fill={s.color}
                    stroke="var(--page)"
                    strokeWidth={2}
                  />
                );
              })}
          </svg>
        )}

        {active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 rounded-md border border-line-strong bg-surface px-2.5 py-2 text-[0.8125rem] shadow-[0_4px_12px_rgb(0_0_0/0.12)]"
            style={activeX! > width / 2 ? { right: width - activeX! + 12 } : { left: activeX! + 12 }}
          >
            <div className="text-ink-2">
              {xLabel}: {xs[active]}
            </div>
            {series.map((s) => {
              const y = valueAt(s, xs[active]);
              return y === undefined ? null : (
                <div key={s.id} className="mt-0.5 flex items-center gap-2 whitespace-nowrap">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                  <span className="font-semibold tabular-nums">{format(y)}</span>
                  <span className="text-ink-2">{s.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Every value in the chart, readable without hovering or telling colours apart. */}
      <details className="mt-1 text-[0.8125rem]">
        <summary className="w-fit cursor-pointer rounded text-ink-2 hover:text-ink">Table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>{xLabel}</th>
                {series.map((s) => (
                  <th key={s.id}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {xs.map((x) => (
                <tr key={x}>
                  <td>{x}</td>
                  {series.map((s) => {
                    const y = valueAt(s, x);
                    return <td key={s.id}>{y === undefined ? "n/a" : format(y)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
