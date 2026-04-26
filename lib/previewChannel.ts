export const PREVIEW_CHANNEL = "artifacts-preview";

export type PreviewMessage =
  | { type: "ready" }
  | { type: "code"; code: string };
