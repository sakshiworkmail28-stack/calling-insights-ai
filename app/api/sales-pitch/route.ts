import type { NextRequest } from "next/server";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MISSING_KEY_MESSAGE =
  "Gemini API key is missing. Please add GEMINI_API_KEY in .env.local.";

type ParsedInput = {
  name?: string;
  company?: string;
  designation?: string;
  function?: string;
  experience?: string;
};

type ProfileSummary = {
  name?: string;
  current_role_company?: string;
  previous_experience?: string;
  experience?: string;
  education?: string;
  location?: string;
  domain_function?: string;
  match_confidence?: string;
  reason_for_confidence?: string;
  profile_overview?: string;
};

type RequestBody = {
  parsedInput?: ParsedInput;
  profileSummary?: ProfileSummary;
};

type PitchCore = {
  context: string;
  insights: string;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === "PASTE_YOUR_GEMINI_API_KEY_HERE") {
    return Response.json({ error: MISSING_KEY_MESSAGE }, { status: 500 });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = body.parsedInput ?? {};
  const summary = body.profileSummary ?? {};

  const name = (input.name ?? summary.name ?? "").trim();
  if (!name) {
    return Response.json(
      { error: "Candidate name is required." },
      { status: 400 },
    );
  }

  const prompt = buildPrompt({ input, summary });

  let geminiRes: Response;
  try {
    geminiRes = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 },
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown network error";
    return Response.json(
      { error: `Failed to reach Gemini API: ${message}` },
      { status: 502 },
    );
  }

  const rawText = await geminiRes.text();
  let data: GeminiResponse;
  try {
    data = JSON.parse(rawText) as GeminiResponse;
  } catch {
    return Response.json(
      {
        error: `Gemini API returned a non-JSON response (${geminiRes.status}).`,
      },
      { status: 502 },
    );
  }

  if (!geminiRes.ok) {
    const apiMessage = data?.error?.message ?? `HTTP ${geminiRes.status}`;
    return Response.json(
      { error: `Gemini API error: ${apiMessage}` },
      { status: 502 },
    );
  }

  if (data.promptFeedback?.blockReason) {
    return Response.json(
      {
        error: `Gemini blocked the request: ${data.promptFeedback.blockReason}`,
      },
      { status: 502 },
    );
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("")
    .trim();

  if (!text) {
    return Response.json(
      { error: "Gemini returned no text. Please try again." },
      { status: 502 },
    );
  }

  const pitch = parsePitchJson(text);
  if (!pitch) {
    return Response.json(
      { error: "Could not parse Gemini response as JSON." },
      { status: 502 },
    );
  }

  return Response.json({ pitch });
}

function safe(value?: string) {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "Not provided";
}

function buildPrompt({
  input,
  summary,
}: {
  input: ParsedInput;
  summary: ProfileSummary;
}) {
  const confidence = (summary.match_confidence ?? "").toLowerCase().trim();

  return `You write crisp, recruiter-friendly calling lines for a phone caller at iimjobs. Output ONLY JSON.

INPUT (what the caller typed in)
Name: ${safe(input.name)}
Company: ${safe(input.company)}
Designation: ${safe(input.designation)}
Function: ${safe(input.function)}
Experience: ${safe(input.experience)}

PROFILE SUMMARY (already generated from public web; prefer this over INPUT when they contradict)
Name: ${safe(summary.name)}
Current Role & Company: ${safe(summary.current_role_company)}
Previous Experience: ${safe(summary.previous_experience)}
Experience (years): ${safe(summary.experience)}
Education: ${safe(summary.education)}
Location: ${safe(summary.location)}
Domain / Function: ${safe(summary.domain_function)}
Match Confidence: ${safe(summary.match_confidence)}
Reason for Confidence: ${safe(summary.reason_for_confidence)}
Profile Overview: ${safe(summary.profile_overview)}

YOUR TASK
Produce two short, recruiter-friendly lines that a caller can skim live during a phone call:

1. "context" — 2 to 3 short sentences. Reference the most useful details from the Profile Summary: current role and company, domain / function, years of experience, and — only if genuinely useful on a call — a standout previous company, education, or location. Sound natural, like a recruiter who just reviewed the profile. Never generic, never long.

2. "insights" — 1 to 2 short sentences explaining why this profile is valuable right now. Connect the role / domain / seniority to current recruiter demand. Not generic.

CONFIDENCE HANDLING
The match_confidence is "${confidence || "unknown"}".
- If it is "high" or "medium", speak with confidence: "your current role as ...", "your experience in ...".
- If it is "low" or empty, soften: "your profile indicates ...", "you appear to be associated with ...". Do not assert low-confidence facts as confirmed.

BOLDING
Wrap the most important phrases in Markdown bold using double asterisks (**like this**). Bold things like:
- designation and company (e.g. **Chief Business Officer**, **Naukri / Info Edge**)
- years of experience (e.g. **18 years**)
- domain / function (e.g. **B2C marketing**, **business leadership**)
- a standout previous company if you reference it
- leadership or seniority signals (e.g. **growth ownership**, **market expansion**)
Do not bold filler words. Do not use any other Markdown — no headings, lists, links, or italics.

RULES
- Do NOT hallucinate. If a fact is "Not provided" or "Not clearly found", omit it rather than inventing.
- Do NOT exceed the sentence limits above.
- Do NOT output anything outside the JSON object.
- Do NOT include code fences or commentary.

OUTPUT FORMAT (exact shape, JSON only)
{
  "context": "",
  "insights": ""
}`;
}

function parsePitchJson(text: string): PitchCore | null {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = s.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  const context = typeof obj.context === "string" ? obj.context.trim() : "";
  const insights = typeof obj.insights === "string" ? obj.insights.trim() : "";
  if (!context && !insights) return null;
  return { context, insights };
}
