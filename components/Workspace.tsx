"use client";

import { useChat } from "@ai-sdk/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Send,
  Sparkles,
  User,
  Bot,
  Code2,
  Eye,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import LivePreview from "@/components/LivePreview";
import { extractJsx } from "@/lib/extractJsx";
import { repairCode } from "@/lib/repairCode";
import { PREVIEW_CHANNEL } from "@/lib/previewChannel";

type ModelChoice = "claude-haiku-4-5" | "lmstudio-gemma";

const MODEL_OPTIONS: { value: ModelChoice; label: string; hint: string }[] = [
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "cloud · cheap · strong at code" },
  { value: "lmstudio-gemma", label: "Gemma (LM Studio)", hint: "local · free" },
];

const DEFAULT_APP = `export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100 p-8">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Artifacts</h1>
        <p className="text-neutral-400">
          Ask the model on the left for a UI component. The code block it streams
          will render live in this pane.
        </p>
      </div>
    </div>
  );
}
`;

const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 720;
const DEFAULT_CHAT_WIDTH = 420;

export default function Workspace() {
  const [model, setModel] = useState<ModelChoice>("claude-haiku-4-5");
  const modelRef = useRef(model);
  modelRef.current = model;

  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({ api: "/api/chat" });

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      handleSubmit(e, { body: { model: modelRef.current } });
    },
    [handleSubmit]
  );

  const [showChat, setShowChat] = useState(true);
  const [showCode, setShowCode] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const latestRawCode = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const code = extractJsx(m.content);
      if (code) return code;
    }
    return null;
  }, [messages]);

  // Pipe each streamed chunk through repairCode so Sandpack always receives
  // parseable source. If a chunk lands in a state the repairer can't salvage,
  // hold the previous repaired version (sticky last-good frame).
  const lastGoodRef = useRef<string | null>(null);
  const appCode = useMemo(() => {
    if (!latestRawCode) return DEFAULT_APP;
    const repaired = repairCode(latestRawCode);
    if (repaired) {
      lastGoodRef.current = repaired;
      return repaired;
    }
    return lastGoodRef.current ?? DEFAULT_APP;
  }, [latestRawCode]);

  const appCodeRef = useRef(appCode);
  appCodeRef.current = appCode;

  // BroadcastChannel: stream code updates to any popped-out preview window.
  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(PREVIEW_CHANNEL);
    channelRef.current = ch;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "ready") {
        ch.postMessage({ type: "code", code: appCodeRef.current });
      }
    };
    ch.addEventListener("message", onMsg);
    return () => {
      ch.removeEventListener("message", onMsg);
      ch.close();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    channelRef.current?.postMessage({ type: "code", code: appCode });
  }, [appCode]);

  const openInNewTab = useCallback(() => {
    window.open(
      "/preview",
      "artifacts-preview",
      "width=1200,height=900,noopener=no"
    );
  }, []);

  // Drag handle between chat and workspace.
  const onChatResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = chatWidth;
      const onMove = (ev: MouseEvent) => {
        const next = startWidth + (ev.clientX - startX);
        setChatWidth(Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, next)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatWidth]
  );

  // Keyboard shortcuts: ⌘/Ctrl + 1/2/3 toggle panels, ⌘/Ctrl+E pops out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "1") {
        e.preventDefault();
        setShowChat((v) => !v);
      } else if (e.key === "2") {
        e.preventDefault();
        setShowCode((v) => !v);
      } else if (e.key === "3") {
        e.preventDefault();
        setShowPreview((v) => !v);
      } else if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        openInNewTab();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openInNewTab]);

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100">
      {showChat && (
        <>
          <section
            className="flex flex-col border-r border-neutral-800"
            style={{ width: chatWidth, flexShrink: 0 }}
          >
            <header className="flex items-center gap-2 border-b border-neutral-800 px-5 py-3">
              <Sparkles className="h-4 w-4 text-indigo-400" />
              <h1 className="text-sm font-medium tracking-wide">Artifacts</h1>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as ModelChoice)}
                disabled={isLoading}
                title={
                  MODEL_OPTIONS.find((m) => m.value === model)?.hint ?? ""
                }
                className="ml-2 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none transition hover:border-neutral-700 focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {isLoading && (
                <span className="ml-auto flex items-center gap-1 text-xs text-neutral-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
                  streaming
                </span>
              )}
            </header>

            <div
              ref={scrollRef}
              className="flex-1 space-y-4 overflow-y-auto px-5 py-6"
            >
              {messages.length === 0 && (
                <div className="mx-auto max-w-sm rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-sm text-neutral-400">
                  Try:{" "}
                  <span className="text-neutral-200">
                    &ldquo;Build a pricing card with three tiers&rdquo;
                  </span>
                </div>
              )}
              {messages.map((m) => (
                <MessageBubble key={m.id} role={m.role} content={m.content} />
              ))}
            </div>

            <form
              onSubmit={onSubmit}
              className="sticky bottom-0 border-t border-neutral-800 bg-neutral-950/90 p-4 backdrop-blur"
            >
              <div className="flex items-end gap-2 rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2 focus-within:border-indigo-500">
                <textarea
                  value={input}
                  onChange={handleInputChange}
                  disabled={isLoading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      (e.currentTarget.form as HTMLFormElement)?.requestSubmit();
                    }
                  }}
                  rows={1}
                  placeholder={
                    isLoading ? "streaming response…" : "Describe a component…"
                  }
                  className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-neutral-500 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={isLoading || input.trim().length === 0}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500 text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-neutral-700"
                  aria-label="Send"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </form>
          </section>
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={onChatResizeStart}
            className="group relative w-[6px] flex-shrink-0 cursor-col-resize bg-neutral-900 transition hover:bg-indigo-500/40"
            title="Drag to resize"
          >
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-neutral-800 group-hover:bg-indigo-400" />
          </div>
        </>
      )}

      <section className="flex flex-1 flex-col min-w-0">
        <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-3">
          <ToolbarButton
            onClick={() => setShowChat((v) => !v)}
            label={showChat ? "Hide chat (⌘1)" : "Show chat (⌘1)"}
            active={showChat}
          >
            {showChat ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4" />
            )}
          </ToolbarButton>

          <div className="ml-1 flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-green-500/80" />
          </div>
          <h2 className="ml-2 text-sm font-medium text-neutral-300">
            Live Preview
          </h2>
          {latestRawCode && (
            <span className="ml-2 text-xs text-neutral-500">
              {latestRawCode.length.toLocaleString()} chars
              {isLoading && (
                <span className="ml-2 text-indigo-400">· streaming</span>
              )}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <ToolbarButton
              onClick={() => setShowCode((v) => !v)}
              label={showCode ? "Hide code (⌘2)" : "Show code (⌘2)"}
              active={showCode}
            >
              <Code2 className="h-4 w-4" />
              <span className="ml-1.5 hidden text-xs sm:inline">Code</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => setShowPreview((v) => !v)}
              label={showPreview ? "Hide preview (⌘3)" : "Show preview (⌘3)"}
              active={showPreview}
            >
              <Eye className="h-4 w-4" />
              <span className="ml-1.5 hidden text-xs sm:inline">Preview</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={openInNewTab}
              label="Open preview in new tab (⌘E)"
            >
              <ExternalLink className="h-4 w-4" />
              <span className="ml-1.5 hidden text-xs sm:inline">Pop out</span>
            </ToolbarButton>
          </div>
        </header>
        <div className="flex-1 overflow-hidden">
          <LivePreview
            code={appCode}
            rawCode={latestRawCode ?? ""}
            isStreaming={isLoading}
            showCode={showCode}
            showPreview={showPreview}
          />
        </div>
      </section>
    </main>
  );
}

function ToolbarButton({
  children,
  onClick,
  label,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-8 items-center rounded-md px-2 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100 ${
        active === true
          ? "bg-neutral-800 text-neutral-100"
          : active === false
          ? "text-neutral-500"
          : ""
      }`}
    >
      {children}
    </button>
  );
}

function MessageBubble({
  role,
  content,
}: {
  role: string;
  content: string;
}) {
  const isUser = role === "user";
  const display = isUser ? content : stripCode(content);

  return (
    <div
      className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
    >
      <div
        className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-indigo-500" : "bg-neutral-800"
        }`}
      >
        {isUser ? (
          <User className="h-3.5 w-3.5" />
        ) : (
          <Bot className="h-3.5 w-3.5 text-indigo-300" />
        )}
      </div>
      <div
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-indigo-500 text-white"
            : "bg-neutral-900 text-neutral-100 ring-1 ring-neutral-800"
        }`}
      >
        {display || (
          <span className="text-neutral-500 italic">
            rendering component in preview →
          </span>
        )}
      </div>
    </div>
  );
}

function stripCode(text: string): string {
  return text
    .replace(/```[a-zA-Z]*\s*\n[\s\S]*?(?:```|$)/g, "")
    .trim();
}
