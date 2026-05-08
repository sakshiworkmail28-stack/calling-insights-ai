// Single-shot Gemini call. No automatic retries, no model fallback.
//
// Recruiter-grade routes (profile summary, sales pitch) MUST use
// gemini-2.5-pro. Paid billing is enabled and Pro materially outperforms
// Flash for grounded LinkedIn-style enrichment, education extraction, and
// previous-experience breakdowns. Falling back to Flash / 1.5 quietly
// degraded output, so this helper deliberately does not do that — if Pro
// fails, the caller surfaces a structured error and the user retries
// manually from the UI.

const DEFAULT_MODEL = "gemini-2.5-pro";
const DEFAULT_MAX_OUTPUT_TOKENS = 800;

// Grounded Pro responses can take 10-20s. 25s leaves headroom without
// letting the request hang indefinitely.
const REQUEST_TIMEOUT_MS = 25_000;

const endpoint = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

type GeminiResponseBody = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
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
};

export type GeminiErrorCode = "overloaded" | "blocked" | "timeout" | "other";

export type GeminiResult =
  | { ok: true; text: string; modelUsed: string }
  | { ok: false; status: number; message: string; code: GeminiErrorCode };

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

export async function callGemini(options: GeminiOptions): Promise<GeminiResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const startedAt = Date.now();

  console.log(`[gemini] start model=${model} timeoutMs=${REQUEST_TIMEOUT_MS}`);

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
    if (aborted) {
      console.log(
        `[gemini] timeout model=${model} elapsedMs=${elapsedMs} after ${REQUEST_TIMEOUT_MS}ms`,
      );
      return {
        ok: false,
        status: 504,
        message: `Request to Gemini timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
        code: "timeout",
      };
    }
    const message = err instanceof Error ? err.message : "Unknown network error";
    console.log(
      `[gemini] network-error model=${model} elapsedMs=${elapsedMs} message=${JSON.stringify(message)}`,
    );
    return { ok: false, status: 0, message, code: "other" };
  }

  clearTimeout(timeoutHandle);

  const rawText = await res.text();
  const elapsedMs = Date.now() - startedAt;

  let body: GeminiResponseBody;
  try {
    body = JSON.parse(rawText) as GeminiResponseBody;
  } catch {
    console.log(
      `[gemini] non-json model=${model} status=${res.status} elapsedMs=${elapsedMs}`,
    );
    return {
      ok: false,
      status: res.status,
      message: `Non-JSON response (HTTP ${res.status})`,
      code: "other",
    };
  }

  if (!res.ok) {
    const apiMessage = body.error?.message ?? `HTTP ${res.status}`;
    const code = classifyError(res.status, apiMessage);
    console.log(
      `[gemini] api-error model=${model} status=${res.status} code=${code} ` +
        `elapsedMs=${elapsedMs} message=${JSON.stringify(apiMessage)}`,
    );
    return { ok: false, status: res.status, message: apiMessage, code };
  }

  if (body.promptFeedback?.blockReason) {
    const reason = body.promptFeedback.blockReason;
    console.log(
      `[gemini] blocked model=${model} elapsedMs=${elapsedMs} reason=${reason}`,
    );
    return {
      ok: false,
      status: 502,
      message: `Blocked: ${reason}`,
      code: "blocked",
    };
  }

  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
  if (!text) {
    console.log(`[gemini] empty-response model=${model} elapsedMs=${elapsedMs}`);
    return {
      ok: false,
      status: 502,
      message: "Empty response from Gemini.",
      code: "other",
    };
  }

  console.log(`[gemini] ok model=${model} elapsedMs=${elapsedMs} bytes=${text.length}`);
  return { ok: true, text, modelUsed: model };
}
