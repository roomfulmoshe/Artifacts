"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

// Self-contained runner served as the iframe's srcDoc. No external bundler:
// just Tailwind play CDN, Babel standalone, and React/lucide-react resolved
// at runtime through an import map pointing at esm.sh. Dynamic-imports a
// blob:// URL of the transpiled module so module syntax (import / export
// default) just works without us reimplementing a module graph.
const RUNNER_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Live Preview</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js" crossorigin="anonymous"></script>
    <script type="importmap">
    {
      "imports": {
        "react": "https://esm.sh/react@18.3.1",
        "react/": "https://esm.sh/react@18.3.1/",
        "react-dom": "https://esm.sh/react-dom@18.3.1?deps=react@18.3.1",
        "react-dom/": "https://esm.sh/react-dom@18.3.1/",
        "react-dom/client": "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1",
        "lucide-react": "https://esm.sh/lucide-react@0.460.0?deps=react@18.3.1,react-dom@18.3.1&bundle"
      }
    }
    </script>
    <style>
      html, body, #root {
        height: 100%;
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      body { background: white; }
      #boot {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        color: #525252; font-size: 12px; background: #0a0a0a;
        transition: opacity 200ms ease;
      }
      #boot.hidden { opacity: 0; pointer-events: none; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <div id="boot">booting runtime…</div>
    <script type="module">
      import * as ReactNS from "react";
      import { createRoot } from "react-dom/client";

      const React = ReactNS.default ?? ReactNS;
      window.React = React;

      // Boundary that catches render errors from the streamed App without
      // settling. Each new compile passes a new key and remounts fresh — so
      // a chunk that errors never blocks a later chunk from being rendered.
      class StreamBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }
        static getDerivedStateFromError(error) {
          return { error };
        }
        render() {
          if (this.state.error) {
            // Tiny non-blocking toast in the corner; the next compile will
            // remount this boundary fresh because its key changes.
            return React.createElement(
              "div",
              { className: "fixed bottom-2 right-2 z-50 max-w-[320px] rounded-md bg-rose-500/10 px-3 py-2 text-[11px] leading-snug text-rose-700 ring-1 ring-rose-500/30 backdrop-blur" },
              "rendering… ",
              React.createElement(
                "span",
                { className: "opacity-70" },
                String(this.state.error.message || this.state.error).slice(0, 200)
              )
            );
          }
          return this.props.children;
        }
      }

      const rootEl = document.getElementById("root");
      const bootEl = document.getElementById("boot");
      const root = createRoot(rootEl);

      let renderToken = 0;
      let lastBlobUrl = null;
      // Cache of the most recently SUCCESSFULLY-mounted App component.
      // When a later chunk fails to compile we render this in its place so
      // the user keeps seeing the last good frame instead of a blank pane.
      let lastGoodApp = null;

      function showBootError(msg) {
        bootEl.classList.remove("hidden");
        bootEl.style.color = "#fda4af";
        bootEl.textContent = msg;
      }

      async function compileAndRender(code) {
        const myToken = ++renderToken;
        try {
          if (!window.Babel) {
            // Babel script may still be loading on the very first message.
            await new Promise((resolve) => {
              const t = setInterval(() => {
                if (window.Babel) { clearInterval(t); resolve(); }
              }, 30);
            });
          }
          if (myToken !== renderToken) return;

          const transformed = window.Babel.transform(code, {
            filename: "App.tsx",
            presets: [
              ["react", { runtime: "classic" }],
              ["typescript", { allExtensions: true, isTSX: true }],
            ],
            sourceMaps: false,
          }).code;

          const blob = new Blob([transformed], { type: "text/javascript" });
          const url = URL.createObjectURL(blob);
          let mod;
          try {
            mod = await import(url);
          } finally {
            // Revoke the previous blob; keep this one alive briefly in case
            // React schedules work referencing it.
            if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
            lastBlobUrl = url;
          }

          if (myToken !== renderToken) return;

          const App =
            (mod && (mod.default ?? mod.App)) ||
            (typeof mod === "function" ? mod : null);
          if (typeof App !== "function") {
            throw new Error("Streamed module has no default export");
          }

          // Remember this App as the last-known-good. Even if React's
          // render below later throws (caught by StreamBoundary), the next
          // failed chunk can fall back to this component.
          lastGoodApp = App;
          bootEl.classList.add("hidden");
          // key={myToken} forces a fresh boundary mount per compile so the
          // boundary never stays stuck in error state — every new chunk
          // gets a clean slate.
          root.render(
            React.createElement(
              StreamBoundary,
              { key: myToken },
              React.createElement(App)
            )
          );
        } catch (err) {
          if (myToken !== renderToken) return;
          // Compile-time failure (Babel parse, blob import, missing default).
          // Don't blank — keep the last good App mounted. The next chunk
          // (which usually arrives within tens of milliseconds) will retry.
          if (lastGoodApp) {
            root.render(
              React.createElement(
                StreamBoundary,
                { key: myToken },
                React.createElement(lastGoodApp)
              )
            );
          } else if (rootEl.childElementCount === 0) {
            // No good frame yet at all — show a small status.
            bootEl.classList.remove("hidden");
            bootEl.style.color = "#a3a3a3";
            bootEl.textContent =
              "rendering… (" + String(err.message || err).slice(0, 160) + ")";
          }
        }
      }

      window.addEventListener("message", (e) => {
        const data = e.data;
        if (!data || typeof data !== "object") return;
        if (data.type === "code" && typeof data.code === "string") {
          compileAndRender(data.code);
        } else if (data.type === "ping") {
          // Re-broadcast readiness so the parent can recover from
          // mount-order races.
          window.parent.postMessage({ type: "runner-ready" }, "*");
        }
      });

      window.addEventListener("error", (e) => {
        // Module-level errors that escape the boundary (e.g. import resolution).
        if (rootEl.childElementCount === 0) {
          showBootError("module error: " + String(e.message || e.error || e));
        }
      });

      window.parent.postMessage({ type: "runner-ready" }, "*");
    </script>
    <script>
      // Surface fatal Babel/import-map errors before the module script runs.
      window.addEventListener("error", function (e) {
        var b = document.getElementById("boot");
        if (b && b.textContent.indexOf("booting") === 0) {
          b.style.color = "#fda4af";
          b.textContent = "boot error: " + (e.message || e.type);
        }
      });
    </script>
  </body>
