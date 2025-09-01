// market-sim.ts
// Weekly stock simulator with macro, sector, sentiment, balance sheet, valuation,
// events, dividends, buybacks, splits, reverse splits, and bankruptcy.
// MobX-ready so your UI can bind directly.

import { makeAutoObservable } from "mobx";

// --------------------------- Types & Helpers ---------------------------

export type RiskProfile = "low" | "medium" | "high";
export type Stage = "startup" | "growth" | "mature" | "decline";
export type EventType =
  | "earnings"
  | "guidance"
  | "product"
  | "lawsuit"
  | "scandal"
  | "merger"
  | "dividend"
  | "buyback"
  | "split"
  | "downgrade"
  | "upgrade"
  | "regulatory"
  | "supply_chain"
  | "macro_shock"
  | "distress"
  | "bankruptcy";

export interface Event {
  type: EventType;
  description: string;

  // instant shocks
  priceShock?: number;   // +0.08 for +8%
  cashDelta?: number;    // absolute
  debtDelta?: number;    // absolute
  sharesDelta?: number;  // absolute, can be negative

  // one-time nudges
  revenueDeltaPct?: number;
  expenseDeltaPct?: number;

  // sticky effects
  driftDelta?: number;       // add to long run drift
  multipleDelta?: number;    // add to PE target as factor, eg +0.1 = +10%
  sentimentDelta?: number;   // add to sentiment

  durationWeeks?: number;
}

export interface HistoryPoint {
  week: number;
  price: number;
  revenue: number;
  expenses: number;
  eps: number;
  netIncome: number;
  cash: number;
  debt: number;
  assets: number;    // total assets including cash
  equity: number;
  shares: number;
  pe: number | null;
  ps: number;
  sentiment: number;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

// --------------------------- RNG (seedable) ---------------------------

export class RNG {
  private state: number;
  constructor(seed: number = (Date.now() >>> 0)) {
    this.state = seed >>> 0;
  }
  // mulberry32
  random(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(mean = 0, std = 1): number {
    let u = 0, v = 0;
    while (u === 0) u = this.random();
    while (v === 0) v = this.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + std * z;
  }
  tnorm(mean = 0, std = 1, lo = -Infinity, hi = Infinity): number {
    // Rejection sampling with a safety cap; falls back to clamping if too many retries
    let x = 0;
    let tries = 0;
    do {
      x = this.normal(mean, std);
      tries += 1;
      if (tries > 20) {
        x = clamp(x, lo, hi);
        break;
      }
    } while (x < lo || x > hi);
    return x;
  }
  chance(p: number) {
    return this.random() < p;
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.random() * arr.length)];
  }
}

// --------------------------- Macro & Sector ---------------------------

export class MarketEnv {
  week = 0;
  interestRate: number; // annual
  inflation: number;    // annual
  sentiment: number;    // -1..1
  vol: number;          // systemic weekly vol
  rng: RNG;

  constructor(rng: RNG, init?: Partial<MarketEnv>) {
    this.rng = rng;
    this.interestRate = init?.interestRate ?? 0.03;
    this.inflation = init?.inflation ?? 0.02;
    this.sentiment = init?.sentiment ?? 0;
    this.vol = init?.vol ?? 0.01;
  }

  basePE(): number {
    // map rates to a ballpark market PE
    const r = clamp(this.interestRate, 0, 0.12);
    const pe = 30 - 180 * (r - 0.02); // centered around 2 percent
    return clamp(pe, 10, 34);
  }

