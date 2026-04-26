"use client";

import {
  SandpackProvider,
  SandpackCodeEditor,
  SandpackPreview,
  useSandpack,
} from "@codesandbox/sandpack-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

const INDEX_TSX = `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

function ensureTailwind(): Promise<void> {
  return new Promise((resolve) => {
    if (document.getElementById("tw-play-cdn")) {
      resolve();
      return;
    }
    const reset = document.createElement("style");
    reset.textContent =
      "html,body,#root{height:100%;margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}";
    document.head.appendChild(reset);

    const s = document.createElement("script");
    s.id = "tw-play-cdn";
    s.src = "https://cdn.tailwindcss.com";
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

// Catches runtime errors from a streaming App. While the source keeps
// changing, errors are likely due to in-flight partial code, so we retry
// after a short delay. Once we see the SAME error message twice in a row
// (the source landed on a real runtime bug), we stop retrying and surface
// the error clearly instead of pulsing "rendering…" forever.
class StreamBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; lastMsg: string | null; settled: boolean }
> {
  state = { error: null as Error | null, lastMsg: null as string | null, settled: false };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    const msg = String(error?.message ?? error);
    if (msg === this.state.lastMsg) {
      this.setState({ settled: true });
      return;
    }
    setTimeout(
      () => this.setState({ error: null, lastMsg: msg, settled: false }),
      250
    );
  }
  render() {
    const { error, settled } = this.state;
    if (error) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-neutral-950 p-8 text-center">
          <div className="space-y-2 max-w-md">
            <div
              className={
                "text-sm " +
                (settled
                  ? "text-rose-300"
                  : "text-neutral-300 animate-pulse")
              }
            >
              {settled ? "Component crashed at runtime" : "rendering…"}
            </div>
            <div className="text-[11px] leading-snug text-neutral-500 break-words opacity-80">
              {String(error.message).slice(0, 320)}
            </div>
          </div>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}

ensureTailwind().then(() => {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StreamBoundary>
      <App />
    </StreamBoundary>
  );
});
`;

// Module-level constants so the SandpackProvider props keep stable identity
// across renders. SandpackProvider re-syncs internal file state whenever
// files / customSetup / template change by reference — passing fresh object
// literals every render makes it overwrite our streaming `updateFile` calls.
const CUSTOM_SETUP = {
  dependencies: {
    "lucide-react": "^0.460.0",
  },
};

// "immediate" recompile mode triggers a rebuild on every updateFile. Sandpack
// internally guards each rebuild with `client.status === "done"`, so updates
// that arrive while a build is in flight are dropped — the next call after
// the build completes picks up the latest file state. This naturally
// throttles to whatever cadence the bundler can keep up with.
//
// Do NOT use "delayed" here: that mode is a pure debounce (`clearTimeout`
// on every update), so a steady stream of chunks <200ms apart keeps
// resetting the timer and the preview never recompiles until the stream
// ends.
const SANDPACK_OPTIONS = {
  recompileMode: "immediate" as const,
  classes: {
    "sp-wrapper": "!h-full",
    "sp-layout": "!h-full !rounded-none !border-0",
  },
};

function CodeSync({ code }: { code: string }) {
  const { sandpack } = useSandpack();
  // Caller (Workspace) has already passed `code` through repairCode, so it is
  // guaranteed to be parseable. Always trigger a preview rebuild — Sandpack's
  // recompileDelay debounces multiple rapid updates from the stream.
  useEffect(() => {
    sandpack.updateFile("/App.tsx", code, true);
  }, [code, sandpack]);
  return null;
}

export default function SandpackPane({
  code,
  showCode = true,
  showPreview = true,
}: {
  code: string;
  showCode?: boolean;
  showPreview?: boolean;
}) {
  // Capture the very first code value so that the `files` prop reference
  // we hand to SandpackProvider never changes — preventing the provider
  // from periodically resetting its internal file state mid-stream.
  const initialCodeRef = useRef(code);
  const initialFiles = useMemo(
    () => ({
      "/App.tsx": { code: initialCodeRef.current, active: true },
      "/index.tsx": { code: INDEX_TSX, hidden: true },
    }),
    []
  );

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
    <SandpackProvider
      template="react-ts"
      theme="dark"
      customSetup={CUSTOM_SETUP}
      files={initialFiles}
      options={SANDPACK_OPTIONS}
    >
      <CodeSync code={code} />
      <div ref={containerRef} className="flex h-full w-full bg-[#151515]">
        {showCode && (
          <SandpackCodeEditor
            showLineNumbers
            showTabs={false}
            showInlineErrors
            wrapContent
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
          <SandpackPreview
            showOpenInCodeSandbox={false}
            showRefreshButton
            style={previewStyle}
          />
        )}
        {!showCode && !showPreview && (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
            Both panels hidden — toggle one back from the toolbar.
          </div>
        )}
      </div>
    </SandpackProvider>
  );
}
