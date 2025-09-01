// Data Access Layer: OpenRouter Chat Completions REST client (browser-safe via Vite env)

export type OpenRouterModel = string; // e.g. "google/gemini-2.0-flash-001" or any supported model

export type GenerateTextOptions = {
  model?: OpenRouterModel
  systemInstruction?: string
  maxTokens?: number
  temperature?: number
};

export type ChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
};

// ---------------- Gemini Decisions ----------------
export type GeminiStockView = {
  ticker: string
  sector: string
  stage: string
  riskProfile: string
  price: number
  peTTM: number | null
  psTTM: number
  ttmRevenue: number
  ttmMargin: number
  debtToEquity: number
  sentiment: number
};

export type GeminiHoldingView = {
  ticker: string
  quantity: number
  avgCostBasis: number
};

export type GeminiDecision = {
  action: "BUY" | "SELL"
  ticker: string
  dollars: number
};

export type GeminiDecisionResponse = {
  decisions: GeminiDecision[]
  rationale?: string
};

type ChatCompletionsResponse = {
  id?: string
  choices?: Array<{
    index?: number
    message?: ChatMessage
    finish_reason?: string
  }>
};

const API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL: OpenRouterModel = "google/gemini-2.0-flash-001";

function getApiKey(): string {
  const key = import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined;
  if (!key) {
    throw new Error(
      "Missing VITE_OPENROUTER_API_KEY. Add it to your .env file (see .env.example)."
    );
  }
  return key;
}

export async function generateOpenRouterText(
  prompt: string,
  options: GenerateTextOptions = {}
): Promise<string> {
  const apiKey = getApiKey();
  const model = options.model ?? DEFAULT_MODEL;

  const messages: ChatMessage[] = [];
  if (options.systemInstruction) {
    messages.push({ role: "system", content: options.systemInstruction });
  }
  messages.push({ role: "user", content: prompt });

  const body = {
    model,
    messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature
  };

  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": window.location.origin,
      "X-Title": document.title || "llm-stock-game"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter API request failed: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ""
      }`
    );
  }

  const data = (await response.json()) as ChatCompletionsResponse;
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error("OpenRouter API returned no choices or text content.");
  }

  return text;
}

// Sends the full chat history and returns the assistant's reply text
export async function sendOpenRouterChat(
  messages: ChatMessage[],
  options: GenerateTextOptions = {}
): Promise<string> {
  const apiKey = getApiKey();
  const model = options.model ?? DEFAULT_MODEL;

  const body = {
    model,
    messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature
  };

  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": window.location.origin,
      "X-Title": document.title || "llm-stock-game"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter API request failed: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ""
      }`
    );
  }

  const data = (await response.json()) as ChatCompletionsResponse;
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenRouter API returned no choices or text content.");
  }
  return text;
}

/**
 * Request Gemini to output yearly portfolio decisions as strict JSON.
 * Returns an object with a list of BUY/SELL decisions and optional rationale.
 */
export async function requestGeminiDecisions(
  stocks: GeminiStockView[],
  cashAvailable: number,
  holdings: GeminiHoldingView[],
  options: GenerateTextOptions = {}
): Promise<GeminiDecisionResponse> {
  const system =
    "You are an investing agent in a stock simulation. Respond ONLY with JSON. No commentary outside JSON.";

  const instruction =
    `You are given current stock fundamentals and your current portfolio.\n` +
    `Budget available (cash): ${Math.max(0, Math.floor(cashAvailable))}.\n` +
    `You may output up to 12 decisions. Each decision must be one of {\"BUY\", \"SELL\"}.\n` +
    `Allocate whole-dollar amounts (no cents). Keep total BUY dollars <= cash.\n` +
    `For SELL, ensure you do not sell more shares than you own.\n` +
    `Only use tickers present in DATA.stocks.\n` +
    `Game goals: maximize long-run CAGR over yearly rebalances (48 weeks/year).\n` +
    `Trading constraints and heuristics:\n` +
    `- Allow concentration for outperformance; prefer cross-sector exposure when reasonable (no hard cap per ticker).\n` +
    `- Prefer profitable growth (higher ttmMargin, positive sentiment).\n` +
    `- Favor reasonable valuations (lower peTTM when available; otherwise lower psTTM), adjusted by stage/riskProfile.\n` +
    `- Penalize high leverage (high debtToEquity).\n` +
    `- Rebalance: trim extreme winners if valuation stretched; cut chronic losers with worsening sentiment and margins.\n` +
    `- Target 1–9 holdings; bias toward concentration for potential outperformance; avoid tiny orders (< $200) unless using remaining cash.\n` +
    `- Favor adding to winners that remain reasonably valued; avoid averaging down on deteriorating fundamentals.\n` +
    `- Prioritize clear catalysts (margin expansion, revenue acceleration) over vague narratives.\n` +
    `- Maintain a very small cash buffer (0–5%). Aim to deploy 95–100% of available cash each rebalance when acceptable ideas exist.\n` +
    `- If no attractive ideas truly exist, it is acceptable to hold cash; otherwise avoid carrying excess cash.\n` +
    `- Round dollars to produce at least 1 share at current prices when BUYing.\n` +
    `Output strict JSON of the form: {\n` +
    `  \"decisions\": [{\"action\": \"BUY\"|\"SELL\", \"ticker\": string, \"dollars\": number}],\n` +
    `  \"rationale\": string\n` +
    `}`;

  const payload = {
    stocks,
    holdings,
  };

  const prompt =
    `DATA:\n` +
    `${JSON.stringify(payload, null, 2)}\n\n` +
    `TASK:\n` +
    instruction;

  try {
    console.log("[Gemini] Request prepared", {
      stocksCount: stocks.length,
      holdingsCount: holdings.length,
      cashAvailable: Math.floor(cashAvailable),
      tickersPreview: stocks.slice(0, 6).map(s => s.ticker)
    });
  } catch {}

  const raw = await generateOpenRouterText(prompt, {
    ...options,
    systemInstruction: system,
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? 800,
  });

  try {
    console.log("[Gemini] Raw response", raw);
  } catch {}

  // Try to extract JSON from fenced blocks first
  let jsonText = "";
  const fenceMatch = raw.match(/```json[\s\S]*?```/i);
  if (fenceMatch) {
    jsonText = fenceMatch[0].replace(/```json/i, "").replace(/```$/, "").trim();
  } else {
    // Fallback: attempt to parse the first top-level JSON object in the text
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) jsonText = raw.slice(start, end + 1);
  }

  let parsed: GeminiDecisionResponse | null = null;
  try {
    parsed = JSON.parse(jsonText || raw) as GeminiDecisionResponse;
  } catch {
    // last resort: empty decisions
    parsed = { decisions: [], rationale: undefined };
  }

  // Sanitize
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const clean: GeminiDecision[] = decisions
    .filter(d => d && typeof d.ticker === "string" && typeof d.dollars === "number")
    .map((d): GeminiDecision => {
      const act: "BUY" | "SELL" = d.action === "SELL" ? "SELL" : "BUY";
      return {
        action: act,
        ticker: d.ticker.trim().toUpperCase(),
        dollars: Math.max(0, Math.floor(d.dollars)),
      };
    })
    .slice(0, 12);
  try {
    console.log("[Gemini] Parsed decisions", { count: clean.length, decisions: clean, rationale: parsed.rationale });
  } catch {}
  return { decisions: clean, rationale: parsed.rationale };
}


