"use client";

import { useId, useState } from "react";

/**
 * Small dependency-free SVG charts. Colours come from the validated CVD-safe
 * series tokens in globals.css (`--s-*`); text always wears ink tokens, never a
 * series colour. Each chart ships a hover layer and direct value labels.
 */

const PALETTE: Record<string, string> = {
  load: "var(--s-load)", solar: "var(--s-solar)", export: "var(--s-export)",
  import: "var(--s-import)", battery: "var(--s-batt)", savings: "var(--s-savings)",
};

export function seriesColor(key: string) { return PALETTE[key] ?? "var(--s-load)"; }

function niceMax(value: number) {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

export type BarDatum = { label: string; value: number; sublabel?: string };

/** Vertical bars anchored to the baseline, 4px-rounded ends, selective value labels. */
export function BarChart({ data, colorKey = "savings", unit = "", format }: { data: BarDatum[]; colorKey?: string; unit?: string; format?: (value: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720, height = 210, padL = 12, padR = 12, padT = 22, padB = 26;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const band = plotW / Math.max(1, data.length);
  const barW = Math.min(46, band * 0.62);
  const fmt = format ?? ((v: number) => `${Math.round(v * 10) / 10}`);
  const color = seriesColor(colorKey);
  const showEvery = data.length > 14 ? Math.ceil(data.length / 12) : 1;

  return (
    <figure className="viz">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Bar chart">
        <g className="grid">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const y = padT + plotH * (1 - t);
            return <line key={t} x1={padL} x2={width - padR} y1={y} y2={y} />;
          })}
        </g>
        {data.map((d, i) => {
          const x = padL + band * i + (band - barW) / 2;
          const h = max > 0 ? (d.value / max) * plotH : 0;
          const y = padT + plotH - h;
          const active = hover === i;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent" />
              <rect className="bar" x={x} y={y} width={barW} height={Math.max(0, h)} rx={4} fill={color} opacity={active ? 1 : 0.86} />
              {(active || i % showEvery === 0) && <text className="lbl" x={x + barW / 2} y={height - 9}>{d.label}</text>}
              {active && <text className="val" x={x + barW / 2} y={y - 6}>{fmt(d.value)}{unit}</text>}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export type LinePoint = { label: string; value: number };

/** Single-series area+line, 2px stroke, hover crosshair with a value readout. */
export function LineChart({ data, colorKey = "savings", unit = "", format }: { data: LinePoint[]; colorKey?: string; unit?: string; format?: (value: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/[:]/g, "");
  const width = 720, height = 200, padL = 14, padR = 14, padT = 18, padB = 24;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)));
  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;
  const x = (i: number) => padL + stepX * i;
  const y = (v: number) => padT + plotH * (1 - v / max);
  const color = seriesColor(colorKey);
  const fmt = format ?? ((v: number) => `${Math.round(v * 10) / 10}`);
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  const area = data.length ? `${line} L${x(data.length - 1).toFixed(1)},${padT + plotH} L${x(0).toFixed(1)},${padT + plotH} Z` : "";
  const showEvery = data.length > 8 ? Math.ceil(data.length / 7) : 1;

  return (
    <figure className="viz">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Trend line"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rx = (event.clientX - rect.left) / rect.width * width;
          setHover(Math.max(0, Math.min(data.length - 1, Math.round((rx - padL) / (stepX || 1)))));
        }}>
        <defs><linearGradient id={`a${gid}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.32" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        <g className="grid">{[0, 0.5, 1].map((t) => { const gy = padT + plotH * (1 - t); return <line key={t} x1={padL} x2={width - padR} y1={gy} y2={gy} />; })}</g>
        {area && <path className="area" d={area} fill={`url(#a${gid})`} style={{ opacity: 1 }} />}
        <path className="line" d={line} stroke={color} />
        {data.map((d, i) => (i % showEvery === 0 || hover === i) ? <text key={i} className="lbl" x={x(i)} y={height - 8}>{d.label}</text> : null)}
        {hover !== null && data[hover] && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} stroke="var(--line-strong)" strokeWidth={1} />
            <circle className="dot" cx={x(hover)} cy={y(data[hover].value)} r={3.5} fill={color} />
            <text className="val" x={Math.min(width - 30, Math.max(30, x(hover)))} y={Math.max(12, y(data[hover].value) - 10)}>{fmt(data[hover].value)}{unit}</text>
          </g>
        )}
      </svg>
    </figure>
  );
}
