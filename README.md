# Artifacts

A self-hosted clone of [Claude Artifacts](https://claude.ai/artifacts): chat with an LLM, watch a single self-contained React component stream into the right pane and render live, character by character. The structural chrome (containers, headers, controls) appears first; detail (lists, computed sections, text) fills in as more tokens arrive. Open the preview in a popped-out window, edit the prompt, repeat.

There is no external bundler service involved at runtime — the iframe transpiles JSX with [Babel-standalone](https://babeljs.io/docs/babel-standalone) on the fly and resolves React / `lucide-react` through an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) pointing at [esm.sh](https://esm.sh). It works offline once the iframe shell, Babel, and the few esm.sh modules are cached.

## Features

- Streamed JSX rendered live as it arrives — partial code keeps repairing into a parseable component on every chunk
- Resizable three-pane layout: chat, code editor, live preview
- Pop-out preview window synchronized via `BroadcastChannel`
- Keyboard shortcuts: `⌘1` toggle chat, `⌘2` toggle code, `⌘3` toggle preview, `⌘E` pop the preview into a new window
- Pluggable models: Anthropic Claude Haiku 4.5 (cloud) or LM Studio Gemma (local, free)
- Tailwind utility classes resolved inside the preview iframe via the Tailwind play CDN — no build step for the streamed component

## Stack

- [Next.js 14](https://nextjs.org/) App Router, React 18, TypeScript
- [Vercel AI SDK](https://sdk.vercel.ai/) (`ai@4`) with `@ai-sdk/anthropic` and `@ai-sdk/openai`
- [Tailwind CSS](https://tailwindcss.com/)
- [`lucide-react`](https://lucide.dev/) for icons (both in the host app and in streamed components)
- [Babel-standalone](https://babeljs.io/docs/babel-standalone) for in-browser JSX/TSX transpilation
- [esm.sh](https://esm.sh) for runtime ES module resolution

## Run it locally

### 1. Prerequisites

- Node.js 20+ and npm
- An [Anthropic API key](https://console.anthropic.com/) (only required if you want to use the cloud model; the LM Studio path needs a local LM Studio server instead)

### 2. Install

```bash
git clone <this repo>
cd Artifacts
npm install
```

### 3. Configure

Create a `.env` file at the project root:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` is gitignored. The Anthropic SDK reads `ANTHROPIC_API_KEY` from `process.env` at request time — there is no other configuration.

If you want to use the local LM Studio model instead of Anthropic, edit `app/api/chat/route.ts` and update the `lmstudio` `baseURL` (and `apiKey` if your LM Studio install requires one) to point at your machine.

### 4. Start the dev server

```bash
npm run dev
```

Next will pick `localhost:3000` if free or fall back to the next available port. Open the URL it prints.

### 5. Use it

- Pick a model from the dropdown (top-left). "Claude Haiku 4.5" hits Anthropic; "Gemma (LM Studio)" hits the local endpoint.
- Type a prompt — for example, *"Build a pricing card with three tiers"* — and press Enter.
- Watch the right pane fill in as tokens arrive. The structural chrome (containers, headers) appears first; the streamed component's content reflows as detail arrives.
- Drag the gutter between the chat, code editor, and preview to resize.
- Press `⌘E` (or click *Pop out*) to open the preview in its own window for a clean view.

### Build for production

```bash
npm run build
npm start
```

There is no special build configuration — it's a stock Next.js production build.

## Project layout

```
app/
  api/chat/route.ts     server-side streaming endpoint (AI SDK)
  preview/page.tsx      popped-out preview window
  layout.tsx, page.tsx  root layout + main page
components/
  Workspace.tsx         3-pane layout, chat state machine
  LivePreview.tsx       in-browser bundler iframe + code editor view
lib/
  extractJsx.ts         pulls the fenced JSX block out of the streamed message
  repairCode.ts         lex-aware repair for partial JSX/TSX streams
  previewChannel.ts     BroadcastChannel name shared by app + popped-out window
```

For an in-depth walkthrough of how the streaming pipeline works end to end, see [`TECHNICALS.md`](./TECHNICALS.md). For the security posture and recommended hardening before deploying this anywhere shared or public, see [`SECURITY.md`](./SECURITY.md).
