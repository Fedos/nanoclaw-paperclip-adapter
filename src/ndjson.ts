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
 * Cap on the in-memory line buffer for {@link NdjsonSplitter}. Daemons are
 * expected to flush each NDJSON frame with a trailing newline; if a single
 * "line" exceeds this cap the stream is almost certainly malformed or a
 * misbehaving daemon is flooding us without delimiters. 4 MiB is generous
 * for a single log frame but small enough to cap memory blowup.
 */
export const NDJSON_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export class NdjsonBufferOverflowError extends Error {
  readonly bufferBytes: number;
  readonly limitBytes: number;
  constructor(bufferBytes: number, limitBytes: number) {
    super(
      `NDJSON line buffer exceeded ${limitBytes} bytes (current=${bufferBytes}) — daemon emitted a line without a newline or flooded without delimiters`,
    );
    this.name = "NdjsonBufferOverflowError";
    this.bufferBytes = bufferBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Incrementally split a stream of bytes/strings into NDJSON lines.
 * Buffers partial lines until a newline is seen. Throws
 * {@link NdjsonBufferOverflowError} when the pending line exceeds
 * {@link NDJSON_MAX_BUFFER_BYTES}.
 */
export class NdjsonSplitter {
  private buffer = "";
  private readonly limit: number;

  constructor(opts: { maxBufferBytes?: number } = {}) {
    this.limit = opts.maxBufferBytes ?? NDJSON_MAX_BUFFER_BYTES;
  }

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
    if (Buffer.byteLength(this.buffer, "utf8") > this.limit) {
      const size = Buffer.byteLength(this.buffer, "utf8");
      this.buffer = "";
      throw new NdjsonBufferOverflowError(size, this.limit);
    }
    return lines;
  }

  flush(): string | null {
    const remainder = this.buffer;
    this.buffer = "";
    return remainder.length > 0 ? remainder : null;
  }
}
