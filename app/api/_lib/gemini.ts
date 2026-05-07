const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-1.5-flash";
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const MAX_OUTPUT_TOKENS = 800;

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
};

export type GeminiErrorCode = "overloaded" | "blocked" | "other";

export type GeminiResult =
  | { ok: true; text: string }
  | { ok: false; status: number; message: string; code: GeminiErrorCode };

type Attempt =
  | { ok: true; text: string }
  | { ok: false; status: number; message: string; transient: boolean; blocked?: boolean };

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isTransient(status: number, message: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const m = message.toLowerCase();
  return (
    m.includes("overload") ||
    m.includes("high demand") ||
    m.includes("unavailable") ||
    m.includes("rate limit") ||
    m.includes("quota") ||
    m.includes("timeout")
  );
}

async function callModel(model: string, options: GeminiOptions): Promise<Attempt> {
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
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown network error";
    return { ok: false, status: 0, message, transient: true };
  }

  const rawText = await res.text();
  let body: GeminiResponseBody;
  try {
    body = JSON.parse(rawText) as GeminiResponseBody;
  } catch {
    return {
      ok: false,
      status: res.status,
      message: `Non-JSON response (HTTP ${res.status})`,
      transient: !res.ok,
    };
  }

  if (!res.ok) {
    const apiMessage = body.error?.message ?? `HTTP ${res.status}`;
    return {
      ok: false,
      status: res.status,
      message: apiMessage,
      transient: isTransient(res.status, apiMessage),
    };
  }

  if (body.promptFeedback?.blockReason) {
    return {
      ok: false,
      status: 502,
      message: `Blocked: ${body.promptFeedback.blockReason}`,
      transient: false,
      blocked: true,
    };
  }

  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
  if (!text) {
    return { ok: false, status: 502, message: "Empty response", transient: true };
  }
  return { ok: true, text };
}

export async function callGemini(options: GeminiOptions): Promise<GeminiResult> {
  let last: Attempt = {
    ok: false,
    status: 0,
    message: "No attempt made",
    transient: true,
  };

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1]);
    }
    const result = await callModel(PRIMARY_MODEL, options);
    if (result.ok) return { ok: true, text: result.text };
    last = result;
    if (!result.transient) break;
  }

  if (last.ok === false && last.blocked) {
    return { ok: false, status: last.status, message: last.message, code: "blocked" };
  }

  const fallback = await callModel(FALLBACK_MODEL, options);
  if (fallback.ok) return { ok: true, text: fallback.text };

  const finalAttempt = fallback;
  const lastWasTransient = last.ok === false && last.transient;
  const code: GeminiErrorCode = finalAttempt.blocked
    ? "blocked"
    : finalAttempt.transient || lastWasTransient
      ? "overloaded"
      : "other";

  return {
    ok: false,
    status: finalAttempt.status || 502,
    message: finalAttempt.message,
    code,
  };
}
