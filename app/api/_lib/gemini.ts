// Single-shot Gemini call. No automatic retries, no model fallback.
//
// Default model is gemini-2.5-flash. Pro was tried but latency was too
// high for an interactive recruiter UI; Flash is fast enough and good
// enough with grounding enabled. If a caller needs to override, pass
// `model` in options.
//
// This file is heavily instrumented for Vercel-side observability. Every
// call emits stage-tagged log lines keyed by requestId so a single failing
// request can be traced end-to-end across route + helper.

const DEFAULT_MODEL = "gemini-2.5-flash";
// Big enough that a fully populated profile-summary JSON (with multi-entry
// education, multi-entry previous experience, and a 4–5 line overview) is
// never truncated mid-response — truncation would break JSON parsing. The
// model only emits as many tokens as it needs, so a generous cap costs
// nothing on short outputs like the sales pitch.
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// Grounded Pro responses can occasionally take well over a minute. 120s
// leaves room for slow grounded calls without letting the request hang
// indefinitely.
const REQUEST_TIMEOUT_MS = 120_000;

const RESPONSE_PREVIEW_CHARS = 1000;

const endpoint = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

type GeminiResponseBody = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: unknown[];
      webSearchQueries?: unknown[];
      groundingSupports?: unknown[];
    };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

export type GeminiOptions = {
  apiKey: string;
  prompt: string;
  temperature: number;
  tools?: unknown[];
  // Optional override. Defaults to gemini-2.5-pro.
  model?: string;
  maxOutputTokens?: number;
  // Threaded through every log line so a single request can be traced
  // across route + gemini helper in Vercel logs.
  requestId?: string;
};

export type GeminiErrorCode = "overloaded" | "blocked" | "timeout" | "other";

// `stage` identifies the gemini-side step where things failed:
//   "5" — request never sent (network, abort, etc.)
//   "6" — request sent, response status was an error
//   "7" — body read / JSON parse failed
//   "8" — body parsed but candidates / content invalid
export type GeminiResult =
  | { ok: true; text: string; modelUsed: string; elapsedMs: number; stage: string }
  | {
      ok: false;
      status: number;
      message: string;
      code: GeminiErrorCode;
      stage: string;
      elapsedMs: number;
    };

