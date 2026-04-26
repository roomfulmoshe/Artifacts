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

ensureTailwind().then(() => {
  const root = createRoot(document.getElementById("root")!);
  root.render(<App />);
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

const SANDPACK_OPTIONS = {
  recompileMode: "delayed" as const,
  recompileDelay: 200,
  classes: {
    "sp-wrapper": "!h-full",
    "sp-layout": "!h-full !rounded-none !border-0",
  },
};

function looksRunnable(code: string): boolean {
  if (!/export\s+default/.test(code)) return false;
  let depth = 0;
  let parens = 0;
  let brackets = 0;
  let inLine = false;
  let inBlock = false;
  let inStr: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];
    if (inLine) {
      if (ch === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return false;
    } else if (ch === "(") parens++;
    else if (ch === ")") {
      parens--;
      if (parens < 0) return false;
    } else if (ch === "[") brackets++;
    else if (ch === "]") {
      brackets--;
      if (brackets < 0) return false;
    }
  }
  return (
    depth === 0 && parens === 0 && brackets === 0 && !inStr && !inBlock
  );
}

function CodeSync({ code }: { code: string }) {
  const { sandpack } = useSandpack();
  // Update the editor on every chunk, but only request a preview rebuild
  // when the code looks plausibly parseable. Sandpack's recompileDelay
  // additionally debounces the rebuilds.
  useEffect(() => {
    sandpack.updateFile("/App.tsx", code, looksRunnable(code));
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