  update(): void {
    this.week += 1;

    // mean revert sentiment with noise
    this.sentiment = clamp(this.sentiment * 0.95 + this.rng.tnorm(0, 0.02, -0.08, 0.08), -1, 1);

    // gentle rate and inflation drift
    this.interestRate = clamp(this.interestRate + this.rng.normal(0, 0.0005), 0, 0.15);
    this.inflation = clamp(this.inflation + this.rng.normal(0, 0.0005), -0.02, 0.15);

    // rare macro shock
    if (this.rng.chance(0.01)) {
      const shock = this.rng.tnorm(0, 0.08, -0.2, 0.2);
      this.sentiment = clamp(this.sentiment + shock, -1, 1);
      this.interestRate = clamp(this.interestRate + 0.2 * shock, 0, 0.2);
      this.vol = clamp(this.vol + Math.abs(shock) * 0.02, 0.006, 0.04);
    } else {
      this.vol = clamp(this.vol * 0.995, 0.006, 0.03);
    }
  }

  // Weekly baseline return for equities so the whole market averages ~5–15%/yr
  expectedEquityReturnWeekly(): number {
    // Base around ~6–8%/yr -> ~0.0010–0.0016 weekly (48 weeks/year)
    const base = 0.0010; // ~4.8% annual baseline before other effects; other terms add on
    // Higher rates reduce expected returns a bit; positive sentiment nudges up
    const rateDrag = (this.interestRate - 0.02) * 0.25; // 1% over 2% cuts ~0.0025 annually
    const sentimentLift = this.sentiment * 0.0006;
    const weekly = base - rateDrag / 48 + sentimentLift;
    return clamp(weekly, 0.0001, 0.0018);
  }
}

export class SectorIndex {
  name: string;
  baselineGrowth: number; // weekly revenue growth
  vol: number;
  sentiment: number;      // -1..1
  peAdj: number;          // multiplies base PE

  constructor(name: string, init?: Partial<SectorIndex>) {
    this.name = name;
    this.baselineGrowth = init?.baselineGrowth ?? 0.002;
    this.vol = init?.vol ?? 0.012;
    this.sentiment = init?.sentiment ?? 0;
    this.peAdj = init?.peAdj ?? 1.0;
  }

  update(market: MarketEnv, rng: RNG): void {
    this.sentiment = clamp(this.sentiment * 0.9 + market.sentiment * 0.1 + rng.tnorm(0, 0.02, -0.08, 0.08), -1, 1);
    this.baselineGrowth = clamp(this.baselineGrowth + rng.normal(0, 0.0004) + market.inflation / 4800, -0.005, 0.01);
    this.peAdj = clamp(1 + this.sentiment * 0.25, 0.75, 1.35);
    this.vol = clamp(this.vol + rng.normal(0, 0.001), 0.006, 0.03);
  }
}

// --------------------------- Company ---------------------------

export interface CompanyInit {
  name: string;
  ticker: string;
  sector: string;
  description: string;

  revenue: number;   // weekly
  expenses: number;  // weekly opex excl R&D, interest, taxes, depreciation
  shares: number;

  cash?: number;
  debt?: number;
  assets?: number;   // operating assets, not including cash

  riskProfile?: RiskProfile;
  stage?: Stage;

  payoutRatio?: number;       // fraction of quarterly NI paid as dividend
  rAndDRate?: number;         // % revenue weekly
  capexRate?: number;         // % revenue weekly
  depreciationRate?: number;  // % operating assets weekly
  buybackRate?: number;       // fraction of excess cash used for buybacks at quarter
  targetYield?: number;       // cap quarterly dividend by target yield
  taxRate?: number;

  sentiment?: number;         // -1..1 initial
  marketShare?: number;
}

type ActiveEffect = {
  untilWeek: number;
  driftDelta: number;
  multipleDelta: number;
  sentimentDelta: number;
};

export class Company {
  // identity
  name: string;
  ticker: string;
  sector: string;
  description: string;

  // structure
  riskProfile: RiskProfile;
  stage: Stage;
  betaMarket: number;
  betaSector: number;

  // fundamentals
  revenue: number;        // weekly
  expenses: number;       // weekly opex
  rAndDRate: number;
  capexRate: number;
  depreciationRate: number;
  taxRate: number;

  cash: number;
  debt: number;
  assets: number;         // operating assets only (PP&E, intangibles)
  sharesOutstanding: number;

