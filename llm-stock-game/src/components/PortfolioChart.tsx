import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { gameStore } from "../stores/GameStore";

type Props = {
  width?: number;
  height?: number;
};

function PortfolioChartComponent({ width = 1920, height = 220 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState<number>(width);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = () => {
      const cw = el.clientWidth;
      if (cw && cw !== w) setW(cw);
    };
    apply();
    const ro = new ResizeObserver(() => apply());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);
  const valsPort = gameStore.portfolioSeries;
  const valsBench = gameStore.benchmarkSeries;
  const valsGem = gameStore.geminiSeries;
  const valsClaude = gameStore.claudeSeries;
  const valsGpt5 = gameStore.gpt5Series;
  const pad = 12;
  const maxLen = Math.max(valsPort.length, valsBench.length, valsGem.length, valsClaude.length, valsGpt5.length);
  const xFor = (i: number) => pad + (i / Math.max(1, maxLen - 1)) * (w - pad * 2);

  const min = Math.min(
    valsPort.length ? Math.min(...valsPort) : 1,
    valsBench.length ? Math.min(...valsBench) : 1,
    valsGem.length ? Math.min(...valsGem) : 1,
    valsClaude.length ? Math.min(...valsClaude) : 1,
    valsGpt5.length ? Math.min(...valsGpt5) : 1
  );
  const max = Math.max(
    valsPort.length ? Math.max(...valsPort) : 1,
    valsBench.length ? Math.max(...valsBench) : 1,
    valsGem.length ? Math.max(...valsGem) : 1,
    valsClaude.length ? Math.max(...valsClaude) : 1,
    valsGpt5.length ? Math.max(...valsGpt5) : 1
  );
  const range = max - min || 1;
  const yFor = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);

  const toSmoothPath = (arr: number[]) => {
    if (arr.length < 2) return null;
    const xs = arr.map((_, i) => xFor(i));
    const ys = arr.map(v => yFor(v));
    const n = xs.length;
    let d = `M ${xs[0].toFixed(2)} ${ys[0].toFixed(2)}`;
    for (let i = 0; i < n - 1; i++) {
      const x0 = i > 0 ? xs[i - 1] : xs[i];
      const y0 = i > 0 ? ys[i - 1] : ys[i];
      const x1 = xs[i];
      const y1 = ys[i];
      const x2 = xs[i + 1];
      const y2 = ys[i + 1];
      const x3 = i !== n - 2 ? xs[i + 2] : x2;
      const y3 = i !== n - 2 ? ys[i + 2] : y2;
      const cp1x = x1 + (x2 - x0) / 6;
      const cp1y = y1 + (y2 - y0) / 6;
      const cp2x = x2 - (x3 - x1) / 6;
      const cp2y = y2 - (y3 - y1) / 6;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}`;
    }
    return d;
  };

  const baseY = yFor(1);

  const pathBench = toSmoothPath(valsBench);
  const pathPort = toSmoothPath(valsPort);
  const pathGem = toSmoothPath(valsGem);
  const pathClaude = toSmoothPath(valsClaude);
  const pathGpt5 = toSmoothPath(valsGpt5);

  return (
    <div ref={containerRef} style={{ width: "100%", border: "1px solid #111827", borderRadius: 12, padding: 12, background: "#0b1220", color: "#e5e7eb" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>Portfolio vs Average vs LLMs</div>
        <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#cbd5e1", flexWrap: "wrap" }}>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#60a5fa", marginRight: 6 }} /> Portfolio</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#64748b", marginRight: 6 }} /> Average</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#34d399", marginRight: 6 }} /> Gemini</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#a78bfa", marginRight: 6 }} /> Claude</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#f59e0b", marginRight: 6 }} /> GPT-5</span>
        </div>
      </div>
      <svg width={w} height={height} style={{ display: "block", width: "100%" }}>
        <defs>
          <linearGradient id="portGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#60a5fa" stopOpacity="0.03" />
          </linearGradient>
          <filter id="portGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g>
          <line x1={pad} y1={baseY} x2={w - pad} y2={baseY} stroke="#1f2937" />
          {pathBench && <path d={pathBench} fill="none" stroke="#64748b" strokeWidth={1.5} />}
          {pathPort && <path d={pathPort} fill="none" stroke="#60a5fa" strokeWidth={2} filter="url(#portGlow)" />}
          {pathPort && (
            <path d={`${pathPort} L ${w - pad} ${height - pad} L ${pad} ${height - pad} Z`} fill="url(#portGrad)" opacity={0.9} />
          )}
          {pathGem && <path d={pathGem} fill="none" stroke="#34d399" strokeWidth={1.8} strokeDasharray="5 4" />}
          {pathClaude && <path d={pathClaude} fill="none" stroke="#a78bfa" strokeWidth={1.8} strokeDasharray="4 4" />}
          {pathGpt5 && <path d={pathGpt5} fill="none" stroke="#f59e0b" strokeWidth={1.8} strokeDasharray="6 4" />}
        </g>
      </svg>
    </div>
  );
}

export const PortfolioChart = observer(PortfolioChartComponent);


