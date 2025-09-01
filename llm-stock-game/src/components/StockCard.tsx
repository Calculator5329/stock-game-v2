import { useMemo } from "react";
import { observer } from "mobx-react-lite";
import { Sparkline } from "./Sparkline";
import { gameStore } from "../stores/GameStore";
import type { Company } from "../objects/market-sim";

type Props = {
  company: Company;
};

function Currency({ value }: { value: number }) {
  const val = Number.isFinite(value) ? value : 0;
  return <span>${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>;
}

function Percent({ value }: { value: number }) {
  if (!Number.isFinite(value)) return <span style={{ color: "#555" }}>—</span>;
  const color = value > 0 ? "#1a7f37" : value < 0 ? "#b00020" : "#555";
  const sign = value > 0 ? "+" : "";
  return <span style={{ color }}>{sign}{(value * 100).toFixed(2)}%</span>;
}

function StockCardComponent({ company }: Props) {
  const history = company.history;
  const prices = useMemo(() => history.map(h => h.price).filter(Number.isFinite), [history.length]);
  // derived below via buildQuarterly to avoid extra arrays
  const recentPrice = prices.slice(-96);

  // Build quarterly series strictly from completed 12-week quarters aligned by 'week'
  const buildQuarterly = (
    project: (h: typeof history[number]) => number,
    maxBars = 8,
    mode: "avg" | "sum" = "avg"
  ): number[] => {
    if (history.length === 0) return [];
    const lastWeek = history[history.length - 1].week;
    const lastCompleteQuarter = Math.floor(lastWeek / 12);
    if (lastCompleteQuarter <= 0) return [];
    const firstQuarter = Math.max(1, lastCompleteQuarter - maxBars + 1);
    const result: number[] = [];
    for (let q = firstQuarter; q <= lastCompleteQuarter; q++) {
      const qStart = (q - 1) * 12 + 1;
      const qEnd = q * 12;
      const slice = history.filter(h => h.week >= qStart && h.week <= qEnd);
      if (slice.length !== 12) continue; // only include full quarters
      const sum = slice.reduce((acc, h) => acc + project(h), 0);
      result.push(mode === "avg" ? sum / slice.length : sum);
    }
    return result;
  };

  const quarterlyRevenue = useMemo(() => buildQuarterly(h => h.revenue, 8, "sum"), [history.length]);
  const quarterlyIncome = useMemo(() => buildQuarterly(h => h.netIncome, 8, "sum"), [history.length]);
  const last = history.length >= 2
    ? (() => {
        const p1 = history[history.length - 1].price;
        const p0 = history[history.length - 2].price;
        if (!Number.isFinite(p1) || !Number.isFinite(p0)) return 0;
        const denom = Math.max(0.01, Math.abs(p0));
        return (p1 - p0) / denom;
      })()
    : 0;
  // Trade amount base: 10% of current net worth (total portfolio value)
  const tradeAmount = Math.max(0, 0.1 * gameStore.totalValue);
  const holding = gameStore.holdings.get(company.ticker);

  const {
    peTTM_Q,
    psTTM_Q,
    revYoY,
    niYoY,
    marginTTM_Q,
    cashPerShare,
    sector,
    stage
  } = useMemo(() => {
    if (!history.length) {
      return {
        peTTM_Q: null as number | null,
        psTTM_Q: 0,
        revYoY: 0,
        niYoY: 0,
        marginTTM_Q: 0,
        cashPerShare: 0,
        sector: company.sector,
        stage: company.stage
      };
    }
    const lastWeek = history[history.length - 1].week;
    const lastQuarter = Math.floor(lastWeek / 12);
    const lastQWeek = lastQuarter * 12;
    const qIndex = history.findIndex(h => h.week === lastQWeek);
    if (lastQuarter <= 0 || qIndex < 0) {
      return {
        peTTM_Q: null as number | null,
        psTTM_Q: 0,
        revYoY: 0,
        niYoY: 0,
        marginTTM_Q: 0,
        cashPerShare: 0,
        sector: company.sector,
        stage: company.stage
      };
    }
    const hQ = history[qIndex];
    const priceQ = history[history.length - 1].price; // use current price for valuation reflection
    const sharesQ = history[history.length - 1].shares; // use current shares for per-share metrics
    // TTM using 48 weeks ending at last quarter week
    const ttmStart = Math.max(0, qIndex - 47);
    const ttmSlice = history.slice(ttmStart, qIndex + 1);
    const ttmRevenue = ttmSlice.reduce((a, h) => a + h.revenue, 0);
    const ttmIncome = ttmSlice.reduce((a, h) => a + h.netIncome, 0);
    const epsTTM_Q = sharesQ > 0 ? ttmIncome / sharesQ : 0;
    const spsTTM_Q = sharesQ > 0 ? ttmRevenue / sharesQ : 0;
    const peTTM_Q = epsTTM_Q > 0 ? priceQ / epsTTM_Q : null;
    const psTTM_Q = spsTTM_Q > 0 ? priceQ / spsTTM_Q : 0;
    const marginTTM_Q = ttmRevenue > 0 ? ttmIncome / ttmRevenue : 0;
    const cashPerShare = sharesQ > 0 ? hQ.cash / sharesQ : 0;
    // YoY based on trailing 12 months vs prior trailing 12 months
    const prevEnd = ttmStart - 1;
    const prevStart = Math.max(0, prevEnd - 47);
    const prevSlice = prevEnd >= prevStart ? history.slice(prevStart, prevEnd + 1) : [];
    const prevRevenue = prevSlice.reduce((a, h) => a + h.revenue, 0);
    const prevIncome = prevSlice.reduce((a, h) => a + h.netIncome, 0);
    const revYoY = prevRevenue > 0 ? (ttmRevenue - prevRevenue) / prevRevenue : 0;
    const niYoY = prevIncome !== 0 ? (ttmIncome - prevIncome) / Math.abs(prevIncome) : 0;
    return {
      peTTM_Q,
      psTTM_Q,
      revYoY,
      niYoY,
      marginTTM_Q,
      cashPerShare,
      sector: company.sector,
      stage: company.stage
    };
  }, [history.length, company.sector, company.stage]);

  // Inline tiny bar chart SVG
  const BarChart = ({ values, width = 220, height = 48, color = "#999" }: { values: number[]; width?: number; height?: number; color?: string }) => {
    const clean = (values || []).filter(Number.isFinite);
    if (!clean.length) return <svg width={width} height={height} />;
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const lo = Math.min(min, 0);
    const hi = Math.max(max, 0.0001);
    const range = hi - lo || 1;
    const zeroY = height - 1 - ((0 - lo) / range) * (height - 2);
    const n = values.length;
    const gap = Math.max(2, Math.floor(width * 0.02));
    const barW = Math.max(2, Math.floor((width - gap * (n + 1)) / n));
    let x = gap;
    const rects = clean.map((v, i) => {
      const yVal = height - 1 - ((v - lo) / range) * (height - 2);
      const y = Math.min(yVal, zeroY);
      const h = Math.max(1, Math.abs(yVal - zeroY));
      const rect = <rect key={i} x={x} y={y} width={barW} height={h} fill={color} opacity={0.9} rx={2} ry={2} />;
      x += barW + gap;
      return rect;
    });
    return (
      <svg width={width} height={height} style={{ display: "block" }}>
        <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke="#e5e7eb" strokeWidth={1} />
        {rects}
      </svg>
    );
  };

  return (
    <div className="stock-card">
      <div className="stock-card__header">
        <div className="stock-card__title">
          <div className="stock-card__ticker">{company.ticker}</div>
          <div className="stock-card__name">{company.name}</div>
        </div>
        <div className="stock-card__price">
          <div className="stock-card__price-main"><Currency value={company.price} /></div>
          <div className="stock-card__price-change"><Percent value={last} /></div>
        </div>
      </div>

      <div className="stock-card__charts">
        <div className="mini-chart">
          <div className="mini-chart__label">Price</div>
          <Sparkline values={recentPrice.length > 1 ? recentPrice : [company.price - 0.01, company.price]} width={220} height={48} fill="#1976d2" />
        </div>
        <div className="mini-chart">
          <div className="mini-chart__label">Revenue (quarterly)</div>
          <BarChart values={quarterlyRevenue} width={220} height={48} color="#ff9800" />
        </div>
        <div className="mini-chart">
          <div className="mini-chart__label">Net Income (quarterly)</div>
          <BarChart values={quarterlyIncome} width={220} height={48} color="#2e7d32" />
        </div>
      </div>

      <div className="stock-card__desc" style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>{company.description}</div>

      <div className="stock-card__stats stat-grid">
        <div className="stat"><div className="label">Revenue YoY</div><div className="value"><Percent value={revYoY} /></div></div>
        <div className="stat"><div className="label">Earnings YoY</div><div className="value"><Percent value={niYoY} /></div></div>
        <div className="stat"><div className="label">PS (TTM)</div><div className="value">{Number.isFinite(psTTM_Q) ? psTTM_Q.toFixed(1) : "n/a"}</div></div>
        <div className="stat"><div className="label">PE (TTM)</div><div className="value">{peTTM_Q ? peTTM_Q.toFixed(1) : "n/a"}</div></div>
        <div className="stat"><div className="label">Margin (TTM)</div><div className="value"><Percent value={marginTTM_Q} /></div></div>
        <div className="stat"><div className="label">Cash / Share</div><div className="value"><Currency value={cashPerShare} /></div></div>
        <div className="stat"><div className="label">Sector</div><div className="value">{sector}</div></div>
        <div className="stat"><div className="label">Stage</div><div className="value">{stage}</div></div>
      </div>

      <div className="stock-card__trade">
        <button className="btn btn-primary" onClick={() => { gameStore.buy(company.ticker, tradeAmount); }}>Buy 10%</button>
        <button className="btn btn-danger" onClick={() => { gameStore.sell(company.ticker, tradeAmount); }}>Sell 10%</button>
        <div className="stock-card__held">Held: {holding ? holding.quantity : 0}</div>
        {company.isBankrupt && (
          <div style={{ color: "#b91c1c", fontWeight: 600, marginTop: 6 }}>Bankrupt</div>
        )}
      </div>
    </div>
  );
}

export const StockCard = observer(StockCardComponent);


