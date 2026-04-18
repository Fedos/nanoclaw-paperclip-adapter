export interface NdjsonFrameBase {
  type: string;
}

export interface NdjsonLogFrame extends NdjsonFrameBase {
  type: "log";
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface NdjsonDoneFrame extends NdjsonFrameBase {
  type: "done";
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  errorMessage?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  summary?: string | null;
  resultJson?: Record<string, unknown> | null;
}

export type NdjsonFrame =
  | NdjsonLogFrame
  | NdjsonDoneFrame
  | (NdjsonFrameBase & Record<string, unknown>);

export function parseFrame(line: string): NdjsonFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed as NdjsonFrame;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Incrementally split a stream of bytes/strings into NDJSON lines.
 * Buffers partial lines until a newline is seen.
 */
export class NdjsonSplitter {
  private buffer = "";

  push(chunk: string | Uint8Array): string[] {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.buffer += text;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      lines.push(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 1);
    }
    return lines;
  }

  flush(): string | null {
    const remainder = this.buffer;
    this.buffer = "";
    return remainder.length > 0 ? remainder : null;
  }
}