  // market behavior
  price: number;
  baseDrift: number;
  baseVol: number;
  sentiment: number;      // -1..1
  payoutRatio: number;
  targetYield?: number;
  buybackRate: number;

  marketShare: number;

  // internals
  history: HistoryPoint[] = [];
  quarterNetIncomeAcc = 0;
  negativeQuarterStreak = 0;
  activeEffects: ActiveEffect[] = [];
  isBankrupt = false;
  lowPriceStreak = 0;     // for reverse split
  lastBorrowRate = 0.08;  // cached effective annual borrow rate
  // Expose share change factor for split-like actions so the store can adjust holdings
  pendingSplitFactor = 1;

  constructor(init: CompanyInit) {
    this.name = init.name;
    this.ticker = init.ticker;
    this.sector = init.sector;
    this.description = init.description;

    this.revenue = init.revenue;
    this.expenses = init.expenses;
    this.sharesOutstanding = init.shares;

    this.cash = init.cash ?? Math.max(0, init.revenue * 8); // about 2 months of revenue
    this.debt = init.debt ?? init.revenue * (init.riskProfile === "high" ? 12 : 6);
    this.assets = Math.max(0, (init.assets ?? init.revenue * 20)); // operating assets only

    this.riskProfile = init.riskProfile ?? "medium";
    this.stage = init.stage ?? "mature";

    this.rAndDRate = init.rAndDRate ?? ((this.stage === "startup" || this.stage === "growth") ? 0.09 : 0.03);
    this.capexRate = init.capexRate ?? (this.sector === "Utilities" ? 0.08 : 0.04);
    this.depreciationRate = init.depreciationRate ?? 0.002; // about 10 percent annual
    this.taxRate = init.taxRate ?? 0.21;

    this.payoutRatio = clamp(init.payoutRatio ?? (this.stage === "mature" ? 0.4 : 0), 0, 0.9);
    this.targetYield = init.targetYield;
    this.buybackRate = clamp(init.buybackRate ?? 0.25, 0, 1);

    this.sentiment = clamp(init.sentiment ?? 0, -1, 1);
    this.marketShare = clamp(init.marketShare ?? 0.05, 0.001, 0.9);

    this.price = 100;
    this.baseDrift = 0.001 + this.margin * 0.01;
    this.baseVol = this.riskProfile === "low" ? 0.01 : this.riskProfile === "medium" ? 0.02 : 0.045;
    this.betaMarket = this.riskProfile === "low" ? 0.7 : this.riskProfile === "medium" ? 1.0 : 1.3;
    this.betaSector = this.riskProfile === "low" ? 0.8 : this.riskProfile === "medium" ? 1.0 : 1.2;

    makeAutoObservable(this, {}, { autoBind: true });
  }

  // ---------- Derived metrics ----------

  get totalAssets(): number {
    return this.assets + this.cash; // total assets for display and equity math
  }

  get equity(): number {
    return this.totalAssets - this.debt;
  }

  get interestRateSpread(): number {
    return this.riskProfile === "low" ? 0.01 : this.riskProfile === "medium" ? 0.03 : 0.06;
  }

  private currentNetIncomeEstimate(): number {
    const rnd = this.rAndDRate * this.revenue;
    const depreciation = this.depreciationRate * this.assets;
    const interest = this.debt * (this.lastBorrowRate / 48);
    const operatingIncome = this.revenue - this.expenses - rnd - depreciation;
    const pretax = operatingIncome - interest;
    const tax = Math.max(0, pretax) * this.taxRate;
    return pretax - tax;
  }

  get margin(): number {
    const ni = this.currentNetIncomeEstimate();
    return this.revenue > 0 ? ni / this.revenue : 0;
  }

  get eps(): number {
    const ni = this.currentNetIncomeEstimate();
    return this.sharesOutstanding > 0 ? ni / this.sharesOutstanding : 0;
  }

