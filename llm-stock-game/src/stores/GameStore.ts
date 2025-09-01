import { makeAutoObservable, observable } from "mobx";
import { RNG, MarketEnv, SectorIndex, Company, type CompanyInit } from "../objects/market-sim";
import { requestGeminiDecisions } from "../data/openRouterApi";
import { MODEL_PRESETS } from "./ChatStore";

export type Holding = {
  ticker: string;
  quantity: number;
  avgCostBasis: number; // weighted average cost per share
};

type SectorName =
  | "Technology"
  | "Healthcare"
  | "Energy"
  | "Utilities"
  | "Consumer"
  | "Industrials"
  | "Financials"
  | "Materials"
  | "Communication"
  | "RealEstate";

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export class GameStore {
  rng: RNG;
  market: MarketEnv;
  sectors: Record<SectorName, SectorIndex>;
  companies: Company[] = [];
  week = 0; // total simulated weeks (history timeline)

  // Game phase
  gameStarted = false;
  gameStartWeek = 0; // snapshot of week when gameplay begins

  // Player state
  startingCash = 10000;
  cash = 10000;
  holdings = observable.map<string, Holding>();
  realizedPnL = 0;

  // Universe config
  companyCount = 10;

  // Control
  private timer: number | null = null;
  speedMs = 600; // per simulated week

  // Benchmark
  private startingPrices = new Map<string, number>();
  // (deprecated) average-price baseline removed; we now use investable benchmark value

  // Series for charts (normalized to 1 at game start)
  portfolioSeries: number[] = [];
  benchmarkSeries: number[] = [];
  geminiSeries: number[] = [];
  claudeSeries: number[] = [];
  gpt5Series: number[] = [];

  // Gemini competitor state
  geminiCash = 10000;
  geminiHoldings = observable.map<string, Holding>();
  private geminiDeciding = false;
  private geminiLastDecisionYear = 0;

  // Claude competitor state
  claudeCash = 10000;
  claudeHoldings = observable.map<string, Holding>();
  private claudeDeciding = false;
  private claudeLastDecisionYear = 0;

  // GPT-5 competitor state
  gpt5Cash = 10000;
  gpt5Holdings = observable.map<string, Holding>();
  private gpt5Deciding = false;
  private gpt5LastDecisionYear = 0;

  

  // Track cumulative split factors since game start to de-split benchmark prices
  private splitAdjusters = new Map<string, number>();
  // Equal-weight benchmark: shares bought at game start using startingCash
  private benchmarkShares = new Map<string, number>();

  constructor() {
    this.rng = new RNG();
    this.market = new MarketEnv(this.rng);
    this.sectors = this.buildSectors();
    this.createCompanies(this.companyCount);
    makeAutoObservable(this);

    // Default: pre-generate 3 years of market history and start the game
    // 48 weeks ≈ 1 year
    this.preSimulate(48 * 3);
    this.startNewGame();
  }

  private buildSectors(): Record<SectorName, SectorIndex> {
    return {
      Technology: new SectorIndex("Technology", { baselineGrowth: 0.003, peAdj: 1.15 }),
      Healthcare: new SectorIndex("Healthcare", { baselineGrowth: 0.0023, peAdj: 1.06 }),
      Energy: new SectorIndex("Energy", { baselineGrowth: 0.0017, peAdj: 0.95 }),
      Utilities: new SectorIndex("Utilities", { baselineGrowth: 0.0012, peAdj: 0.9 }),
      Consumer: new SectorIndex("Consumer", { baselineGrowth: 0.0020, peAdj: 1.02 }),
      Industrials: new SectorIndex("Industrials", { baselineGrowth: 0.0018, peAdj: 0.98 }),
      Financials: new SectorIndex("Financials", { baselineGrowth: 0.0019, peAdj: 0.96 }),
      Materials: new SectorIndex("Materials", { baselineGrowth: 0.0016, peAdj: 0.94 }),
      Communication: new SectorIndex("Communication", { baselineGrowth: 0.0021, peAdj: 1.03 }),
      RealEstate: new SectorIndex("RealEstate", { baselineGrowth: 0.0015, peAdj: 0.92 })
    };
  }

  private createCompanies(count: number) {
    const sectorNames = Object.keys(this.sectors) as SectorName[];
    const usedTickers = new Set<string>();

    const genTicker = () => {
      let t = "";
      do {
        t = Array.from({ length: 3 + Math.floor(this.rng.random() * 2) }, () =>
          String.fromCharCode(65 + Math.floor(this.rng.random() * 26))
        ).join("");
      } while (usedTickers.has(t));
      usedTickers.add(t);
      return t;
    };

    const companies: Company[] = [];
    for (let i = 0; i < count; i++) {
      const sector = this.rng.pick(sectorNames);
      const risk: CompanyInit["riskProfile"] = this.rng.pick(["low", "medium", "high"]);
      const stage: CompanyInit["stage"] = this.rng.pick(["startup", "growth", "mature", "decline"]);

      const baseRevenue = 1_500_000 + this.rng.random() * 6_000_000; // annualized spread; will divide by 48
      const weeklyRevenue = baseRevenue / 48;
      // expenses relative to revenue and risk/stage (tuned to make chronic unprofitability rarer)
      const expenseFactor = 0.5 + (risk === "high" ? 0.12 : risk === "medium" ? 0.07 : 0.03) + (stage === "startup" ? 0.12 : stage === "growth" ? 0.06 : 0);
      const weeklyExpenses = weeklyRevenue * expenseFactor;

      const init: CompanyInit = {
        name: `${sector} Corp ${i + 1}`,
        ticker: genTicker(),
        sector,
        description: `${sector} company (${stage}, ${risk}).`,
        revenue: weeklyRevenue,
        expenses: weeklyExpenses,
        shares: Math.floor(2_000_000 + this.rng.random() * 8_000_000),
        riskProfile: risk,
        stage,
        payoutRatio: stage === "mature" ? 0.2 + this.rng.random() * 0.4 : 0,
        targetYield: stage === "mature" ? 0.02 + this.rng.random() * 0.03 : undefined,
        capexRate: sector === "Utilities" ? 0.08 : 0.03 + this.rng.random() * 0.05,
        rAndDRate: stage === "startup" || stage === "growth" ? 0.1 + this.rng.random() * 0.15 : 0.02 + this.rng.random() * 0.04,
        sentiment: this.rng.normal(0, 0.2),
        cash: weeklyRevenue * (6 + this.rng.random() * 12),
        debt: weeklyRevenue * (risk === "high" ? 40 : risk === "medium" ? 24 : 12),
        assets: weeklyRevenue * (risk === "high" ? 80 : 120)
      };
      const c = new Company(init);
      companies.push(c);
    }

    this.companies = companies;
    // record starting prices
    for (const c of this.companies) {
      this.startingPrices.set(c.ticker, c.price);
    }
  }

  /**
   * Rebuild the entire market universe: new RNG/market/sectors/companies and optional history.
   */
  resetUniverse(opts?: { seed?: number; companyCount?: number; years?: number }) {
    const seed = opts?.seed ?? (Math.floor(Math.random() * 2 ** 31) >>> 0);
    if (typeof opts?.companyCount === "number" && opts.companyCount > 0) {
      this.companyCount = Math.floor(opts.companyCount);
    }
    // Reset timeline and systems
    this.week = 0;
    this.rng = new RNG(seed);
    this.market = new MarketEnv(this.rng);
    this.sectors = this.buildSectors();
    this.companies = [];
    this.startingPrices.clear();
    this.createCompanies(this.companyCount);
    // also reset split adjusters and benchmark shares for a fresh universe (pregame)
    this.splitAdjusters.clear();
    this.benchmarkShares.clear();
    for (const c of this.companies) this.splitAdjusters.set(c.ticker, 1);
    // Optional pre-simulation history
    const years = Math.max(0, Math.floor(opts?.years ?? 0));
    if (years > 0) this.preSimulate(years * 48);
    // Return to pre-game phase
    this.gameStarted = false;
    this.gameStartWeek = 0;
  }

  // ---------------- Gameplay lifecycle ----------------

  /**
   * Pre-simulate a number of weeks to build history before the player starts.
   * Does not alter player state; only advances the simulated timeline.
   */
  preSimulate(weeks: number) {
    const clamped = Math.max(0, Math.min(weeks, 52 * 10));
    for (let i = 0; i < clamped; i++) this.step();
  }

  /**
   * Resets player state and establishes the current week as the gameplay start.
   * Keeps company histories so charts can show the prior years.
   */
  startNewGame() {
    // Reset player state
    this.cash = this.startingCash;
    this.holdings.clear();
    this.realizedPnL = 0;
    // Re-base benchmarks at current prices so comparisons start now
    this.startingPrices.clear();
    for (const c of this.companies) this.startingPrices.set(c.ticker, c.price);
    // Reset split adjusters and initialize benchmark shares
    this.splitAdjusters.clear();
    this.benchmarkShares.clear();
    for (const c of this.companies) this.splitAdjusters.set(c.ticker, 1);
    // Create equal-weight benchmark positions using startingCash
    const n = Math.max(1, this.companies.length);
    const investPer = this.startingCash / n;
    for (const c of this.companies) {
      const p0 = this.startingPrices.get(c.ticker) ?? c.price;
      const sh = p0 > 0 ? investPer / p0 : 0;
      this.benchmarkShares.set(c.ticker, sh);
    }
    // Initialize chart baselines
    this.portfolioSeries = [1];
    this.benchmarkSeries = [1];
    this.geminiSeries = [1];
    this.claudeSeries = [1];
    this.gpt5Series = [1];
    // Reset Gemini competitor
    this.geminiCash = this.startingCash;
    this.geminiHoldings.clear();
    this.geminiLastDecisionYear = 0;
    this.geminiDeciding = false;
    // Reset Claude competitor
    this.claudeCash = this.startingCash;
    this.claudeHoldings.clear();
    this.claudeLastDecisionYear = 0;
    this.claudeDeciding = false;
    // Reset GPT-5 competitor
    this.gpt5Cash = this.startingCash;
    this.gpt5Holdings.clear();
    this.gpt5LastDecisionYear = 0;
    this.gpt5Deciding = false;
    
    // Phase flags
    this.gameStarted = true;
    this.gameStartWeek = this.week;
    // Trigger immediate Gemini decision at game start so it buys right away
    this.geminiDeciding = true;
    this.evaluateGeminiYearly()
      .catch(() => {})
      .finally(() => {
        this.geminiDeciding = false;
      });
    // Trigger immediate Claude/GPT-5 decisions
    this.claudeDeciding = true;
    this.evaluateClaudeYearly()
      .catch(() => {})
      .finally(() => {
        this.claudeDeciding = false;
      });
    this.gpt5Deciding = true;
    this.evaluateGpt5Yearly()
      .catch(() => {})
      .finally(() => {
        this.gpt5Deciding = false;
      });
    
  }

  get holdingsValue(): number {
    let total = 0;
    for (const c of this.companies) {
      const h = this.holdings.get(c.ticker);
      if (h && h.quantity > 0) total += h.quantity * c.price;
    }
    return total;
  }

  get totalValue(): number {
    return this.cash + this.holdingsValue;
  }

  /**
   * Dynamic trade increment that scales with portfolio value by powers of 10.
   * 10k -> $1k, 100k -> $10k, 1M -> $100k, etc. Minimum $1k.
   */
  get tradeIncrement(): number {
    const v = Math.max(1, this.totalValue);
    // Base threshold at 10k; step every 10x
    const scale = Math.max(0, Math.floor(Math.log10(v) - Math.log10(10_000)));
    const increment = 1_000 * Math.pow(10, scale);
    return Math.max(1_000, increment);
  }

  get totalReturnPct(): number {
    const start = this.startingCash;
    return start > 0 ? (this.totalValue - start) / start : 0;
  }

  // Equal-weight benchmark value using current de-split prices
  get benchmarkValue(): number {
    let total = 0;
    for (const c of this.companies) {
      const sh = this.benchmarkShares.get(c.ticker) ?? 0;
      if (sh <= 0) continue;
      const adj = this.splitAdjusters.get(c.ticker) ?? 1;
      const priceAdj = c.price * adj;
      total += sh * priceAdj;
    }
    return total;
  }

  get benchmarkAvgReturnPct(): number {
    const start = this.startingCash;
    const current = this.benchmarkValue;
    return start > 0 ? (current - start) / start : 0;
  }

  /** Weeks since gameplay started. */
  private get elapsedWeeks(): number {
    return this.gameStarted ? Math.max(0, this.week - this.gameStartWeek) : 0;
  }

  /** Years since gameplay started, using 48 weeks ≈ 1 year for this sim. */
  private get elapsedYears(): number {
    return this.elapsedWeeks / 48;
  }

  /** Integer year counter since gameplay started (1-indexed). */
  get yearSinceGameStart(): number {
    const weeks = this.elapsedWeeks;
    return 1 + Math.floor(weeks / 48);
  }

  /** Portfolio CAGR since game start (cash + holdings). */
  get portfolioCAGR(): number {
    const years = this.elapsedYears;
    if (years <= 0) return 0;
    const ratio = this.startingCash > 0 ? this.totalValue / this.startingCash : 1;
    // Do not annualize if less than 1 simulated year has elapsed
    if (years < 1) return (ratio - 1);
    return Math.pow(Math.max(ratio, 0.000001), 1 / Math.max(years, 0.000001)) - 1;
  }

  /** Benchmark average price CAGR since game start. */
  get benchmarkCAGR(): number {
    const years = this.elapsedYears;
    if (years <= 0) return 0;
    // Use investable benchmark value (equal-weight using starting cash),
    // not raw average price, so it is directly comparable to portfolio CAGR.
    const ratio = this.startingCash > 0 ? this.benchmarkValue / this.startingCash : 1;
    if (years < 1) return (ratio - 1);
    return Math.pow(Math.max(ratio, 0.000001), 1 / Math.max(years, 0.000001)) - 1;
  }

  get companyByTicker(): Map<string, Company> {
    const m = new Map<string, Company>();
    for (const c of this.companies) m.set(c.ticker, c);
    return m;
  }

  step() {
    this.week += 1;
    this.market.update();
    const sectorsArr = Object.values(this.sectors);
    for (const s of sectorsArr) s.update(this.market, this.rng);
    for (const c of this.companies) {
      const sector = this.sectors[c.sector as SectorName] ?? sectorsArr[0];
      c.simulateWeek(this.week, this.market, sector, this.rng);
      // If company performed a split-like operation (implicit or explicit), adjust player holdings proportionally
      if (c.pendingSplitFactor !== 1) {
        const h = this.holdings.get(c.ticker);
        if (h && h.quantity > 0) {
          const f = c.pendingSplitFactor;
          // sharesOutstanding scaled by f; to keep position value invariant (ignoring price rounding), scale held quantity by f too
          h.quantity = Math.floor(h.quantity * f);
          // average cost per share should scale inversely so total cost basis remains consistent
          if (f !== 0) h.avgCostBasis = h.avgCostBasis / f;
          this.holdings.set(c.ticker, h);
        }
        // Adjust Gemini holdings similarly
        const gh = this.geminiHoldings.get(c.ticker);
        if (gh && gh.quantity > 0) {
          const f = c.pendingSplitFactor;
          gh.quantity = Math.floor(gh.quantity * f);
          if (f !== 0) gh.avgCostBasis = gh.avgCostBasis / f;
          this.geminiHoldings.set(c.ticker, gh);
        }
        // Adjust Claude holdings
        const ch = this.claudeHoldings.get(c.ticker);
        if (ch && ch.quantity > 0) {
          const f = c.pendingSplitFactor;
          ch.quantity = Math.floor(ch.quantity * f);
          if (f !== 0) ch.avgCostBasis = ch.avgCostBasis / f;
          this.claudeHoldings.set(c.ticker, ch);
        }
        // Adjust GPT-5 holdings
        const th = this.gpt5Holdings.get(c.ticker);
        if (th && th.quantity > 0) {
          const f = c.pendingSplitFactor;
          th.quantity = Math.floor(th.quantity * f);
          if (f !== 0) th.avgCostBasis = th.avgCostBasis / f;
          this.gpt5Holdings.set(c.ticker, th);
        }
        
        // update split adjuster so benchmark is de-split (price continuity)
        const prevAdj = this.splitAdjusters.get(c.ticker) ?? 1;
        this.splitAdjusters.set(c.ticker, prevAdj * c.pendingSplitFactor);
      }
    }

    // Update portfolio and benchmark series if game started
    if (this.gameStarted) {
      const portNorm = this.startingCash > 0 ? this.totalValue / this.startingCash : 1;
      const benchNorm = this.startingCash > 0 ? this.benchmarkValue / this.startingCash : 1;
      const gemNorm = this.startingCash > 0 ? this.geminiTotalValue / this.startingCash : 1;
      const claudeNorm = this.startingCash > 0 ? this.claudeTotalValue / this.startingCash : 1;
      const gpt5Norm = this.startingCash > 0 ? this.gpt5TotalValue / this.startingCash : 1;
      this.portfolioSeries.push(portNorm);
      this.benchmarkSeries.push(benchNorm);
      this.geminiSeries.push(gemNorm);
      this.claudeSeries.push(claudeNorm);
      this.gpt5Series.push(gpt5Norm);
      // keep recent window reasonable
      const maxLen = 4000; // enough for long sessions
      if (this.portfolioSeries.length > maxLen) this.portfolioSeries.shift();
      if (this.benchmarkSeries.length > maxLen) this.benchmarkSeries.shift();
      if (this.geminiSeries.length > maxLen) this.geminiSeries.shift();
      if (this.claudeSeries.length > maxLen) this.claudeSeries.shift();
      if (this.gpt5Series.length > maxLen) this.gpt5Series.shift();

      // Trigger Gemini yearly decision exactly at each 48-week boundary since game start
      const weeks = this.elapsedWeeks;
      if (weeks > 0 && weeks % 48 === 0) {
        const yearIdx = 1 + Math.floor(weeks / 48) - 1; // 1-indexed years
        if (!this.geminiDeciding && this.geminiLastDecisionYear < yearIdx) {
          this.geminiDeciding = true;
          this.evaluateGeminiYearly()
            .catch(() => {})
            .finally(() => {
              this.geminiLastDecisionYear = yearIdx;
              this.geminiDeciding = false;
            });
        }
        if (!this.claudeDeciding && this.claudeLastDecisionYear < yearIdx) {
          this.claudeDeciding = true;
          this.evaluateClaudeYearly()
            .catch(() => {})
            .finally(() => {
              this.claudeLastDecisionYear = yearIdx;
              this.claudeDeciding = false;
            });
        }
        if (!this.gpt5Deciding && this.gpt5LastDecisionYear < yearIdx) {
          this.gpt5Deciding = true;
          this.evaluateGpt5Yearly()
            .catch(() => {})
            .finally(() => {
              this.gpt5LastDecisionYear = yearIdx;
              this.gpt5Deciding = false;
            });
        }
      }
    }
  }

  start() {
    if (this.timer != null) return;
    this.timer = (setInterval(() => this.step(), this.speedMs) as unknown) as number;
  }

  stop() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setSpeed(ms: number) {
    this.speedMs = clamp(ms, 80, 5000);
    if (this.timer != null) {
      this.stop();
      this.start();
    }
  }

  // Buy using a dollar amount rounded to nearest $1k; fallback to 1 share if affordable
  buy(ticker: string, dollarAmount: number) {
    const company = this.companyByTicker.get(ticker);
    if (!company) return;
    const rounded = Math.round(Math.max(0, dollarAmount) / 1000) * 1000;
    const budget = Math.min(rounded, Math.floor(this.cash));
    // Convert dollars to whole shares
    let shares = Math.floor(budget / Math.max(1, company.price));
    // Fallback: if rounding yields 0 shares but we can afford at least 1 share, buy 1
    if (shares <= 0 && this.cash >= company.price) {
      shares = 1;
    }
    if (shares <= 0) return;
    const cost = shares * company.price;
    if (cost > this.cash) return;
    this.cash -= cost;
    const existing = this.holdings.get(ticker);
    if (!existing) {
      this.holdings.set(ticker, { ticker, quantity: shares, avgCostBasis: company.price });
    } else {
      const newQty = existing.quantity + shares;
      const newCost = (existing.avgCostBasis * existing.quantity + cost) / newQty;
      existing.quantity = newQty;
      existing.avgCostBasis = newCost;
      this.holdings.set(ticker, existing);
    }
    // price impact: buys push price up
    this.applyTradeImpact(company, shares, "buy");
  }

  // Sell using a dollar amount rounded to nearest $1k
  sell(ticker: string, dollarAmount: number) {
    const company = this.companyByTicker.get(ticker);
    if (!company) return;
    const existing = this.holdings.get(ticker);
    if (!existing || existing.quantity <= 0) return;
    const rounded = Math.round(Math.max(0, dollarAmount) / 1000) * 1000;
    // Convert dollars to shares
    const sharesReq = Math.floor(rounded / Math.max(1, company.price));
    const qty = Math.min(sharesReq, existing.quantity);
    if (qty <= 0) return;
    const proceeds = company.price * qty;
    this.cash += proceeds;
    existing.quantity -= qty;
    // realized PnL (simplified using avg cost)
    this.realizedPnL += (company.price - existing.avgCostBasis) * qty;
    if (existing.quantity <= 0) {
      this.holdings.delete(ticker);
    } else {
      this.holdings.set(ticker, existing);
    }
    // price impact: sells push price down
    this.applyTradeImpact(company, qty, "sell");
  }

  // Average price helper removed; comparisons use benchmarkValue normalized to starting cash

  // ---------------- Gemini competitor logic ----------------

  get geminiHoldingsValue(): number {
    let total = 0;
    for (const c of this.companies) {
      const h = this.geminiHoldings.get(c.ticker);
      if (h && h.quantity > 0) total += h.quantity * c.price;
    }
    return total;
  }

  get geminiTotalValue(): number {
    return this.geminiCash + this.geminiHoldingsValue;
  }

  get geminiCAGR(): number {
    const years = this.elapsedYears;
    if (years <= 0) return 0;
    const ratio = this.startingCash > 0 ? this.geminiTotalValue / this.startingCash : 1;
    if (years < 1) return (ratio - 1);
    return Math.pow(Math.max(ratio, 0.000001), 1 / Math.max(years, 0.000001)) - 1;
  }

  // ---------------- Claude competitor logic ----------------

  get claudeHoldingsValue(): number {
    let total = 0;
    for (const c of this.companies) {
      const h = this.claudeHoldings.get(c.ticker);
      if (h && h.quantity > 0) total += h.quantity * c.price;
    }
    return total;
  }

  get claudeTotalValue(): number {
    return this.claudeCash + this.claudeHoldingsValue;
  }

  get claudeCAGR(): number {
    const years = this.elapsedYears;
    if (years <= 0) return 0;
    const ratio = this.startingCash > 0 ? this.claudeTotalValue / this.startingCash : 1;
    if (years < 1) return (ratio - 1);
    return Math.pow(Math.max(ratio, 0.000001), 1 / Math.max(years, 0.000001)) - 1;
  }

  // ---------------- GPT-5 competitor logic ----------------

  get gpt5HoldingsValue(): number {
    let total = 0;
    for (const c of this.companies) {
      const h = this.gpt5Holdings.get(c.ticker);
      if (h && h.quantity > 0) total += h.quantity * c.price;
    }
    return total;
  }

  get gpt5TotalValue(): number {
    return this.gpt5Cash + this.gpt5HoldingsValue;
  }

  get gpt5CAGR(): number {
    const years = this.elapsedYears;
    if (years <= 0) return 0;
    const ratio = this.startingCash > 0 ? this.gpt5TotalValue / this.startingCash : 1;
    if (years < 1) return (ratio - 1);
    return Math.pow(Math.max(ratio, 0.000001), 1 / Math.max(years, 0.000001)) - 1;
  }

  

  private buildGeminiStockViews() {
    return this.companies.map(c => ({
      ticker: c.ticker,
      sector: c.sector,
      stage: c.stage,
      riskProfile: c.riskProfile,
      price: c.price,
      peTTM: c.peTTM,
      psTTM: c.psTTM,
      ttmRevenue: c.ttmRevenue,
      ttmMargin: c.ttmMargin,
      debtToEquity: c.debtToEquity,
      sentiment: c.sentiment,
    }));
  }

  // Detailed holdings views for UI
  get playerHoldingsArray() {
    return Array.from(this.holdings.values()).map(h => {
      const c = this.companyByTicker.get(h.ticker);
      const price = c?.price ?? 0;
      const value = price * h.quantity;
      const unrealized = (price - h.avgCostBasis) * h.quantity;
      const sector = c?.sector ?? "";
      return { ...h, price, value, unrealized, sector };
    }).sort((a, b) => b.value - a.value);
  }

  get geminiHoldingsArray() {
    return Array.from(this.geminiHoldings.values()).map(h => {
      const c = this.companyByTicker.get(h.ticker);
      const price = c?.price ?? 0;
      const value = price * h.quantity;
      const unrealized = (price - h.avgCostBasis) * h.quantity;
      const sector = c?.sector ?? "";
      return { ...h, price, value, unrealized, sector };
    }).sort((a, b) => b.value - a.value);
  }

  get claudeHoldingsArray() {
    return Array.from(this.claudeHoldings.values()).map(h => {
      const c = this.companyByTicker.get(h.ticker);
      const price = c?.price ?? 0;
      const value = price * h.quantity;
      const unrealized = (price - h.avgCostBasis) * h.quantity;
      const sector = c?.sector ?? "";
      return { ...h, price, value, unrealized, sector };
    }).sort((a, b) => b.value - a.value);
  }

  get gpt5HoldingsArray() {
    return Array.from(this.gpt5Holdings.values()).map(h => {
      const c = this.companyByTicker.get(h.ticker);
      const price = c?.price ?? 0;
      const value = price * h.quantity;
      const unrealized = (price - h.avgCostBasis) * h.quantity;
      const sector = c?.sector ?? "";
      return { ...h, price, value, unrealized, sector };
    }).sort((a, b) => b.value - a.value);
  }

  

  private applyGeminiBuy(ticker: string, dollars: number) {
    const company = this.companyByTicker.get(ticker);
    if (!company) return;
    const budget = Math.min(Math.max(0, Math.floor(dollars)), Math.floor(this.geminiCash));
    const shares = Math.floor(budget / Math.max(1, company.price));
    if (shares <= 0) return;
    const cost = shares * company.price;
    if (cost > this.geminiCash) return;
    this.geminiCash -= cost;
    const existing = this.geminiHoldings.get(ticker);
    if (!existing) {
      this.geminiHoldings.set(ticker, { ticker, quantity: shares, avgCostBasis: company.price });
    } else {
      const newQty = existing.quantity + shares;
      const newCost = (existing.avgCostBasis * existing.quantity + cost) / newQty;
      existing.quantity = newQty;
      existing.avgCostBasis = newCost;
      this.geminiHoldings.set(ticker, existing);
    }
    try {
      console.log("[Gemini] BUY executed", { ticker, shares, price: company.price, cost, remainingCash: this.geminiCash });
    } catch {}
    // price impact
    this.applyTradeImpact(company, shares, "buy");
  }

  private applyGeminiSell(ticker: string, dollars: number) {
    const company = this.companyByTicker.get(ticker);
    if (!company) return;
    const existing = this.geminiHoldings.get(ticker);
    if (!existing || existing.quantity <= 0) return;
    const sharesReq = Math.floor(Math.max(0, Math.floor(dollars)) / Math.max(1, company.price));
    const qty = Math.min(sharesReq, existing.quantity);
    if (qty <= 0) return;
    const proceeds = company.price * qty;
    this.geminiCash += proceeds;
    existing.quantity -= qty;
    if (existing.quantity <= 0) {
      this.geminiHoldings.delete(ticker);
    } else {
      this.geminiHoldings.set(ticker, existing);
    }
    try {
      console.log("[Gemini] SELL executed", { ticker, shares: qty, price: company.price, proceeds, newCash: this.geminiCash });
    } catch {}
    // price impact
    this.applyTradeImpact(company, qty, "sell");
  }

  private applyClaudeBuy(ticker: string, dollars: number) {
    const company = this.companyByTicker.get(ticker);
    if (!company) return;
    const budget = Math.min(Math.max(0, Math.floor(dollars)), Math.floor(this.claudeCash));
    const shares = Math.floor(budget / Math.max(1, company.price));
    if (shares <= 0) return;
    const cost = shares * company.price;
    if (cost > this.claudeCash) return;
    this.claudeCash -= cost;
    const existing = this.claudeHoldings.get(ticker);
    if (!existing) {
      this.claudeHoldings.set(ticker, { ticker, quantity: shares, avgCostBasis: company.price });
    } else {
      const newQty = existing.quantity + shares;
      const newCost = (existing.avgCostBasis * existing.quantity + cost) / newQty;
      existing.quantity = newQty;
      existing.avgCostBasis = newCost;
      this.claudeHoldings.set(ticker, existing);
    }
    try {
      console.log("[Claude] BUY executed", { ticker, shares, price: company.price, cost, remainingCash: this.claudeCash });
    } catch {}
    // price impact
    this.applyTradeImpact(company, shares, "buy");
  }

  private applyClaudeSell(ticker: string, dollars: number) {
    const company = this.companyByTicker.get(ticker);
    if (!company) return;
    const existing = this.claudeHoldings.get(ticker);
    if (!existing || existing.quantity <= 0) return;
    const sharesReq = Math.floor(Math.max(0, Math.floor(dollars)) / Math.max(1, company.price));
    const qty = Math.min(sharesReq, existing.quantity);
    if (qty <= 0) return;
    const proceeds = company.price * qty;
    this.claudeCash += proceeds;
    existing.quantity -= qty;
    if (existing.quantity <= 0) {
      this.claudeHoldings.delete(ticker);
    } else {
      this.claudeHoldings.set(ticker, existing);
    }
    try {
      console.log("[Claude] SELL executed", { ticker, shares: qty, price: company.price, proceeds, newCash: this.claudeCash });
    } catch {}
    // price impact
    this.applyTradeImpact(company, qty, "sell");
  }

  private applyGpt5Buy(ticker: string, dollars: number) {
    const company = this.companyByTicker.get(ticker);
    if (!company) return;
    const budget = Math.min(Math.max(0, Math.floor(dollars)), Math.floor(this.gpt5Cash));
    const shares = Math.floor(budget / Math.max(1, company.price));
    if (shares <= 0) return;
    const cost = shares * company.price;
    if (cost > this.gpt5Cash) return;
    this.gpt5Cash -= cost;
    const existing = this.gpt5Holdings.get(ticker);
    if (!existing) {
      this.gpt5Holdings.set(ticker, { ticker, quantity: shares, avgCostBasis: company.price });
    } else {
      const newQty = existing.quantity + shares;
      const newCost = (existing.avgCostBasis * existing.quantity + cost) / newQty;
      existing.quantity = newQty;
      existing.avgCostBasis = newCost;
      this.gpt5Holdings.set(ticker, existing);
    }
    try {
      console.log("[GPT-5] BUY executed", { ticker, shares, price: company.price, cost, remainingCash: this.gpt5Cash });
    } catch {}
    // price impact
    this.applyTradeImpact(company, shares, "buy");
  }

  private applyGpt5Sell(ticker: string, dollars: number) {
    const company = this.companyByTicker.get(ticker);
    if (!company) return;
    const existing = this.gpt5Holdings.get(ticker);
    if (!existing || existing.quantity <= 0) return;
    const sharesReq = Math.floor(Math.max(0, Math.floor(dollars)) / Math.max(1, company.price));
    const qty = Math.min(sharesReq, existing.quantity);
    if (qty <= 0) return;
    const proceeds = company.price * qty;
    this.gpt5Cash += proceeds;
    existing.quantity -= qty;
    if (existing.quantity <= 0) {
      this.gpt5Holdings.delete(ticker);
    } else {
      this.gpt5Holdings.set(ticker, existing);
    }
    try {
      console.log("[GPT-5] SELL executed", { ticker, shares: qty, price: company.price, proceeds, newCash: this.gpt5Cash });
    } catch {}
    // price impact
    this.applyTradeImpact(company, qty, "sell");
  }

  /**
   * Apply simple price impact from an immediate trade. Scales with sqrt of relative size
   * and with a crude illiquidity proxy from the company's current baseVol.
   */
  private applyTradeImpact(company: Company, shares: number, side: "buy" | "sell") {
    const sign = side === "buy" ? 1 : -1;
    const floatShares = Math.max(1, company.sharesOutstanding);
    const relativeSize = Math.max(0, shares) / floatShares;
    // illiquidity: higher baseVol -> bigger impact; center around 0.02
    const illiquidity = clamp(1 + 20 * (company.baseVol - 0.02), 0.6, 1.8);
    const impactBase = 0.6; // tune global sensitivity
    const rawImpact = impactBase * Math.sqrt(relativeSize) * illiquidity;
    const impactPct = clamp(sign * rawImpact, -0.06, 0.06); // cap at +/-6%
    company.price = Math.max(0.5, company.price * (1 + impactPct));
  }

  

  private async evaluateGeminiYearly() {
    // Build clean inputs
    const stocks = this.buildGeminiStockViews();
    const holdings = Array.from(this.geminiHoldings.values()).map(h => ({
      ticker: h.ticker,
      quantity: h.quantity,
      avgCostBasis: h.avgCostBasis,
    }));
    try {
      console.log("[Gemini] Yearly evaluation starting", { year: this.yearSinceGameStart, cash: this.geminiCash, holdingsCount: holdings.length });
      const resp = await requestGeminiDecisions(stocks, this.geminiCash, holdings, {
        model: MODEL_PRESETS.GEMINI,
        temperature: 0.2,
      });
      console.log("[Gemini] Yearly evaluation result", resp);
      for (const d of resp.decisions) {
        if (d.action === "BUY") this.applyGeminiBuy(d.ticker, d.dollars);
        else this.applyGeminiSell(d.ticker, d.dollars);
      }
      console.log("[Gemini] Post-trade portfolio", { totalValue: this.geminiTotalValue, cash: this.geminiCash, holdings: Array.from(this.geminiHoldings.values()) });
      // Immediately reflect new value in the latest chart point to avoid lag
      const lastIdx = this.geminiSeries.length - 1;
      if (lastIdx >= 0) {
        const gemNorm = this.startingCash > 0 ? this.geminiTotalValue / this.startingCash : 1;
        this.geminiSeries[lastIdx] = gemNorm;
      }
    } catch (e) {
      // ignore network or parsing errors; Gemini skips this year if it fails
      try {
        console.warn("[Gemini] Yearly evaluation failed", e);
      } catch {}
    }
  }

  private async evaluateClaudeYearly() {
    const stocks = this.buildGeminiStockViews();
    const holdings = Array.from(this.claudeHoldings.values()).map(h => ({
      ticker: h.ticker,
      quantity: h.quantity,
      avgCostBasis: h.avgCostBasis,
    }));
    try {
      console.log("[Claude] Yearly evaluation starting", { year: this.yearSinceGameStart, cash: this.claudeCash, holdingsCount: holdings.length });
      const resp = await requestGeminiDecisions(stocks, this.claudeCash, holdings, {
        model: MODEL_PRESETS.CLAUDE,
        temperature: 0.2,
      });
      console.log("[Claude] Yearly evaluation result", resp);
      for (const d of resp.decisions) {
        if (d.action === "BUY") this.applyClaudeBuy(d.ticker, d.dollars);
        else this.applyClaudeSell(d.ticker, d.dollars);
      }
      console.log("[Claude] Post-trade portfolio", { totalValue: this.claudeTotalValue, cash: this.claudeCash, holdings: Array.from(this.claudeHoldings.values()) });
      const lastIdx = this.claudeSeries.length - 1;
      if (lastIdx >= 0) {
        const norm = this.startingCash > 0 ? this.claudeTotalValue / this.startingCash : 1;
        this.claudeSeries[lastIdx] = norm;
      }
    } catch (e) {
      try {
        console.warn("[Claude] Yearly evaluation failed", e);
      } catch {}
    }
  }

  private async evaluateGpt5Yearly() {
    const stocks = this.buildGeminiStockViews();
    const holdings = Array.from(this.gpt5Holdings.values()).map(h => ({
      ticker: h.ticker,
      quantity: h.quantity,
      avgCostBasis: h.avgCostBasis,
    }));
    try {
      console.log("[GPT-5] Yearly evaluation starting", { year: this.yearSinceGameStart, cash: this.gpt5Cash, holdingsCount: holdings.length });
      const resp = await requestGeminiDecisions(stocks, this.gpt5Cash, holdings, {
        model: MODEL_PRESETS.CHATGPT,
        temperature: 0.2,
      });
      console.log("[GPT-5] Yearly evaluation result", resp);
      for (const d of resp.decisions) {
        if (d.action === "BUY") this.applyGpt5Buy(d.ticker, d.dollars);
        else this.applyGpt5Sell(d.ticker, d.dollars);
      }
      console.log("[GPT-5] Post-trade portfolio", { totalValue: this.gpt5TotalValue, cash: this.gpt5Cash, holdings: Array.from(this.gpt5Holdings.values()) });
      const lastIdx = this.gpt5Series.length - 1;
      if (lastIdx >= 0) {
        const norm = this.startingCash > 0 ? this.gpt5TotalValue / this.startingCash : 1;
        this.gpt5Series[lastIdx] = norm;
      }
    } catch (e) {
      try {
        console.warn("[GPT-5] Yearly evaluation failed", e);
      } catch {}
    }
  }

  
}

export const gameStore = new GameStore();


