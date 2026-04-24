import type { NextRequest } from "next/server";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MISSING_KEY_MESSAGE =
  "Gemini API key is missing. Please add GEMINI_API_KEY in .env.local.";

type RequestBody = {
  name?: string;
  company?: string;
  designation?: string;
  function?: string;
  experience?: string;
};

type ProfileSummary = {
  name: string;
  current_role_company: string;
  previous_experience: string;
  experience: string;
  education: string;
  location: string;
  domain_function: string;
  match_confidence: string;
  reason_for_confidence: string;
  profile_overview: string;
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

  const name = (body.name ?? "").trim();
  if (!name) {
    return Response.json(
      { error: "Candidate name is required." },
      { status: 400 },
    );
  }

  const prompt = buildPrompt({
    name,
    company: fallback(body.company),
    designation: fallback(body.designation),
    function: fallback(body.function),
    experience: fallback(body.experience),
  });

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
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
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

  const summary = parseJsonFromText(text);
  if (!summary) {
    return Response.json(
      { error: "Could not parse Gemini response as JSON." },
      { status: 502 },
    );
  }

  return Response.json({ summary });
}

function fallback(value: string | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "Not provided";
}

function buildPrompt(c: {
  name: string;
  company: string;
  designation: string;
  function: string;
  experience: string;
}) {
  return `You are an expert recruiter research assistant with access to Google Search grounding.

Your job is to find the closest public profile match for the candidate described below and return a clean, structured summary. Treat the input as search guidance, not as ground truth.

Candidate details:
Name: ${c.name}
Company: ${c.company}
Designation: ${c.designation}
Function: ${c.function}
Experience: ${c.experience}

SEARCH STRATEGY
Do not stop after the first query. Actively search using multiple combinations, including at least:
- "${c.name}" "${c.company}"
- "${c.name}" "${c.designation}"
- "${c.name}" "${c.function}"
- "${c.name}" "${c.company}" LinkedIn
- "${c.name}" "${c.designation}" LinkedIn
- "${c.name}" "${c.company}" "${c.designation}"
- "${c.name}" with likely aliases or former names of the company if visible in results.

Do not stop after checking exact input terms. Search for close variants of the role and company. If the input says "Head of Commerce at Google" but public results show "Head of SMB Growth at Google" for the same person, treat it as a likely match and summarize that public role.

LINKEDIN-FIRST EXTRACTION
LinkedIn is the PRIMARY source of structured truth. Before summarizing, identify the most likely LinkedIn profile for "${c.name}" and extract EVERY field below from it — not just role and company:
- Current role and company (headline plus the latest Experience entry).
- Previous experience (every prior company and role visible in the Experience section).
- Education (degree and institution from the Education section; include partial information such as just the institution if the degree is not visible).
- Location (city, metro, or region from the location line).
- Domain / function.
- Total experience in years (derive from the Experience history if a number is not stated).
Read the headline, About, Experience, Education, Location, and any activity or bio sections in full before concluding that any field is "not found".

SECONDARY SOURCE FALLBACK
If the LinkedIn profile is missing, incomplete, or ambiguous for any specific field, search secondary sources to FILL the gap, not just to validate:
- Official company websites, leadership / team / about pages.
- Press releases, news articles, interviews, and podcasts.
- ZoomInfo, TheOrg, RocketReach.
- Conference speaker bios, panel listings, author pages.
Every field that is still blank after LinkedIn must be attempted against at least one secondary source before giving up.

EXTRACTION DEPTH
Do not stop after the first useful search result. Keep extracting until:
- You have attempted every field in the output schema, AND
- You have checked LinkedIn plus at least one other credible source for any fields still blank.

PARTIAL DATA OVER EMPTY
Return partial information rather than discarding it. Examples of acceptable partial values:
- education: "MBA, IIM Lucknow" · "Delhi University" · "IIT (degree not visible)"
- previous_experience: "Worked at McKinsey" · "Previously at Flipkart and Amazon (roles not fully visible)"
- location: "India" if only the country is visible
Do not throw away a partial fact just because it is incomplete.

FULL DETAIL EXTRACTION WHEN AVAILABLE
Partial information is a floor, not a ceiling. Whenever detailed structured data is visible in public sources — LinkedIn first, then official company / leadership pages, then news / interviews, then professional databases (ZoomInfo, TheOrg, RocketReach) — extract it in full. Never collapse rich details into a short generic phrase.

Apply this per field:
- current_role_company: include the exact designation, the company, and any business unit, product area, or regional qualifier when visible. Example: "Head of SMB Growth (Americas) — Google". Do not shorten when a qualifier is visible.
- previous_experience: for every prior role that is visible, extract company, role, and duration / years where available, plus a short context line if the profile describes the work. Return a list of specific entries, not one generic phrase. Examples:
    · "Consultant at McKinsey (2006–2009), Oil & Gas strategy"
    · "Manager — PepsiCo India, led commerce initiatives"
  Avoid vague phrasing like "Worked at Big 4s" or "Previously at multiple companies" when specific entries are visible.
- education: for every education entry visible, extract degree, institution, field or specialization, and start / end years when available. Return each entry as a specific line, not a single word. Examples:
    · "MBA, Oil & Gas Management — University of Petroleum (2004–2006)"
    · "BA Economics — Delhi University (2001–2004)"
  Include every detail the profile shows. Do not truncate to just the degree or just the institution when more is present.
- location: return "City, Country" when both are visible; fall back to country alone only if the city is not visible.
- experience: use the explicit number of years stated on the profile when available; otherwise derive it from the earliest to the latest visible Experience entry.

NO REGRESSION RULE
Do not reduce data quality. If detailed structured data is available, always return the detailed form rather than a simplified summary. Never collapse multiple concrete facts (several degrees, multiple prior roles, distinct business units) into one vague sentence.

STRUCTURED FIELDS ARE AUTHORITATIVE
Any concrete fact you know about the candidate (schools, degrees, prior companies, prior roles, years, city) MUST be placed in the matching structured field — not only mentioned inside profile_overview. If you are about to write a school, prior employer, or location inside profile_overview, you must also populate education / previous_experience / location with the specific values. profile_overview is a narrative layer on top of the structured fields, never a replacement for them.

OVERVIEW MIRRORS STRUCTURED FIELDS (HARD RULE)
profile_overview and reason_for_confidence may ONLY reference facts that are already present, verbatim or as a clear paraphrase, in the structured fields. This means:
- If you want to name a school in the overview, put that school in education first.
- If you want to name a prior company in the overview, put that company in previous_experience first.
- If you want to name a city, state, or country in the overview, put it in location first.
- If you want to claim in reason_for_confidence that education is "confirmed", education must not be "Not clearly found".
It is a hard contradiction — and an output you must not emit — for profile_overview or reason_for_confidence to contain a specific fact that the corresponding structured field omits. Treat this as more important than brevity or natural prose: either drop the detail from the narrative, or populate the structured field. Do not do both.

"NOT CLEARLY FOUND" GUARD
Only write "Not clearly found" for a field when BOTH of the following are true:
1. The LinkedIn profile does not contain the data, or no LinkedIn profile was identifiable.
2. At least one secondary source was also checked and did not contain the data.
If any source has even partial data, return that partial value instead.

FUZZY MATCHING RULES
Allow small variations when deciding if a result describes the same person:
- Role variants, for example: Head of Commerce ≈ Head of SMB Growth / Business Head / Growth Head / Commerce Lead. Marketing ≈ Brand / Growth / Performance / B2C Marketing. Sales ≈ Revenue / GTM / Business Development / Commercial. Product ≈ Product Strategy / Product Lead / Product Manager.
- Company variants, for example: Naukri ≈ Info Edge ≈ Naukri.com. Google ≈ Google India ≈ Google LLC. Deutsche Telekom ≈ Deutsche Telekom Digital Labs.
- Experience can vary by 1–3 years.
- Location may vary within the same region.

SOURCE PRIORITY
Prefer these sources, in order: LinkedIn profiles, official company pages / leadership pages / press releases, news articles and interviews, The Org, ZoomInfo, RocketReach, then other credible business or profile pages.

Do not rely on: Facebook, Instagram, Twitter/X bios, generic people-search aggregators, duplicate profile listings, or profiles of unrelated people who only share the same name.

DO NOT BLINDLY TRUST INPUT
Input fields are fallback only. If public results show a clearly correct current role or company for the same person that differs from the input, use the public result.

MATCH CONFIDENCE
Pick the closest matching person from credible public sources and assign:
- "high": name matches and either company or role (or both) clearly match, from a credible source.
- "medium": name matches and either company or role is a close variant, but not both exact.
- "low": only the name matches, results are ambiguous, or no credible public confirmation was found.

OUTPUT FORMAT
Return ONLY JSON. No prose, no code fences, no commentary. Use this exact shape:

{
  "name": "",
  "current_role_company": "",
  "previous_experience": "",
  "experience": "",
  "education": "",
  "location": "",
  "domain_function": "",
  "match_confidence": "",
  "reason_for_confidence": "",
  "profile_overview": ""
}

FIELD RULES
- name: the best-matched candidate's name.
- current_role_company: latest role and company from public results; fall back to input only if public results are missing.
- previous_experience: previous company and role if clearly found from public sources, otherwise "Not clearly found".
- experience: total years from public results if found; otherwise the input experience value.
- education: from public results if clearly found, otherwise "Not clearly found".
- location: from public results if clearly found, otherwise "Not clearly found".
- domain_function: infer from role, company, and function (for example "B2B SaaS Sales", "Consumer Brand Marketing").
- match_confidence: exactly "high", "medium", or "low".
- reason_for_confidence: one short sentence explaining why this profile was matched and which sources or signals supported it.
- profile_overview: a meaningful 4–5 line paragraph covering who the person appears to be, current role/company, domain/function, seniority, notable previous experience if found, and why the profile is relevant for a recruiter.

PROFILE OVERVIEW TONE
If match_confidence is "high" or "medium", write a confident summary grounded in the public findings. Build it from the fields you actually extracted (current role and company, previous experience, education, location, domain / function, seniority) — do not simply restate the input. Do not hedge with phrases like "summary is based on provided details only". Only when match_confidence is "low" should you note that public confirmation was limited.

FALLBACK
If public information is insufficient, still return the JSON object. Populate fields from the input where sensible, set match_confidence to "low", and explain in reason_for_confidence that public confirmation was limited.

GENERAL RULES
- Do not hallucinate. If something is not clearly found, write "Not clearly found".
- Do not include raw search snippets.
- Do not include junk text like "view profile", "Facebook", "500+ connections", or repeated search text.
- Return JSON only.

FINAL SELF-CHECK BEFORE RETURNING
Before you emit the JSON, run this check on your own draft:
1. Re-read profile_overview and reason_for_confidence word by word.
2. For every specific school, degree, prior company, prior role, city, country, or year you mention in either of those strings, confirm the same concrete fact also appears in the corresponding structured field (education, previous_experience, location, experience, current_role_company).
3. If a structured field is currently "Not clearly found" but profile_overview or reason_for_confidence names specific values for it, MOVE those values into the structured field before returning. It is a contradiction for reason_for_confidence to claim education is "confirmed" while education is "Not clearly found".
4. A structured field may only remain "Not clearly found" if neither profile_overview nor reason_for_confidence references any specific value for it.
Only after this pass should you emit the final JSON.`;
}

function parseJsonFromText(text: string): ProfileSummary | null {
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
  const keys: Array<keyof ProfileSummary> = [
    "name",
    "current_role_company",
    "previous_experience",
    "experience",
    "education",
    "location",
    "domain_function",
    "match_confidence",
    "reason_for_confidence",
    "profile_overview",
  ];
  const result = {} as ProfileSummary;
  for (const k of keys) {
    const v = obj[k];
    result[k] = typeof v === "string" ? v : "Not clearly found";
  }
  return result;
}
