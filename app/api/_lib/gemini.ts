// Default model used when callers do not specify one.
// Lightweight / general-purpose paths can stay on Flash for cost + latency.
// Recruiter-grade paths (profile summary, sales pitch) MUST pass model: "gemini-2.5-pro"
// because Pro materially improves grounded LinkedIn-style matching, education
// extraction, and previous-experience enrichment vs. Flash.
const DEFAULT_MODEL = "gemini-2.5-flash";

// Per-model fallback chains. The first entry is the requested model; subsequent
// entries are the cheaper / older models we'll try if the primary keeps failing
// in a transient way (overload, 5xx, rate limit). Order matters: never start
// below the requested tier, only degrade.
const FALLBACK_CHAINS: Record<string, string[]> = {
  "gemini-2.5-pro": ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-flash"],
  "gemini-2.5-flash": ["gemini-2.5-flash", "gemini-1.5-flash"],
  "gemini-1.5-flash": ["gemini-1.5-flash"],
};

const RETRY_DELAYS_MS = [2000, 5000, 10000];
const DEFAULT_MAX_OUTPUT_TOKENS = 800;

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
  // Optional override. Defaults to gemini-2.5-flash. Pass "gemini-2.5-pro"
  // for recruiter-grade enrichment paths (profile summary, sales pitch).
  model?: string;
  maxOutputTokens?: number;
};

export type GeminiErrorCode = "overloaded" | "blocked" | "other";

export type GeminiResult =
  | { ok: true; text: string; modelUsed: string; fallbackTriggered: boolean }
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

async function callModel(
  model: string,
  options: GeminiOptions,
  maxOutputTokens: number,
): Promise<Attempt> {
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
  const requestedModel = options.model ?? DEFAULT_MODEL;
  const chain = FALLBACK_CHAINS[requestedModel] ?? [requestedModel, DEFAULT_MODEL];
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const startedAt = Date.now();

  let last: Attempt = {
    ok: false,
    status: 0,
    message: "No attempt made",
    transient: true,
  };
  let totalRetries = 0;
  let blocked = false;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const isPrimary = i === 0;

    // Primary gets a retry budget for transient failures; fallbacks get a single
    // shot to keep latency bounded.
    const maxAttempts = isPrimary ? RETRY_DELAYS_MS.length + 1 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        totalRetries++;
        await delay(RETRY_DELAYS_MS[attempt - 1]);
      }
      const result = await callModel(model, options, maxOutputTokens);
      if (result.ok) {
        const elapsedMs = Date.now() - startedAt;
        const fallbackTriggered = !isPrimary;
        console.log(
          `[gemini] ok requested=${requestedModel} used=${model} ` +
            `fallback=${fallbackTriggered} retries=${totalRetries} elapsedMs=${elapsedMs}`,
        );
        return { ok: true, text: result.text, modelUsed: model, fallbackTriggered };
      }
      last = result;
      if (result.blocked) {
        blocked = true;
        break;
      }
      if (!result.transient) break;
    }

    // If the model was outright blocked (safety filter), don't try cheaper
    // models — they'll block the same content. Bail early.
    if (blocked) break;
  }

  const elapsedMs = Date.now() - startedAt;
  const lastErr = last.ok === false ? last : null;
  const lastWasTransient = lastErr?.transient ?? false;
  const code: GeminiErrorCode = blocked
    ? "blocked"
    : lastWasTransient
      ? "overloaded"
      : "other";

  console.log(
    `[gemini] fail requested=${requestedModel} chain=${chain.join(",")} ` +
      `retries=${totalRetries} elapsedMs=${elapsedMs} code=${code} ` +
      `message=${JSON.stringify(lastErr?.message ?? "unknown")}`,
  );

  return {
    ok: false,
    status: lastErr?.status || 502,
    message: lastErr?.message ?? "Unknown error",
    code,
  };
}