function tag(requestId: string | undefined, stage: string, event: string, extra: Record<string, unknown> = {}) {
  const parts = [
    "[gemini]",
    `stage=${stage}`,
    `event=${event}`,
    `requestId=${requestId ?? "n/a"}`,
  ];
  for (const [k, v] of Object.entries(extra)) {
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(" ");
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return String(v);
  return JSON.stringify(v);
}

function classifyError(status: number, message: string): GeminiErrorCode {
  if (status === 429 || status === 503 || status === 502 || status === 504) {
    return "overloaded";
  }
  const m = message.toLowerCase();
  if (
    m.includes("overload") ||
    m.includes("high demand") ||
    m.includes("unavailable") ||
    m.includes("rate limit") ||
    m.includes("quota")
  ) {
    return "overloaded";
  }
  return "other";
}

function pickHeaders(headers: Headers): Record<string, string> {
  const wanted = [
    "content-type",
    "content-length",
    "server-timing",
    "x-google-backend",
    "x-vercel-id",
    "x-request-id",
  ];
  const out: Record<string, string> = {};
  for (const name of wanted) {
    const v = headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

export async function callGemini(options: GeminiOptions): Promise<GeminiResult> {
  const requestId = options.requestId;
  const model = options.model ?? DEFAULT_MODEL;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const groundingEnabled =
    Array.isArray(options.tools) && options.tools.length > 0;
  const startedAt = Date.now();

  // STAGE 5 — Gemini API request started
  console.log(
    tag(requestId, "5", "gemini_request_started", {
      model,
      timeoutMs: REQUEST_TIMEOUT_MS,
      groundingEnabled,
      promptLength: options.prompt.length,
      maxOutputTokens,
      temperature: options.temperature,
    }),
  );

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(endpoint(model), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        ...(options.tools ? { tools: options.tools } : {}),
        generationConfig: {
          temperature: options.temperature,
          maxOutputTokens,
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const elapsedMs = Date.now() - startedAt;
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.toLowerCase().includes("abort"));
    const message = err instanceof Error ? err.message : "Unknown network error";
    if (aborted) {
      console.log(
        tag(requestId, "5", "gemini_timeout", {
          model,
          elapsedMs,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
      );
      return {
        ok: false,
        status: 504,
        message: `Request to Gemini timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
        code: "timeout",
        stage: "5",
        elapsedMs,
      };
    }
    console.log(
      tag(requestId, "5", "gemini_network_error", {
        model,
        elapsedMs,
        message,
      }),
    );
    if (err instanceof Error && err.stack) {
      console.log(
        `[gemini] requestId=${requestId ?? "n/a"} stage=5 stack=${formatValue(err.stack)}`,
      );
    }
    return { ok: false, status: 0, message, code: "other", stage: "5", elapsedMs };
  }

  clearTimeout(timeoutHandle);

  // STAGE 6 — response headers received (HTTP status known, body not yet read)
  const headersElapsed = Date.now() - startedAt;
  console.log(
    tag(requestId, "6", "gemini_headers_received", {
      model,
      elapsedMs: headersElapsed,
      httpStatus: res.status,
      ok: res.ok,
      headers: pickHeaders(res.headers),
    }),
  );

  let rawText: string;
  try {
    rawText = await res.text();
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : "Body read failed";
    console.log(
      tag(requestId, "7", "gemini_body_read_failed", {
        model,
        elapsedMs,
        httpStatus: res.status,
        message,
      }),
    );
    return {
      ok: false,
      status: res.status || 502,
      message,
      code: "other",
      stage: "7",
      elapsedMs,
    };
  }

  const bodyElapsed = Date.now() - startedAt;
  // STAGE 7 — body received (size + preview only, never full body)
  console.log(
    tag(requestId, "7", "gemini_body_received", {
      model,
      elapsedMs: bodyElapsed,
      httpStatus: res.status,
      bodySize: rawText.length,
      preview: rawText.slice(0, RESPONSE_PREVIEW_CHARS),
    }),
  );

  let body: GeminiResponseBody;
  try {
    body = JSON.parse(rawText) as GeminiResponseBody;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : "JSON parse failed";
    console.log(
      tag(requestId, "7", "gemini_body_parse_failed", {
        model,
        elapsedMs,
        httpStatus: res.status,
        message,
      }),
    );
    return {
      ok: false,
      status: res.status || 502,
      message: `Non-JSON response (HTTP ${res.status})`,
      code: "other",
      stage: "7",
      elapsedMs,
    };
  }

  if (!res.ok) {
    const elapsedMs = Date.now() - startedAt;
    const apiMessage = body.error?.message ?? `HTTP ${res.status}`;
    const code = classifyError(res.status, apiMessage);
    console.log(
      tag(requestId, "6", "gemini_api_error", {
        model,
        elapsedMs,
        httpStatus: res.status,
        code,
        message: apiMessage,
      }),
    );
    return {
      ok: false,
      status: res.status,
      message: apiMessage,
      code,
      stage: "6",
      elapsedMs,
    };
  }

  if (body.promptFeedback?.blockReason) {
    const elapsedMs = Date.now() - startedAt;
    const reason = body.promptFeedback.blockReason;
    console.log(
      tag(requestId, "8", "gemini_blocked", {
        model,
        elapsedMs,
        reason,
      }),
    );
    return {
      ok: false,
      status: 502,
      message: `Blocked: ${reason}`,
      code: "blocked",
      stage: "8",
      elapsedMs,
    };
  }

  const candidates = body.candidates ?? [];
  const firstCandidate = candidates[0];
  const parts = firstCandidate?.content?.parts ?? [];

  if (candidates.length === 0) {
    const elapsedMs = Date.now() - startedAt;
    console.log(
      tag(requestId, "8", "gemini_empty_candidates", {
        model,
        elapsedMs,
      }),
    );
    return {
      ok: false,
      status: 502,
      message: "Empty candidate array from Gemini.",
      code: "other",
      stage: "8",
      elapsedMs,
    };
  }

  if (parts.length === 0) {
    const elapsedMs = Date.now() - startedAt;
    console.log(
      tag(requestId, "8", "gemini_missing_content_parts", {
        model,
        elapsedMs,
        candidateCount: candidates.length,
      }),
    );
    return {
      ok: false,
      status: 502,
      message: "Gemini response missing content.parts.",
      code: "other",
      stage: "8",
      elapsedMs,
    };
  }

  const text = parts
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
  if (!text) {
    const elapsedMs = Date.now() - startedAt;
    console.log(
      tag(requestId, "8", "gemini_empty_text", {
        model,
        elapsedMs,
        partsCount: parts.length,
      }),
    );
    return {
      ok: false,
      status: 502,
      message: "Empty response from Gemini.",
      code: "other",
      stage: "8",
      elapsedMs,
    };
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    tag(requestId, "8", "gemini_ok", {
      model,
      elapsedMs,
      bytes: text.length,
    }),
  );
  return { ok: true, text, modelUsed: model, elapsedMs, stage: "8" };
}
