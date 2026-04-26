# TECHNICALS

A complete, mechanical walkthrough of how a single keystroke in the chat textbox becomes a live React component rendering in the preview iframe. Everything below maps directly to source files in this repo; nothing is hypothetical.

The goal is for someone who has never seen the project to be able to set a breakpoint anywhere in the pipeline, predict what state the system is in, and explain why the next chunk produces the next visible frame.

## Table of contents

1. [System diagram](#system-diagram)
2. [Request lifecycle](#request-lifecycle)
3. [Server: `app/api/chat/route.ts`](#server-appapichatroutets)
4. [Client state: `Workspace.tsx`](#client-state-workspacetsx)
5. [`extractJsx`: pulling code out of the streamed message](#extractjsx-pulling-code-out-of-the-streamed-message)
6. [`repairCode`: keeping mid-stream code parseable](#repaircode-keeping-mid-stream-code-parseable)
7. [`LivePreview`: the in-browser bundler iframe](#livepreview-the-in-browser-bundler-iframe)
8. [The runner script (inside the iframe)](#the-runner-script-inside-the-iframe)
9. [`StreamBoundary` and the `lastGoodApp` fallback](#streamboundary-and-the-lastgoodapp-fallback)
10. [Auto-scrolling code view + raw vs repaired streams](#auto-scrolling-code-view--raw-vs-repaired-streams)
11. [Pop-out preview via BroadcastChannel](#pop-out-preview-via-broadcastchannel)
12. [Failure modes & how the system survives them](#failure-modes--how-the-system-survives-them)
13. [Performance characteristics](#performance-characteristics)
14. [Why not Sandpack](#why-not-sandpack)

---

## System diagram

```
+--------- browser tab (localhost:3001) ----------------------------------+
|                                                                         |
|   +-- Workspace.tsx ----------------------------------------+           |
|   |  useChat({ api: '/api/chat' })  ---HTTP/SSE--->  Next.js| --(SDK)-> Anthropic / LM Studio
|   |                                                          |          |
|   |  messages[] (assistant content grows token by token)     |          |
|   |     |                                                    |          |
|   |     v                                                    |          |
|   |  extractJsx(content)  --raw stream of code--+            |          |
|   |                                              |           |          |
|   |  repairCode(raw)  ---repaired snapshot-->-+  |           |          |
|   |     ^                                     |  |           |          |
|   |     +-- lastGoodRef (sticky frame on null)|  |           |          |
|   |                                           |  |           |          |
|   +-- LivePreview.tsx ----------------------+ |  |           |          |
|       CodeView <-- raw ------------- (auto- | |  |           |          |
|         scroll, blinking caret)             | |  |           |          |
|       <iframe srcDoc=RUNNER_HTML>           | |  |           |          |
|         postMessage({type:'code', code:repaired}, '*')        |          |
|         |                                                     |          |
|         v                                                     |          |
|       +- runner script ---------------------------------+    |          |
|       | Babel.transform(code) -> Blob -> import(blobUrl)|    |          |
|       | -> default export -> React.createElement(App)   |    |          |
|       | StreamBoundary key=token  <-- never gets stuck  |    |          |
|       | lastGoodApp <-- compile-error fallback          |    |          |
|       +-------------------------------------------------+    |          |
|                                                              |          |
|   BroadcastChannel('artifacts-preview')  <----->  /preview   |          |
|                                                              |          |
+--------------------------------------------------------------+----------+
```

Every box has a single responsibility; the only state that crosses module boundaries is the assistant's growing message string and a few derived projections of it.

---

## Request lifecycle

A single user submission produces a sequence that looks like this (timestamps are approximate, from the dijkstra prompt run; see git log for evidence):

| t (ms after submit) | Event |
|---|---|
| 0 | `Workspace` calls `handleSubmit` → `useChat` POSTs `{messages, model}` to `/api/chat` |
| ~50 | Next.js streams the request to `streamText` (AI SDK). Anthropic SSE stream begins. |
| 200–800 | First tokens (intro sentence) arrive. `useChat` mutates the assistant message. `extractJsx` returns `null` (no fence yet). |
| ~900 | The first ` ```jsx\n ` fence arrives. `extractJsx` starts returning the body. |
| every ~150–300 ms | More tokens arrive. `Workspace`'s `useMemo` for `latestRawCode` re-runs; `repairCode` re-runs; `appCode` updates. |
| every appCode change | `LivePreview`'s `useEffect` posts `{type:'code', code}` into the iframe. |
| inside iframe | `compileAndRender(code)` increments `renderToken`, transpiles via Babel, blob-imports, mounts `<StreamBoundary key=token><App/></StreamBoundary>`. |
| ~5–25 s | Stream ends. `useChat` flips `isLoading` to false. `streamText`'s `onFinish` logs `{finishReason, usage}` server-side. |

Every chunk produces one new visible frame in the preview pane. There is no debouncing or batching anywhere on the client — the bundler-in-an-iframe is fast enough that compiling on every chunk is fine.

---

## Server: `app/api/chat/route.ts`

A 65-line file. Its only jobs are: pick a model, hand the conversation to `streamText`, return the data-stream response.

### Model selection

```ts
function pickModel(choice: ModelChoice | undefined): LanguageModel {
  if (choice === "lmstudio-gemma") {
    return lmstudio("google/gemma-4-26b-a4b");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env");
  }
  return anthropic("claude-haiku-4-5");
}
```

`anthropic` and `lmstudio` are AI SDK provider factories. `lmstudio` is just an OpenAI-compatible client pointed at a LAN address — the AI SDK doesn't care what's on the other end as long as it speaks the OpenAI Chat Completions wire format.

### System prompt

The system prompt is intentionally specific about *what* code the model is allowed to emit, because every constraint there saves complexity downstream:

- Single fenced markdown block, language tag exactly `jsx`. Reason: `extractJsx` searches for that exact pattern.
- Only `react` and `lucide-react` imports. Reason: those are the only two specifiers in the iframe's import map.
- Default export named `App`. Reason: the runner reads `mod.default` and calls `React.createElement(App)`.
- Top-down structure (declare hooks first, JSX after; visible chrome before detail). Reason: progressive rendering — a partial stream produces a recognizable UI sooner if the chrome is at the top.

### `streamText` configuration

```ts
const result = streamText({
  model: pickModel(model),
  system: SYSTEM_PROMPT,
  messages,
  maxTokens: 32000,
  onFinish: ({ finishReason, usage }) => {
    console.log("[chat] finish", { finishReason, usage });
  },
});
return result.toDataStreamResponse();
```

`maxTokens: 32000` is non-trivial. The AI SDK defaults Anthropic to 4096 output tokens, which truncated detailed components mid-string and produced unparseable code. 32k fits any single-component response Haiku 4.5 will reasonably emit.

`toDataStreamResponse()` returns a `Response` with the AI SDK's *data stream protocol* (a multiplexed SSE format that interleaves text, tool calls, and finish events). `useChat` on the client knows how to parse this.

`maxDuration = 60` (export const) tells Vercel/Next that the route may run up to 60s — long Anthropic streams need it.

---

## Client state: `Workspace.tsx`

Single component that owns the conversation, the layout state, and the derived code projections. Key state:

| State | Source | Purpose |
|---|---|---|
| `messages` | `useChat` | The conversation. Mutated by `useChat` as SSE chunks arrive. |
| `isLoading` | `useChat` | True while a request is in flight. Drives streaming UI cues + chat-input lock. |
| `model` | `useState` | "claude-haiku-4-5" or "lmstudio-gemma". Sent in the request body so the server can pick the model. |
| `showChat`, `showCode`, `showPreview`, `chatWidth` | `useState` | Layout — toggled via toolbar buttons or `⌘1`/`⌘2`/`⌘3`. |
| `latestRawCode` | `useMemo` of `messages` | The most recent assistant message run through `extractJsx`. The literal raw stream. |
| `appCode` | `useMemo` of `latestRawCode` | `repairCode(latestRawCode)` if it returned a string, else `lastGoodRef.current`. The "always parseable" version. |
| `lastGoodRef` | `useRef` | Sticky storage of the last successful `repairCode` output. `repairCode` currently never returns null on non-empty input, but the ref is still there as a belt-and-suspenders. |

Two effects:

- Auto-scroll the chat pane to bottom on every `messages` change.
- Maintain a `BroadcastChannel('artifacts-preview')` subscriber. When the popped-out preview window posts `{type:'ready'}`, push the current `appCode` to it. On every `appCode` change, broadcast it.

Keyboard shortcut effect listens for `⌘1`/`⌘2`/`⌘3`/`⌘E` and toggles panels / pops out the preview.

The chat textarea is `disabled={isLoading}` and the placeholder switches to `"streaming response…"` when locked.

`onSubmit` calls `handleSubmit(e, { body: { model: modelRef.current } })` — the AI SDK's escape hatch for sending extra fields next to the conversation.

The component renders three concurrent things from the same source:

1. The chat bubbles (left pane) — the assistant's full message, run through `stripCode` to remove the JSX fence so the user sees only the prose summary.
2. The CodeView inside `LivePreview` — `latestRawCode` verbatim. Even when `repairCode` would output something different, the user sees what the model is literally typing.
3. The iframe inside `LivePreview` — `appCode` (repaired). The iframe only sees parseable code.

This split is load-bearing: when `repairCode` truncates back to the last clean position (mid-string repair), CodeView still advances, so the user has visual confirmation that the stream is alive.

---

## `extractJsx`: pulling code out of the streamed message

```ts
const FENCE_OPEN = /```(?:jsx|tsx|javascript|js|typescript|ts|react)?\s*\n/i;
```

Scans for the first opening fence, captures everything between that and the next ` ``` ` (or end of message if the closing fence hasn't streamed yet). The body is then run through `sanitizeCode`, which:

- Normalizes any `import React, { hooks } from "anywhere"` into `import React, { hooks } from "react"`. The model occasionally hallucinates module names like `"arg"` or `"hooks"`; this stamps them back to `react`.
- For `import { X } from "pkg"`: if `pkg` is in `ALLOWED_PACKAGES = {react, react-dom, lucide-react}` the import passes through. Otherwise, if every named import is a known React export (`useState`, `Fragment`, etc.), the `from` is rewritten to `"react"`. Otherwise the import is dropped entirely.

This fights one specific failure mode: small models that emit `import { useState } from "react-hooks"` or invent fake helper packages. Without this sanitizer, the import map can't resolve those specifiers and the dynamic import throws a `TypeError: Failed to resolve module specifier`.

`extractJsx` returns `null` until the message contains the opening fence, so during the first ~500ms of a response the preview shows the default app.

---

## `repairCode`: keeping mid-stream code parseable

This is the single hardest component in the codebase. It takes a string that may end mid-JSX, mid-string, mid-comment, or mid-bracket, and returns something Babel can parse. Without it the preview would crash on every chunk.

### Algorithm

A single forward pass, character-by-character lex tracker:

```
state: { inLine, inBlock, str, stack[], lastClean, lastCleanStack }
```

- `stack` holds pending closers: `'}'`, `')'`, `']'`, or a JSX entry `{ jsx: tagName }`.
- `lastClean` is the index just past the most recent position where we are NOT inside a string, comment, or partially-parsed JSX tag. Whenever a clean transition happens (a string closes, a tag closes, a bracket pushes/pops), we call `snapshotClean(i)` to remember "this is a safe place to truncate to."
- `lastCleanStack` is a slice of the stack at that snapshot, so we know what to close from there.

After walking the whole input:

- If we ended cleanly (no open string, no open block comment, no half-parsed tag) → `body = src`, `activeStack = stack`.
- If we ended mid-something → `body = src.slice(0, lastClean)`, `activeStack = lastCleanStack`. We throw away the partial tail and recover from the last known good position.

Then we build a `tail` string from `activeStack` (in reverse): `'}'`, `')'`, `']'`, or `</TagName>` for each JSX entry. Concatenate `body + tail`. If the body lacks `export default`, we either append `\nexport default App;` (if a function `App` is defined) or replace with a fallback nullary component.

There's also a small expression-filler heuristic: if the body ends with an operator that demands a right-hand side (`(`, `[`, `=`, `+`, etc.) we insert `null` before the closers so we don't produce `(` followed by `)` directly. And if the body ends with a bare `return\s*$`, we also append `null` so a function body doesn't return undefined (which throws in React 18).

### `consumeJsxTag`

A sub-routine that, given a `<` index, parses the entire JSX tag and either pushes a JSX entry onto the stack (open tag), pops one (close tag), or does neither (self-closing). Internally it walks attribute strings (`"..."`, `'...'`) and `{...}` expression containers using its own depth counter so attribute values don't confuse the outer lexer.

### `isJsxOpen`

Disambiguator for whether a `<` starts a JSX element or a TS generic / comparison. Heuristic: look at the previous non-whitespace char.

- If it's an identifier, `)`, or `]`, this is probably a generic call site (`useState<number>`) or a comparison — *unless* the identifier is `return`, `yield`, or `await`, which introduce expressions where JSX is allowed.
- Otherwise (after `=>`, `=`, `(`, `[`, `{`, `,`, `;`, `?`, `:`, `&&`, `||`, `!`, `>`) we treat it as JSX.

This is a heuristic and will get fooled by some valid TS, but for the model output we see in practice it's never wrong.

### The JSX-text apostrophe bug (fixed)

Earlier versions of this lexer treated `'`, `"`, and `` ` `` as string delimiters everywhere. JSX *text* (the characters between an open tag's `>` and the next `<`) doesn't follow JS string rules — apostrophes there are literal. So a chunk containing `Dijkstra's algorithm` followed elsewhere by `useState('start')` would have the apostrophes mis-pair: the lexer would enter "string mode" at the `'` in *Dijkstra's*, swallow `s algorithm` and any intervening tags, exit string mode at the `'` opening `useState('`, and so on. Pushes/pops that should have happened inside that swallowed range never landed on the stack. At end of input the stack had stale opens that didn't match the closes the lexer had observed — so `repairCode` would *truncate* otherwise-valid code back to `lastClean` and then *append* spurious `</div>` closers.

The visible symptom: the iframe rendered an old, partial frame (just a header) even though the full code had streamed.

The fix: when the top of the stack is a JSX entry (i.e. we're inside an open tag, between a `>` and the next `<`), treat `'`, `"`, and `` ` `` as literal characters and snapshot a clean position. We're NOT inside JSX text when the top of the stack is a `'}'` (which is what `{` pushes for a JSX expression container) — at that point we're back in JS rules and quotes resume their normal meaning.

The check is one line:

```ts
const top = stack[stack.length - 1];
const inJsxText = top !== undefined && typeof top !== "string";
```

`typeof top === "string"` for raw closers (`'}'`/`')'`/`']'`), and `typeof top === "object"` for JSX entries (`{ jsx: 'div' }`). If `inJsxText`, skip the quote.

---

## `LivePreview`: the in-browser bundler iframe

```tsx
<iframe
  ref={iframeRef}
  srcDoc={RUNNER_HTML}
  title="Live Preview"
  className="border-0 bg-white"
/>
```

`RUNNER_HTML` is a complete HTML document defined as a template literal at module scope. Setting `srcDoc` makes the browser create a fresh document with `about:srcdoc` as its URL. With no `sandbox` attribute, the iframe inherits the parent's origin (`http://localhost:3001`). This is convenient for debugging — you can `iframe.contentDocument.querySelector(...)` from the parent — and a security concern (see [`SECURITY.md`](./SECURITY.md)).

### Boot sequence

The HTML loads in order:

1. `<script src="https://cdn.tailwindcss.com">` — synchronous, exposes the Tailwind play CDN. After this returns, any class on any element is generated on demand.
2. `<script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js">` — synchronous, exposes `window.Babel`.
3. `<script type="importmap">` — declarative; the browser parses it eagerly so subsequent module imports resolve.
4. `<script type="module">` — deferred. By the time it runs, both Tailwind and Babel are available globally.

The module script:

1. Imports `react` and `react-dom/client` via the import map (which redirects to esm.sh URLs with pinned versions and `?deps=` so React's identity is shared across packages).
2. Defines `StreamBoundary` and `compileAndRender`.
3. Creates a single `createRoot(rootEl)`.
4. Hides the boot overlay once the first successful render lands.
5. Posts `{type:'runner-ready'}` to `window.parent`.

### Parent ↔ iframe handshake

The parent's `LivePreview` listens for `message` events:

```ts
useEffect(() => {
  const onMsg = (e: MessageEvent) => {
    if (e.source !== iframeRef.current?.contentWindow) return;
    if (e.data?.type === "runner-ready") {
      setIframeReady(true);
      // Push current code in case the iframe booted after some chunks
      iframeRef.current?.contentWindow?.postMessage(
        { type: "code", code: codeRef.current },
        "*"
      );
    }
  };
  window.addEventListener("message", onMsg);
  return () => window.removeEventListener("message", onMsg);
}, []);
```

If the parent's mount races the iframe's load and the parent's listener attaches *after* the iframe sent `runner-ready`, the iframe never re-broadcasts on its own. To recover, the parent pings every 800ms while `iframeReady === false`; the iframe responds to `{type:'ping'}` by re-broadcasting `runner-ready`. Once ready, the ping interval clears.

After ready, every `code` change in the parent fires an effect:

```ts
useEffect(() => {
  if (!iframeReady) return;
  iframeRef.current?.contentWindow?.postMessage({ type: "code", code }, "*");
}, [code, iframeReady]);
```

There is no throttling. React batching already coalesces multiple synchronous state updates, and the iframe's `compileAndRender` is async + token-guarded, so the only message that produces visible output is the latest one.

---

## The runner script (inside the iframe)

```js
let renderToken = 0;
let lastBlobUrl = null;
let lastGoodApp = null;
```

`renderToken` is a monotonically increasing counter. Every entry into `compileAndRender` captures a `myToken = ++renderToken` and checks `myToken !== renderToken` at every async boundary; if a newer call has started, the older one bails out. This is the entire concurrency control mechanism — there is no queue, no mutex, no debounce.

### `compileAndRender(code)`

1. **Wait for Babel.** If `window.Babel` is somehow not yet set (the module script only runs after the synchronous Babel load, but on slow CDN paths this could in principle race), poll every 30ms.

2. **Transpile.**
   ```js
   window.Babel.transform(code, {
     filename: "App.tsx",
     presets: [
       ["react", { runtime: "classic" }],
       ["typescript", { allExtensions: true, isTSX: true }],
     ],
     sourceMaps: false,
   }).code
   ```
   `runtime: "classic"` produces `React.createElement(...)` calls and requires `React` to be in scope. The model's system prompt forces `import React, ... from "react"` so `React` is imported. Using `automatic` would also work but requires adding `react/jsx-runtime` to the import map; classic is one fewer dependency.

3. **Make it a module.** The transformed string is still ESM (with `import` statements). To execute it, wrap it in a `Blob` of MIME `text/javascript` and `URL.createObjectURL`:
   ```js
   const blob = new Blob([transformed], { type: "text/javascript" });
   const url = URL.createObjectURL(blob);
   const mod = await import(url);
   ```
   The browser's module loader resolves `import "react"` etc. through the import map → esm.sh, fetches them, and produces a module record with a `default` export.

4. **Reuse-or-revoke blob URLs.** After `await import(url)`, the URL has served its purpose; revoking it is safe. We keep `lastBlobUrl` so each call revokes the *previous* blob (idempotent), holding the current one alive briefly in case any micro-task still resolves against it. This is a memory hygiene measure — without revocation, a 10-minute streaming session leaks 50+ blob URLs.

5. **Token check.** If a newer `compileAndRender` started while we were awaiting Babel or `import()`, this entire result is stale; bail without rendering.

6. **Cache last-good.**
   ```js
   lastGoodApp = App;
   ```
   We do this *before* `root.render()` because `App` is already the source of truth — even if `root.render` later throws, `lastGoodApp` is correctly set to the most recent component that compiled.

7. **Mount.**
   ```js
   root.render(
     React.createElement(StreamBoundary, { key: myToken },
       React.createElement(App)
     )
   );
   ```
   The `key={myToken}` is critical. Without it, the boundary's internal state (specifically `error`) carries across renders. With it, every successful compile produces a *fresh* boundary mount, so a chunk that crashed never blocks the next chunk from being rendered.

8. **On error.** The catch block kicks in for *compile-time* failures (Babel parse error, blob import error, missing default export). If we have a `lastGoodApp`, re-render it under a fresh-keyed boundary so the user keeps seeing the last working frame instead of a blank pane. If there's no good frame yet (very early in the stream), surface a small "rendering…" status.

Runtime errors thrown by `App.render()` itself are caught by `StreamBoundary` (see next section).

---

## `StreamBoundary` and the `lastGoodApp` fallback

```js
class StreamBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return React.createElement("div", { className: "fixed bottom-2 right-2 ... text-rose-700 ..." },
        "rendering… ",
        React.createElement("span", null, String(this.state.error.message).slice(0, 200))
      );
    }
    return this.props.children;
  }
}
```

This is a stripped-down React error boundary. There is no retry logic, no settle-after-N-errors, no setState in `componentDidCatch`. The "retry" semantics come entirely from the parent re-mounting the boundary with a new `key` on every successful compile.

The visible error UI is a small toast at `bottom-right`, not a full-pane overlay. The previous DOM under it stays mounted (because the boundary's children don't unmount when the boundary remounts with a new key — wait, actually they do: a new key creates a brand-new boundary subtree, so children do remount). The visible behavior is: while a chunk is broken, the toast appears on top of an empty root; when the next chunk fixes it, the toast disappears and the new App mounts.

Combined with the compile-error fallback to `lastGoodApp`, there are three observable states:

| Compile result | Boundary state | What the user sees |
|---|---|---|
| Success | clean | New App rendered |
| Babel/import error, `lastGoodApp` exists | clean (fallback rendered) | Last good App rendered (visually unchanged) |
| Babel/import error, no `lastGoodApp` yet | clean | "rendering…" status text |
| Compile success, App throws at render time | error | Toast over empty root |

The fourth state is rare in practice because the model is told to keep components self-contained and free of network/IO. When it happens, the next chunk usually fixes it.

---

## Auto-scrolling code view + raw vs repaired streams

The code editor (left pane inside `LivePreview`) shows `latestRawCode`, not `appCode`. Why:

`appCode = repairCode(latestRawCode) ?? lastGoodRef.current`. When `repairCode` truncates back to `lastClean` (mid-string mid-stream), `appCode` is shorter than `latestRawCode`. If we displayed `appCode` in the editor, the editor would visually "freeze" at the last clean position while the iframe's preview kept changing — confusing.

So we send `rawCode` to the editor and `code` (repaired) to the iframe. The user sees the literal model output in the editor and a repaired-and-rendered version in the preview.

### Auto-scroll-to-bottom

```tsx
const stickBottomRef = useRef(true);
useEffect(() => {
  const el = scrollRef.current;
  const onScroll = () => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickBottomRef.current = distanceFromBottom < 80;
  };
  el.addEventListener("scroll", onScroll);
  return () => el.removeEventListener("scroll", onScroll);
}, []);
useEffect(() => {
  const el = scrollRef.current;
  if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
}, [code]);
```

Two effects. The first listens for user scroll and updates `stickBottomRef` to true if the user is within 80px of the bottom, false otherwise. The second runs on every code change and only auto-scrolls if `stickBottomRef.current` is true.

This means: while tokens stream in, the view sticks to the bottom and the user follows the latest line. If the user manually scrolls up to inspect an earlier section, auto-scroll disengages. Scrolling back to the bottom re-engages it.

### Streaming caret

Last-line-only blinking indigo caret rendered when `isStreaming` is true:

```tsx
{isLast && isStreaming && (
  <span className="ml-0.5 inline-block h-[14px] w-[7px] animate-pulse rounded-[1px] bg-indigo-400 align-middle" />
)}
```

Pure visual cue; no functional purpose.

---

## Pop-out preview via BroadcastChannel

`⌘E` (or the Pop out toolbar button) calls `window.open("/preview", "artifacts-preview", "width=1200,height=900,noopener=no")`. The popped-out window is an instance of `app/preview/page.tsx`, which:

1. On mount, subscribes to `BroadcastChannel("artifacts-preview")`.
2. Posts `{type:'ready'}` to announce itself.
3. Sets `code` state on every received `{type:'code', code}` and toggles a 700ms-debounced "streaming" indicator.
4. Renders `<LivePreview code={code} showCode={showCode} showPreview />`.

The main `Workspace` opens its own `BroadcastChannel("artifacts-preview")`, listens for `{type:'ready'}` (broadcast by the popped-out window), and replies with the current `appCode`. From then on, every `appCode` change posts to the channel and both windows render in lockstep.

`BroadcastChannel` is same-origin only and does not cross over to the iframe (the iframe is a separate browsing context using `postMessage`, not `BroadcastChannel`).

The popped-out window's iframe is fresh — it loads its own copy of Babel and esm.sh modules. After warm cache, this is essentially free.

---

## Failure modes & how the system survives them

| Failure | Where | What happens | Recovery |
|---|---|---|---|
| Network drop mid-stream | useChat / SSE | `messages` stops growing | User submits again; conversation context preserved |
| Anthropic API error 4xx/5xx | route.ts catch | Returns `{error}` JSON | useChat surfaces it; chat unblocks |
| Model emits unparseable JSX | extractJsx + repairCode | repairCode truncates and closes | Visible code editor still shows the unparseable raw; preview stays on last good |
| Babel transform throws | iframe runner | catch block falls back to lastGoodApp | Last good frame stays; next chunk retries |
| `import()` of blob fails (esm.sh outage) | iframe runner | catch block falls back to lastGoodApp | Last good frame stays |
| App throws at runtime | StreamBoundary | error toast in iframe corner | Next compile remounts boundary fresh |
| Iframe boots after parent mounts | postMessage handshake | parent ping every 800ms, iframe replies runner-ready | iframeReady flips, code is sent |
| Tailwind CDN slow | iframe runner | Boot overlay shows "booting runtime…" until rendered | Once script loads, classes hydrate retroactively |
| LM Studio endpoint unreachable | route.ts | streamText throws, route returns 500 | useChat surfaces error |

The single most important property is: **every successful compile is independent of every previous compile.** The renderer holds no state across chunks except `lastGoodApp` (which is monotonically updated) and `lastBlobUrl` (purely for cleanup). There is no cache to invalidate, no side-effect to reset, no observer chain to unwind.

---

## Performance characteristics

- **Tokens per chunk:** Anthropic typically sends 5–50 tokens per SSE event. At ~15 chunks/sec sustained, that's 200–700 char/sec of code, which translates to one `compileAndRender` call every ~70ms.
- **Babel transform on a 12k-char component:** ~80ms on M-series Mac. This is the dominant cost.
- **Blob URL + dynamic import of a same-iframe module:** ~5ms. esm.sh deps are cached after the first import.
- **React reconciliation of a 100-element tree:** ~5ms. Negligible.
- **Total compile-to-render latency per chunk:** ~90–120ms. Easily faster than chunks arrive.

When chunks arrive faster than compile completes, only the latest chunk's `compileAndRender` runs to completion (the older ones bail at the token check). Effectively the system throttles to "as fast as Babel can transform the latest snapshot."

Memory: Babel-standalone is ~3 MB. esm.sh React + lucide-react is ~250 KB combined. Per-chunk allocations: one Blob URL (revoked next chunk), one transient module record (GC'd when the next default-export reference is set).

---

## Why not Sandpack

The original implementation used [Sandpack](https://sandpack.codesandbox.io/) for the preview. It has a richer feature set (multiple files, package management, a real bundler) but introduces a hard dependency on CodeSandbox's hosted bundler service. During development we hit a stretch where `https://2-19-8-sandpack.codesandbox.io/` returned `503` three times in a row before serving a `200`, and even after the iframe shell loaded, the internal bundler handshake never completed — the `.sp-loading` overlay stayed up indefinitely. Streaming worked (the chars counter advanced and `updateFile` was called); the preview just never rendered anything.

The replacement (Babel-standalone + import map + esm.sh) trades a prebuilt bundler for ~30 lines of runner script. Tradeoffs:

- **Pros:** No runtime dependency on CodeSandbox infrastructure. Works with any single React component. Works offline once cached. Predictable failure modes (any failure surfaces directly from Babel or the import).
- **Cons:** Single-file only — no multi-file or package-on-the-fly support. No tree-shaking, no minification (the streamed code is already small enough this doesn't matter). esm.sh is now a CDN dependency; mitigated by the fact that browsers cache aggressively and we pin versions.

The legacy `components/SandpackPane.tsx` file is still in the repo, unused. It's safe to delete.