  get salesPerShare(): number {
    return this.sharesOutstanding > 0 ? this.revenue / this.sharesOutstanding : 0;
  }

  get pe(): number | null {
    return this.eps > 0 ? this.price / this.eps : null;
  }

  get ps(): number {
    const sps = this.salesPerShare || 1e-9;
    return this.price / sps;
  }

  private sumHistory<K extends keyof HistoryPoint>(key: K, weeks = 48): number {
    if (!this.history.length) return 0;
    const end = this.history.length;
    const start = Math.max(0, end - weeks);
    let total = 0;
    for (let i = start; i < end; i++) total += (this.history[i][key] as unknown as number) || 0;
    return total;
  }

  get ttmRevenue(): number {
    const sum = this.sumHistory("revenue", 48);
    return sum || this.revenue * 48;
    // conservative fallback if no history
  }

  get ttmNetIncome(): number {
    const sum = this.sumHistory("netIncome", 48);
    return sum || this.currentNetIncomeEstimate() * 48;
  }

  get ttmEPS(): number {
    return this.sharesOutstanding > 0 ? this.ttmNetIncome / this.sharesOutstanding : 0;
  }

  get ttmSalesPerShare(): number {
    return this.sharesOutstanding > 0 ? this.ttmRevenue / this.sharesOutstanding : 0;
  }

  get peTTM(): number | null {
    return this.ttmEPS > 0 ? this.price / this.ttmEPS : null;
  }

  get psTTM(): number {
    const sps = this.ttmSalesPerShare || 1e-9;
    return this.price / sps;
  }

  get ttmMargin(): number {
    const rev = this.ttmRevenue;
    return rev > 0 ? this.ttmNetIncome / rev : 0;
  }

  get debtToEquity(): number {
    const eq = Math.max(1e-6, this.equity);
    return this.debt / eq;
  }

  // ---------- Simulation ----------

