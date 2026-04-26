import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, type CoreMessage, type LanguageModel } from "ai";

export const runtime = "nodejs";
export const maxDuration = 60;

const lmstudio = createOpenAI({
  baseURL: "http://172.25.141.248:1234/v1",
  apiKey: "sk-lm-pr5YuOyw:yWWO8CanFZd11WNQABMh",
});

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are an expert React + Tailwind UI engineer.

Whenever the user asks for a UI, widget, screen, or any visual element, you MUST respond with ONE single, self-contained React component and NOTHING else outside the code block other than a brief (1-2 sentence) intro.

Hard rules for the code block:
1. Wrap the component in a fenced markdown block that opens with three backticks followed by the lowercase language tag "jsx" and closes with three backticks.
2. Use only Tailwind CSS utility classes for styling. Do not import any CSS files, styled-components, or other styling libraries.
3. Export the component as the default export named App, e.g. "export default function App() { ... }".
4. IMPORTS: The ONLY allowed import sources are the literal strings "react" and "lucide-react". The React import MUST be exactly: import React, { useState, useEffect } from "react"; (include only the hooks you actually use). NEVER import React or hooks from any other source such as "arg", "hooks", "react-dom", etc. Do NOT import any other libraries.
5. Do not use fetch, network calls, or external image URLs. Use emoji, inline <svg>, lucide-react icons, or solid-color placeholder <div>s.
6. Use functional components and React hooks only. The code must be valid TypeScript/JSX that runs inside a CodeSandbox Sandpack react-ts template with no additional setup.
7. STRUCTURE FOR PROGRESSIVE RENDERING: write the component top-down — declare hooks first, then JSX. Render the visible chrome (containers, headers, controls) BEFORE filling in detail like long lists or computed sections, so a partial stream still produces a recognisable UI.

If the user is just chatting and not asking for a UI, respond normally without a code block.`;

export type ModelChoice = "claude-haiku-4-5" | "lmstudio-gemma";

function pickModel(choice: ModelChoice | undefined): LanguageModel {
  if (choice === "lmstudio-gemma") {
    return lmstudio("google/gemma-4-26b-a4b");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env");
  }
  return anthropic("claude-haiku-4-5");
}

export async function POST(req: Request) {
  const {
    messages,
    model,
  }: { messages: CoreMessage[]; model?: ModelChoice } = await req.json();

  try {
    const result = streamText({
      model: pickModel(model),
      system: SYSTEM_PROMPT,
      messages,
      // The provider defaults to 4096 output tokens, which clips long detailed
      // components mid-stream (the model returns a "length" finish reason).
      // Haiku 4.5 supports far higher; give it room to stream a full UI.
      maxTokens: 32000,
      onFinish: ({ finishReason, usage }) => {
        // eslint-disable-next-line no-console
        console.log("[chat] finish", { finishReason, usage });
      },
    });
    return result.toDataStreamResponse();
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
