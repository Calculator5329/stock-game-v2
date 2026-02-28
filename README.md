# LLM Stock Game

A stock trading simulation where you compete against AI-powered trading agents in a real-time market.

## What It Is

A React/TypeScript web-based stock trading game that simulates a dynamic market with 10 companies across multiple sectors. Manage a portfolio, buy and sell stocks, and compete against AI agents (powered by LLMs including Gemini, Claude, and GPT-5) to achieve the highest returns. Watch real-time price movements and track your performance against benchmark indices and AI competitors using CAGR metrics.

## Tech Stack

- **React 19** - UI framework
- **TypeScript** - Type safety
- **MobX** - State management
- **Vite** - Build tool and dev server
- **Google Generative AI** - LLM integration for AI trading agents

## Features

- **Dynamic Market Simulation** - 10 companies with realistic price fluctuations across different sectors
- **Portfolio Management** - Buy, sell, and track stock holdings with cost basis calculations
- **Speed Controls** - Adjust game simulation speed (0.5x to 8x)
- **AI Competitors** - Automated trading agents powered by LLMs making investment decisions
- **Performance Metrics** - CAGR (Compound Annual Growth Rate) tracking for your portfolio and competitors
- **Real-Time Charts** - Visual representation of portfolio and benchmark performance
- **Holdings Summary** - Detailed table of current positions with P&L tracking
- **Cash Management** - Track available cash and total portfolio value

## Getting Started

```bash
npm install
npm run dev
```

The dev server will start at `http://localhost:5173`.

To build for production:

```bash
npm run build
```

### Environment Variables

Create a `.env` file with your LLM API keys:

```
VITE_OPENROUTER_API_KEY=your_api_key_here
```

---

Created by [Calculator5329](https://github.com/Calculator5329)
