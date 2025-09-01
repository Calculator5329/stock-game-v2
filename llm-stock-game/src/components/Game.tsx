import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import { gameStore } from "../stores/GameStore";
import { StockCard } from "./StockCard";
import { PortfolioChart } from "./PortfolioChart";

function Currency({ value }: { value: number }) {
  return <span>${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>;
}

function Percent({ value }: { value: number }) {
  const color = value > 0 ? "#1a7f37" : value < 0 ? "#b00020" : "#555";
  const sign = value > 0 ? "+" : "";
  return <span style={{ color }}>{sign}{(value * 100).toFixed(2)}%</span>;
}

function Controls() {
  const [speed, setSpeed] = useState(gameStore.speedMs);

  useEffect(() => {
    setSpeed(gameStore.speedMs);
  }, [gameStore.speedMs]);

  return (
    <div className="controls">
      <button className="btn btn-primary" onClick={() => gameStore.start()} disabled={(gameStore as any).timer != null}>Play</button>
      <button className="btn" onClick={() => gameStore.stop()} disabled={(gameStore as any).timer == null}>Pause</button>
      <button className="btn" onClick={() => gameStore.step()}>Step +1 Week</button>
      <label>
        Speed:
        <select
          value={speed}
          onChange={(e) => {
            const ms = Number(e.target.value);
            setSpeed(ms);
            gameStore.setSpeed(ms);
          }}
          style={{ marginLeft: 6 }}
        >
          <option value={900}>0.5x</option>
          <option value={600}>1x</option>
          <option value={320}>2x</option>
          <option value={160}>4x</option>
          <option value={80}>8x</option>
        </select>
      </label>
      <div style={{ marginLeft: "auto", color: "#9ca3af" }} />
    </div>
  );
}

function PortfolioSummary() {
  const total = gameStore.totalValue;
  // Legacy return metrics kept for potential future display
  // const bench = gameStore.benchmarkAvgReturnPct;
  // const ret = gameStore.totalReturnPct;
  const cagrYou = gameStore.portfolioCAGR;
  const cagrAvg = gameStore.benchmarkCAGR;
  const cagrGem = gameStore.geminiCAGR;
  const cagrClaude = gameStore.claudeCAGR;
  const cagrGpt5 = gameStore.gpt5CAGR;
  return (
    <div className="portfolio-summary">
      <div><div className="label">Cash</div><div className="value"><Currency value={gameStore.cash} /></div></div>
      <div><div className="label">Holdings</div><div className="value"><Currency value={gameStore.holdingsValue} /></div></div>
      <div><div className="label">Total Value</div><div className="value"><Currency value={total} /></div></div>
      <div><div className="label">CAGR (You)</div><div className="value"><Percent value={cagrYou} /></div></div>
      <div><div className="label">CAGR (Avg)</div><div className="value"><Percent value={cagrAvg} /></div></div>
      <div><div className="label">CAGR (Gemini)</div><div className="value"><Percent value={cagrGem} /></div></div>
      <div><div className="label">CAGR (Claude)</div><div className="value"><Percent value={cagrClaude} /></div></div>
      <div><div className="label">CAGR (GPT-5)</div><div className="value"><Percent value={cagrGpt5} /></div></div>
    </div>
  );
}

function CompaniesGrid() {
  return (
    <div className="cards-grid">
      {gameStore.companies.map((c, i) => (
        <StockCard key={c.ticker + i} company={c} />
      ))}
    </div>
  );
}

function HoldingsTable({
  title,
  rows,
  cash,
}: {
  title: string;
  rows: Array<{ ticker: string; sector: string; quantity: number; avgCostBasis: number; price: number; value: number; unrealized: number }>;
  cash: number;
}) {
  const totalValue = rows.reduce((acc, r) => acc + r.value, 0) + cash;
  return (
    <div style={{ border: "1px solid #d1d5db", borderRadius: 12, padding: 12, background: "#f9fafb", color: "#111827" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div style={{ marginLeft: "auto", color: "#374151", fontSize: 12 }}>
          Total: <Currency value={totalValue} /> · Cash: <Currency value={cash} />
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th>Ticker</th>
              <th>Sector</th>
              <th style={{ textAlign: "right" }}>Qty</th>
              <th style={{ textAlign: "right" }}>Avg Cost</th>
              <th style={{ textAlign: "right" }}>Price</th>
              <th style={{ textAlign: "right" }}>Value</th>
              <th style={{ textAlign: "right" }}>Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.ticker}>
                <td style={{ padding: "6px 0" }}>{r.ticker}</td>
                <td style={{ padding: "6px 0" }}>{r.sector}</td>
                <td style={{ padding: "6px 0", textAlign: "right" }}>{r.quantity.toLocaleString()}</td>
                <td style={{ padding: "6px 0", textAlign: "right" }}>${r.avgCostBasis.toFixed(2)}</td>
                <td style={{ padding: "6px 0", textAlign: "right" }}>${r.price.toFixed(2)}</td>
                <td style={{ padding: "6px 0", textAlign: "right" }}>${r.value.toFixed(2)}</td>
                <td style={{ padding: "6px 0", textAlign: "right", color: r.unrealized >= 0 ? "#059669" : "#dc2626" }}>
                  {r.unrealized >= 0 ? "+" : ""}${r.unrealized.toFixed(2)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "8px 0", color: "#6b7280" }}>No holdings</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreGame() {
  const [years, setYears] = useState(2);
  const [seed, setSeed] = useState<number | "">("");
  const [count, setCount] = useState<number>(gameStore.companyCount);
  const [isSimulating, setIsSimulating] = useState(false);
  return (
    <div className="pregame">
      <h2>LLM Stock Game</h2>
      <p className="subtitle">Preview the market before you start playing.</p>
      <div className="pregame-controls">
        <label>
          History:
          <select value={years} onChange={(e) => setYears(Number(e.target.value))}>
            <option value={1}>1 year</option>
            <option value={2}>2 years</option>
            <option value={3}>3 years</option>
          </select>
        </label>
        <label style={{ marginLeft: 8 }}>
          Companies:
          <input
            type="number"
            min={5}
            max={40}
            value={count}
            onChange={(e) => setCount(Math.max(5, Math.min(40, Number(e.target.value))))}
            style={{ width: 72, marginLeft: 6 }}
          />
        </label>
        <label style={{ marginLeft: 8 }}>
          Seed:
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder="random"
            style={{ width: 120, marginLeft: 6 }}
          />
        </label>
        <button
          className="btn btn-primary"
          disabled={isSimulating}
          onClick={() => {
            setIsSimulating(true);
            // rebuild universe with fresh companies
            gameStore.resetUniverse({ years, companyCount: count, seed: seed === "" ? undefined : seed });
            setIsSimulating(false);
          }}
        >Generate History</button>
        <button
          className="btn"
          onClick={() => gameStore.startNewGame()}
        >Start Game</button>
      </div>
      <CompaniesGrid />
    </div>
  );
}

function GameComponent() {
  return (
    <div className="game-shell">
      {gameStore.gameStarted ? (
        <>
          <div className="topbar">
            <h2>LLM Stock Game</h2>
            <div className="grow" />
            <div className="week">Year {gameStore.yearSinceGameStart}</div>
          </div>
          <Controls />
          <PortfolioSummary />
          <PortfolioChart />
          <div className="cards-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <HoldingsTable title="Your Holdings" rows={gameStore.playerHoldingsArray} cash={gameStore.cash} />
            <div style={{ display: "grid", gridTemplateRows: "1fr 1fr", gap: 12 }}>
              <HoldingsTable title="Gemini Holdings" rows={gameStore.geminiHoldingsArray} cash={gameStore.geminiCash} />
              <HoldingsTable title="Claude Holdings" rows={gameStore.claudeHoldingsArray} cash={gameStore.claudeCash} />
            </div>
          </div>
          <div className="cards-grid" style={{ gridTemplateColumns: "1fr", gap: 12, marginTop: 12 }}>
            <HoldingsTable title="GPT-5 Holdings" rows={gameStore.gpt5HoldingsArray} cash={gameStore.gpt5Cash} />
          </div>
          <CompaniesGrid />
          <div style={{ marginTop: 12, color: "#9ca3af" }}>
            Realized PnL: <Currency value={gameStore.realizedPnL} />
          </div>
        </>
      ) : (
        <PreGame />
      )}
    </div>
  );
}

export const Game = observer(GameComponent);


