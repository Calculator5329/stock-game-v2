import { makeAutoObservable, runInAction } from "mobx";
import type { ChatMessage, OpenRouterModel } from "../data/openRouterApi";
import { sendOpenRouterChat } from "../data/openRouterApi";

export type ProviderKey = "openrouter"; // data access is via OpenRouter

export const MODEL_PRESETS: Record<string, OpenRouterModel> = {
  CLAUDE: "anthropic/claude-3.7-sonnet",
  GEMINI: "google/gemini-2.0-flash-001",
  CHATGPT: "gpt-4o"
};

export class ChatStore {
  messages: ChatMessage[] = [];
  selectedModel: OpenRouterModel = MODEL_PRESETS.GEMINI;
  isSending = false;
  errorMessage: string | null = null;
  systemInstruction: string | undefined =
    "You are a helpful assistant. Keep responses concise.";

  constructor() {
    makeAutoObservable(this);
  }

  setModel(model: OpenRouterModel) {
    this.selectedModel = model;
  }

  clear() {
    this.messages = [];
    this.errorMessage = null;
  }

  addUserMessage(content: string) {
    this.messages.push({ role: "user", content });
  }

  addAssistantMessage(content: string) {
    this.messages.push({ role: "assistant", content });
  }

  async sendUserMessage(content: string) {
    if (this.isSending) return;
    const trimmed = content.trim();
    if (!trimmed) return;

    this.errorMessage = null;
    this.addUserMessage(trimmed);
    this.isSending = true;

    try {
      const reply = await sendOpenRouterChat(
        this.buildMessagesForApi(),
        { model: this.selectedModel }
      );
      runInAction(() => {
        this.addAssistantMessage(reply);
      });
    } catch (err) {
      runInAction(() => {
        this.errorMessage = err instanceof Error ? err.message : String(err);
      });
    } finally {
      runInAction(() => {
        this.isSending = false;
      });
    }
  }

  private buildMessagesForApi(): ChatMessage[] {
    const base: ChatMessage[] = [];
    if (this.systemInstruction) {
      base.push({ role: "system", content: this.systemInstruction });
    }
    return [...base, ...this.messages];
  }
}

export const chatStore = new ChatStore();