  simulateWeek(week: number, market: MarketEnv, sector: SectorIndex, rng: RNG): void {
    if (this.isBankrupt) {
      this.history.push(this.snapshot(week));
      return;
    }

    const sharesBefore = this.sharesOutstanding;

    // compute last return for sentiment linkage
    const lastRetForSent = this.history.length
      ? (this.price - this.history[this.history.length - 1].price) /
        Math.max(1, this.history[this.history.length - 1].price)
      : 0;

    // 0) sentiment mean reversion with macro and sector bleed
    this.sentiment = clamp(
      this.sentiment * 0.9 +
      market.sentiment * 0.05 +
      sector.sentiment * 0.05 +
      0.2 * clamp(lastRetForSent, -0.05, 0.05) +
      rng.tnorm(0, 0.02, -0.08, 0.08),
      -1,
      1
    );

    // 1) fundamentals evolve
    const stageGrowth =
      this.stage === "startup" ? 0.0032 :
      this.stage === "growth"  ? 0.0020 :
      this.stage === "mature"  ? 0.0005 : -0.0005;

    const revMean =
      sector.baselineGrowth +
      stageGrowth +
      market.sentiment * 0.0007 +
      this.sentiment * 0.0008;

    const revShock = rng.normal(0, 0.003);
    this.revenue = Math.max(0, this.revenue * (1 + revMean + revShock));

    const inflationWeekly = market.inflation / 48;
    const expMean = revMean * 0.7 + inflationWeekly * 0.8;
    const expShock = rng.normal(0, 0.003);
    this.expenses = Math.max(0, this.expenses * (1 + expMean + expShock));

    // R&D, depreciation, interest, taxes
    const rndSpend = this.rAndDRate * this.revenue;
    const depreciation = this.depreciationRate * this.assets;

    const effectiveBorrowRate = clamp(market.interestRate + this.interestRateSpread, 0, 0.35);
    this.lastBorrowRate = effectiveBorrowRate;
    const interest = this.debt * (effectiveBorrowRate / 48);

    const operatingIncome = this.revenue - this.expenses - rndSpend - depreciation;
    const pretaxIncome = operatingIncome - interest;
    const taxes = Math.max(0, pretaxIncome) * this.taxRate;
    const netIncome = pretaxIncome - taxes;

    // cash flows
    this.quarterNetIncomeAcc += netIncome;
    const capex = this.capexRate * this.revenue;
    const cfo = netIncome + depreciation;
    const cfi = -capex;
    let cff = 0;

    // operating assets and cash
    this.assets = Math.max(0, this.assets + capex - depreciation);
    this.cash += cfo + cfi;

    // 2) active effects
    let driftAdj = 0;
    let multipleAdj = 0;
    let sentimentAdj = 0;
    if (this.activeEffects.length) {
      for (const e of this.activeEffects) {
        if (week <= e.untilWeek) {
          driftAdj += e.driftDelta;
          multipleAdj += e.multipleDelta;
          sentimentAdj += e.sentimentDelta;
        }
      }
      this.activeEffects = this.activeEffects.filter(e => week <= e.untilWeek);
    }
    if (sentimentAdj) {
      this.sentiment = clamp(this.sentiment + clamp(sentimentAdj, -0.5, 0.5), -1, 1);
    }

    // 3) valuation targets
    const basePE = market.basePE() * sector.peAdj;
    const stagePEAdj = this.stage === "startup" ? 1.2 : this.stage === "growth" ? 1.1 : this.stage === "mature" ? 1.0 : 0.85;
    const riskPEAdj = this.riskProfile === "low" ? 1.05 : this.riskProfile === "medium" ? 1.0 : 0.95;
    const sentPEAdj = 1 + clamp(this.sentiment, -1, 1) * 0.25;
    const targetPE = clamp(basePE * stagePEAdj * riskPEAdj * sentPEAdj * (1 + multipleAdj), 12, 45);

    const basePS = 2.8;
    const stagePS = this.stage === "startup" ? 6 : this.stage === "growth" ? 4 : this.stage === "mature" ? 2 : 1.4;
    const ratePSAdj = clamp(1.6 - 8 * market.interestRate, 0.8, 1.6);
    const targetPS = clamp(basePS * stagePS * ratePSAdj * (1 + multipleAdj), 1.0, 14);

    const epsTTM = this.ttmEPS;
    const spsTTM = this.ttmSalesPerShare || 1e-9;

    const fundamental = epsTTM > 0
      ? 0.7 * targetPE * epsTTM + 0.3 * targetPS * spsTTM
      : targetPS * spsTTM;

    // 4) price dynamics with stronger mean reversion and momentum
    const kappa = 0.06; // stronger mean reversion to fundamentals to curb compounding
    const reversion = clamp((fundamental - this.price) / Math.max(1, this.price), -0.25, 0.25) * kappa;

    const marketShock = rng.normal(market.sentiment * 0.002, market.vol);
    const sectorShock = rng.normal(sector.sentiment * 0.002, sector.vol);
    const idioShock = rng.normal(0, this.baseVol);

    const lastRet = this.history.length
      ? (this.price - this.history[this.history.length - 1].price) /
        Math.max(1, this.history[this.history.length - 1].price)
      : 0;
    const momentum = 0.012 * lastRet; // reduce momentum to dampen compounding

    this.baseDrift = 0.00008 + this.margin * 0.004 + driftAdj; // lower drift and margin scaling

    const leverageBump = Math.max(0, this.debtToEquity - 1) * 0.003;
    const unprofitableBump = netIncome < 0 ? 0.004 : 0;
    this.baseVol = clamp(
      (this.riskProfile === "low" ? 0.01 : this.riskProfile === "medium" ? 0.02 : 0.045)
      + leverageBump + unprofitableBump,
      0.008, 0.12
    );

    // Quality, value, and profitability-trend tilts: reward profitable growth and reasonable valuations
    const quality = clamp(this.ttmMargin, -0.2, 0.4); // margin proxy
    const growth = clamp((this.revenue - (this.history.length ? this.history[Math.max(0, this.history.length - 13)].revenue : this.revenue)) / Math.max(1e-6, (this.history.length ? this.history[Math.max(0, this.history.length - 13)].revenue : this.revenue)), -0.5, 0.5);
    const peNow = this.peTTM;
    const discountSignal = peNow != null ? clamp((targetPE - peNow) / targetPE, -0.6, 0.6) : 0;
    // Profitability trend over prior year
    let marginTrend = 0;
    if (this.history.length >= 96) {
      let prevRev = 0, prevNi = 0;
      for (let i = this.history.length - 96; i < this.history.length - 48; i++) {
        const h = this.history[i];
        prevRev += h.revenue;
        prevNi += h.netIncome;
      }
      const prevMargin = prevRev > 0 ? prevNi / prevRev : 0;
      marginTrend = clamp(this.ttmMargin - prevMargin, -0.2, 0.2);
    }
    const qualityAlpha = 0.0012 * quality + 0.0012 * growth;
    const valueAlpha = 0.0012 * discountSignal;
    const trendAlpha = 0.0008 * marginTrend;

    const retRaw =
      this.baseDrift + market.expectedEquityReturnWeekly() +
      this.betaMarket * marketShock +
      this.betaSector * sectorShock +
      idioShock +
      reversion +
      momentum +
      qualityAlpha +
      valueAlpha +
      trendAlpha;

    // clamp extreme weekly returns to avoid unrealistic spikes
    const ret = clamp(retRaw, -0.10, 0.10); // slightly narrower weekly bounds

    this.price = Math.max(0.5, this.price * (1 + ret));

    // Normalize price into a retail-looking band by adjusting shares (implicit splits)
    if (this.price < 3) {
      const r = Math.ceil(3 / Math.max(1e-6, this.price));
      this.price = this.price * r;
      this.sharesOutstanding = Math.max(1_000_000, Math.round(this.sharesOutstanding / r));
    } else if (this.price > 300) {
      const r = Math.ceil(this.price / 300);
      this.price = Math.max(1, Math.round(this.price / r));
      this.sharesOutstanding = this.sharesOutstanding * r;
    }

    // low price tracking for reverse split logic
    if (this.price < 1) this.lowPriceStreak += 1;
    else this.lowPriceStreak = 0;

    // 5) quarter bells
    if (week % 12 === 0) {
      // earnings surprise
      const surprise = rng.normal(0, 0.03 + (this.stage === "startup" ? 0.02 : 0));
      this.applyEvent({
        type: "earnings",
        description: "Quarterly earnings release",
        priceShock: surprise
      }, week);

      // dividends
      if (this.payoutRatio > 0 && this.quarterNetIncomeAcc > 0) {
        let totalDividend = this.payoutRatio * this.quarterNetIncomeAcc;
        if (this.targetYield && this.price > 0) {
          const cap = this.targetYield * (this.price * this.sharesOutstanding) / 4;
          totalDividend = Math.min(totalDividend, cap);
        }
        const dps = totalDividend / this.sharesOutstanding;
        if (dps > 0) {
          this.cash -= totalDividend;
          cff -= totalDividend;
          this.price = Math.max(0.5, this.price - dps); // ex-div drop
          this.applyEvent({ type: "dividend", description: `Dividend ${dps.toFixed(2)}/sh` }, week);
        }
      }

      // buybacks when cheap vs fundamental and cashy
      const cheapVsFundamental = fundamental > 0 && this.price < 0.9 * fundamental;
      const cashBuffer = Math.max(0, 0.1 * this.revenue * 48 / 12); // about 5 weeks of revenue
      if (cheapVsFundamental && this.cash > cashBuffer * 1.5 && this.buybackRate > 0) {
        const amount = this.buybackRate * (this.cash - cashBuffer);
        const maxSharesThisQuarter = this.sharesOutstanding * 0.05; // cap 5% per quarter
        const sharesRepurchased = Math.min(amount / Math.max(1, this.price), maxSharesThisQuarter);
        this.sharesOutstanding = Math.max(1_000_000, this.sharesOutstanding - sharesRepurchased);
        this.cash -= amount;
        cff -= amount;
        this.price *= 1.01;
        this.applyEvent({ type: "buyback", description: `Buyback $${amount.toFixed(0)}` }, week);
      }

      // forward split if too pricey
      if (this.price > 200) {
        const ratio = 4;
        this.sharesOutstanding *= ratio;
        this.price /= ratio;
        this.applyEvent({ type: "split", description: `${ratio}-for-1 split` }, week);
      }

      // reverse split if stuck under $1 for ~2 months
      if (this.lowPriceStreak >= 16) {
        const ratio = 10;
        this.sharesOutstanding = Math.max(1_000_000, this.sharesOutstanding / ratio);
        this.price *= ratio;
        this.lowPriceStreak = 0;
        this.applyEvent({ type: "split", description: `1-for-${ratio} reverse split` }, week);
      }

      // track distress state
      if (this.quarterNetIncomeAcc < 0) this.negativeQuarterStreak += 1;
      else this.negativeQuarterStreak = Math.max(0, this.negativeQuarterStreak - 1);
      this.quarterNetIncomeAcc = 0;

      // extra quarterly events
      this.maybeQuarterlyEvents(week, rng);
    }

    // weekly news
    if (rng.chance(0.05)) this.maybeWeeklyNews(week, rng);

    // distress or bankruptcy
    const minCash = 0.02 * this.revenue * 48 / 12; // about 2 weeks of revenue
    if (this.cash < 0) {
      const raise = Math.min(Math.abs(this.cash) + minCash, 0.2 * Math.max(1, this.totalAssets));
      this.debt += raise;
      this.cash += raise;
      cff += raise;
      this.applyEvent({ type: "distress", description: "Emergency debt raise", priceShock: -0.03 }, week);
    }

    // Make bankruptcy rarer and more clearly signaled
    const severeLeverage = this.debtToEquity > 5.0;
    if (severeLeverage && this.negativeQuarterStreak >= 8 && this.cash < -minCash) {
      this.applyEvent({ type: "bankruptcy", description: "Bankruptcy: equity wiped, trading suspended then resumes OTC", priceShock: -0.9 }, week);
      this.isBankrupt = true;
      this.price = Math.max(0.05, this.price * 0.2);
    }

    // Enforce a global post-update floor to avoid penny-stock glitches breaking UI scales
    this.price = Math.max(0.5, this.price);

    // Mark split-like share changes for external adjustment (ignore small drifts like buybacks)
    const splitFactor = sharesBefore > 0 ? this.sharesOutstanding / sharesBefore : 1;
    if (splitFactor > 1.5 || splitFactor < 0.67) this.pendingSplitFactor = splitFactor; else this.pendingSplitFactor = 1;

    // write history
    this.history.push(this.snapshot(week));
  }