</html>
`;

function CodeView({
  code,
  isStreaming,
  style,
}: {
  code: string;
  isStreaming: boolean;
  style: CSSProperties;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = code.split("\n");

  // Stick the viewport to the bottom while new lines are arriving so the
  // user always sees the latest token. Only auto-scroll if the user is
  // already near the bottom — preserves manual scroll-up to inspect.
  const stickBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      stickBottomRef.current = distanceFromBottom < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [code]);

  return (
    <div
      ref={scrollRef}
      style={style}
      className="select-text overflow-auto bg-[#0e0e0e] font-mono text-[12px] leading-[18px] text-neutral-200"
      // The pane is intentionally read-only while streaming; selection is
      // still allowed but contentEditable is off so accidental keypresses
      // can't enter content.
      tabIndex={-1}
    >
      <pre className="m-0 p-0">
        {lines.map((line, i) => {
          const isLast = i === lines.length - 1;
          return (
            <div key={i} className="flex">
              <span className="select-none w-10 flex-shrink-0 pr-3 text-right text-neutral-600">
                {i + 1}
              </span>
              <code className="whitespace-pre">
                {line || " "}
                {isLast && isStreaming && (
                  <span
                    aria-hidden="true"
                    className="ml-0.5 inline-block h-[14px] w-[7px] -translate-y-[1px] animate-pulse rounded-[1px] bg-indigo-400 align-middle"
                  />
                )}
              </code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

export default function LivePreview({
  code,
  rawCode,
  isStreaming = false,
  showCode = true,
  showPreview = true,
}: {
  code: string;
  // Raw, un-repaired streaming source. Shown verbatim in the code editor so
  // the user always sees the freshest token even when repairCode falls back
  // to the previous good frame for the iframe.
  rawCode?: string;
  isStreaming?: boolean;
  showCode?: boolean;
  showPreview?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const codeRef = useRef(code);
  codeRef.current = code;

  // Listen for the runner-ready handshake from the iframe runtime.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === "runner-ready") {
        setIframeReady(true);
        // Push whatever the latest code is so we don't drop the very first
        // frame if the iframe boots after some chunks already arrived.
        iframeRef.current?.contentWindow?.postMessage(
          { type: "code", code: codeRef.current },
          "*"
        );
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Stream every code change into the iframe once it's ready.
  useEffect(() => {
    if (!iframeReady) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "code", code },
      "*"
    );
  }, [code, iframeReady]);

  // If the iframe doesn't say hello within 1.5s (e.g. parent mounted before
  // the message listener), nudge it — it will reply if it's already up.
  useEffect(() => {
    if (iframeReady) return;
    const t = setInterval(() => {
      iframeRef.current?.contentWindow?.postMessage({ type: "ping" }, "*");
    }, 800);
    return () => clearInterval(t);
  }, [iframeReady]);

  const [editorFrac, setEditorFrac] = useState(0.5);
  const containerRef = useRef<HTMLDivElement>(null);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const onMove = (ev: MouseEvent) => {
      const frac = (ev.clientX - rect.left) / rect.width;
      setEditorFrac(Math.max(0.15, Math.min(0.85, frac)));
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
  }, []);

  const editorStyle: CSSProperties = showPreview
    ? { width: `calc(${editorFrac * 100}% - 3px)`, height: "100%", flexShrink: 0 }
    : { flex: 1, height: "100%" };

  const previewStyle: CSSProperties = { flex: 1, height: "100%", minWidth: 0 };

  return (
    <div ref={containerRef} className="flex h-full w-full bg-[#151515]">
      {showCode && (
        <CodeView
          code={rawCode && rawCode.length > 0 ? rawCode : code}
          isStreaming={isStreaming}
          style={editorStyle}
        />
      )}
      {showCode && showPreview && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={onResizeStart}
          className="group relative w-[6px] flex-shrink-0 cursor-col-resize bg-neutral-800 transition hover:bg-indigo-500/50"
        >
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-neutral-700 group-hover:bg-indigo-400" />
        </div>
      )}
      {showPreview && (
        <iframe
          ref={iframeRef}
          srcDoc={RUNNER_HTML}
          title="Live Preview"
          style={previewStyle}
          className="border-0 bg-white"
        />
      )}
      {!showCode && !showPreview && (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
          Both panels hidden — toggle one back from the toolbar.
        </div>
      )}
    </div>
  );
}
