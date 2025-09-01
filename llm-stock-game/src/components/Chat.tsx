import { useState, useRef, useEffect } from "react";
import { observer } from "mobx-react-lite";
import { chatStore, MODEL_PRESETS } from "../stores/ChatStore";

function ChatComponent() {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatStore.messages.length, chatStore.isSending]);

  const send = async () => {
    const value = input;
    setInput("");
    await chatStore.sendUserMessage(value);
  };

  return (
    <div style={{margin: "0 auto", padding: 16 }}>
      <h2>LLM Chat</h2>

      <div style={{ marginBottom: 8 }}>
        <label htmlFor="model-select" style={{ marginRight: 8 }}>Model:</label>
        <select
          id="model-select"
          value={chatStore.selectedModel}
          onChange={(e) => chatStore.setModel(e.target.value)}
        >
          <option value={MODEL_PRESETS.CLAUDE}>Claude</option>
          <option value={MODEL_PRESETS.GEMINI}>Gemini</option>
          <option value={MODEL_PRESETS.CHATGPT}>gpt-4o</option>
        </select>
        <button style={{ marginLeft: 8 }} onClick={() => chatStore.clear()} disabled={chatStore.isSending}>
          Clear
        </button>
      </div>

      <div
        style={{
          border: "1px solid #ccc",
          borderRadius: 8,
          padding: 12,
          minHeight: 240,
          background: "#fafafa"
        }}
      >
        {chatStore.messages.map((m, idx) => (
          <div key={idx} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#666" }}>{m.role.toUpperCase()}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
          </div>
        ))}
        {chatStore.isSending && (
          <div style={{ fontStyle: "italic", color: "#666" }}>Assistant is typing…</div>
        )}
        <div ref={endRef} />
      </div>

      {chatStore.errorMessage && (
        <div style={{ color: "#b00020", marginTop: 8 }}>{chatStore.errorMessage}</div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type a message..."
          style={{ flex: 1, padding: 8 }}
          disabled={chatStore.isSending}
        />
        <button onClick={send} disabled={chatStore.isSending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

export const Chat = observer(ChatComponent);