  // ---------- Events ----------

  private maybeQuarterlyEvents(week: number, rng: RNG): void {
    const r = rng.random();
    if (r < 0.15) {
      const beat = rng.chance(0.55);
      this.applyEvent({
        type: "guidance",
        description: beat ? "Raised guidance" : "Lowered guidance",
        priceShock: beat ? rng.normal(0.03, 0.02) : rng.normal(-0.04, 0.03),
        driftDelta: beat ? 0.0005 : -0.0005,
        multipleDelta: beat ? 0.05 : -0.05,
        sentimentDelta: beat ? 0.2 : -0.2,
        durationWeeks: 12
      }, week);
    } else if (r < 0.25) {
      const hit = rng.chance(0.6);
      this.applyEvent({
        type: "product",
        description: hit ? "Successful product launch" : "Product flop",
        revenueDeltaPct: hit ? 0.04 : -0.03,
        expenseDeltaPct: 0.01,
        priceShock: hit ? rng.normal(0.06, 0.04) : rng.normal(-0.07, 0.05),
        driftDelta: hit ? 0.0008 : -0.0008,
        durationWeeks: 24
      }, week);
    } else if (r < 0.32) {
      this.applyEvent({
        type: rng.chance(0.4) ? "scandal" : "lawsuit",
        description: "Legal or governance issue",
        expenseDeltaPct: 0.03,
        priceShock: rng.normal(-0.08, 0.05),
        multipleDelta: -0.08,
        sentimentDelta: -0.4,
        durationWeeks: 24
      }, week);
    } else if (r < 0.36) {
      const acquirer = rng.chance(0.5);
      this.applyEvent({
        type: "merger",
        description: acquirer ? "Announces acquisition" : "Receives takeover interest",
        priceShock: acquirer ? rng.normal(-0.03, 0.02) : rng.normal(0.12, 0.06),
        multipleDelta: acquirer ? -0.02 : 0.05,
        durationWeeks: 12
      }, week);
    } else if (r < 0.40) {
      const up = rng.chance(0.5);
      this.applyEvent({
        type: up ? "upgrade" : "downgrade",
        description: up ? "Analyst upgrade" : "Analyst downgrade",
        priceShock: up ? 0.02 : -0.03,
        multipleDelta: up ? 0.03 : -0.04,
        durationWeeks: 12
      }, week);
    }
  }

