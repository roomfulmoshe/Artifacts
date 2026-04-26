"use client";

import { useEffect, useState } from "react";
import { Code2, Eye, Loader2 } from "lucide-react";
import SandpackPane from "@/components/SandpackPane";
import { PREVIEW_CHANNEL } from "@/lib/previewChannel";

export default function PreviewPage() {
  const [code, setCode] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      setCode(
        `export default function App() {\n  return <div className="p-8">BroadcastChannel is not supported in this browser.</div>;\n}\n`
      );
      return;
    }
    const ch = new BroadcastChannel(PREVIEW_CHANNEL);
    let lastCode: string | null = null;
    let streamingTimer: ReturnType<typeof setTimeout> | null = null;
    ch.onmessage = (e) => {
      if (e.data?.type === "code" && typeof e.data.code === "string") {
        if (e.data.code !== lastCode) {
          lastCode = e.data.code;
          setCode(e.data.code);
          setStreaming(true);
          if (streamingTimer) clearTimeout(streamingTimer);
          streamingTimer = setTimeout(() => setStreaming(false), 700);
        }
      }
    };
    ch.postMessage({ type: "ready" });
    document.title = "Artifacts · Preview";
    return () => {
      if (streamingTimer) clearTimeout(streamingTimer);
      ch.close();
    };
  }, []);

  if (code === null) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-sm text-neutral-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Waiting for the source window…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
        <Eye className="h-4 w-4 text-indigo-400" />
        <h1 className="text-sm font-medium">Artifacts · Preview</h1>
        {streaming && (
          <span className="ml-2 flex items-center gap-1 text-xs text-indigo-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
            streaming
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowCode((v) => !v)}
          className={`ml-auto flex h-8 items-center rounded-md px-2 text-xs transition hover:bg-neutral-800 hover:text-neutral-100 ${
            showCode ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
          }`}
          aria-pressed={showCode}
          title={showCode ? "Hide code" : "Show code"}
        >
          <Code2 className="h-4 w-4" />
          <span className="ml-1.5">{showCode ? "Hide code" : "Show code"}</span>
        </button>
      </header>
      <div className="flex-1 overflow-hidden">
        <SandpackPane code={code} showCode={showCode} showPreview />
      </div>
    </div>
  );
}