  private maybeWeeklyNews(week: number, rng: RNG): void {
    const r = rng.random();
    if (r < 0.2) {
      this.applyEvent({
        type: "supply_chain",
        description: "Minor supply chain hiccups",
        expenseDeltaPct: 0.01,
        priceShock: -0.01,
        durationWeeks: 4
      }, week);
    } else if (r < 0.35) {
      this.applyEvent({
        type: "regulatory",
        description: "Regulatory headline",
        priceShock: rng.normal(0, 0.02),
        durationWeeks: 4
      }, week);
    }
  }

  applyEvent(ev: Event, currentWeek: number): void {
    if (ev.revenueDeltaPct) this.revenue = Math.max(0, this.revenue * (1 + ev.revenueDeltaPct));
    if (ev.expenseDeltaPct) this.expenses = Math.max(0, this.expenses * (1 + ev.expenseDeltaPct));
    if (ev.cashDelta) this.cash += ev.cashDelta;
    if (ev.debtDelta) this.debt = Math.max(0, this.debt + ev.debtDelta);
    if (ev.sharesDelta) this.sharesOutstanding = Math.max(1, this.sharesOutstanding + ev.sharesDelta);
    if (typeof ev.priceShock === "number") {
      this.price = Math.max(0.05, this.price * (1 + ev.priceShock));
    }
    if (ev.driftDelta || ev.multipleDelta || ev.sentimentDelta) {
      this.activeEffects.push({
        untilWeek: ev.durationWeeks ? currentWeek + ev.durationWeeks : currentWeek + 12,
        driftDelta: ev.driftDelta ?? 0,
        multipleDelta: ev.multipleDelta ?? 0,
        sentimentDelta: ev.sentimentDelta ?? 0
      });
    }
  }

  private snapshot(week: number): HistoryPoint {
    const ni = this.currentNetIncomeEstimate();
    return {
      week,
      price: this.price,
      revenue: this.revenue,
      expenses: this.expenses,
      eps: this.sharesOutstanding > 0 ? ni / this.sharesOutstanding : 0,
      netIncome: ni,
      cash: this.cash,
      debt: this.debt,
      assets: this.totalAssets,          // show total assets on UI
      equity: this.equity,
      shares: this.sharesOutstanding,
      pe: this.pe,
      ps: this.ps,
      sentiment: this.sentiment
    };
  }
}

// --------------------------- Exports ---------------------------

export default {
  RNG,
  MarketEnv,
  SectorIndex,
  Company
};
