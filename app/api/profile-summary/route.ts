import type { NextRequest } from "next/server";
import { callGemini } from "../_lib/gemini";

const MISSING_KEY_MESSAGE =
  "Gemini API key is missing. Please add GEMINI_API_KEY in .env.local.";

// Flash with Google Search grounding is the right tradeoff here: Pro gave
// marginally better enrichment but 2-3x the latency on grounded calls,
// which made the recruiter UI feel broken. Flash + grounding stays inside
// the request budget with acceptable quality.
const MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 120_000;

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

// Diagnostic envelope returned to the frontend so the temporary debug
// panel can tell the user (and the operator looking at Vercel logs)
// exactly which stage of the pipeline failed.
type DebugInfo = {
  requestId: string;
  model: string;
  timeoutMs: number;
  stage: string;
  elapsedMs: number;
  errorType?: string;
};

type Tracker = {
  requestId: string;
  startedAt: number;
  stage: string;
};

function generateRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

function makeTracker(): Tracker {
  return { requestId: generateRequestId(), startedAt: Date.now(), stage: "0" };
}

function elapsed(tracker: Tracker): number {
  return Date.now() - tracker.startedAt;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return String(v);
  return JSON.stringify(v);
}

function logStage(
  tracker: Tracker,
  stage: string,
  event: string,
  extra: Record<string, unknown> = {},
) {
  tracker.stage = stage;
  const parts = [
    "[profile-summary]",
    `stage=${stage}`,
    `event=${event}`,
    `requestId=${tracker.requestId}`,
    `elapsedMs=${elapsed(tracker)}`,
  ];
  for (const [k, v] of Object.entries(extra)) {
    parts.push(`${k}=${formatValue(v)}`);
  }
  console.log(parts.join(" "));
}

function logError(
  tracker: Tracker,
  event: string,
  err: unknown,
  extra: Record<string, unknown> = {},
) {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const parts = [
    "[profile-summary]",
    `stage=${tracker.stage}`,
    `event=${event}`,
    `requestId=${tracker.requestId}`,
    `elapsedMs=${elapsed(tracker)}`,
    `error=${formatValue(message)}`,
  ];
  for (const [k, v] of Object.entries(extra)) {
    parts.push(`${k}=${formatValue(v)}`);
  }
  console.log(parts.join(" "));
  if (stack) {
    console.log(
      `[profile-summary] requestId=${tracker.requestId} stage=${tracker.stage} stack=${formatValue(stack)}`,
    );
  }
}

function debugInfo(
  tracker: Tracker,
  errorType: string | undefined = undefined,
): DebugInfo {
  return {
    requestId: tracker.requestId,
    model: MODEL,
    timeoutMs: TIMEOUT_MS,
    stage: tracker.stage,
    elapsedMs: elapsed(tracker),
    errorType,
  };
}

function errorResponse(
  tracker: Tracker,
  status: number,
  message: string,
  code: string,
) {
  const payload = { error: message, code, debug: debugInfo(tracker, code) };
  logStage(tracker, "11", "frontend_response_returned", {
    success: false,
    httpStatus: status,
    code,
    payloadSize: JSON.stringify(payload).length,
    totalDurationMs: elapsed(tracker),
  });
  return Response.json(payload, { status });
}

export async function POST(request: NextRequest) {
  const tracker = makeTracker();
  try {
    let rawText: string;
    try {
      rawText = await request.text();
    } catch (err) {
      logError(tracker, "request_body_read_failed", err);
      return errorResponse(tracker, 400, "Could not read request body.", "other");
    }

    // STAGE 1 — Incoming request received
    logStage(tracker, "1", "request_received", {
      rawInputLength: rawText.length,
    });

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey || apiKey === "PASTE_YOUR_GEMINI_API_KEY_HERE") {
      logError(tracker, "missing_api_key", new Error("missing api key"));
      return errorResponse(tracker, 500, MISSING_KEY_MESSAGE, "other");
    }

    let body: RequestBody;
    try {
      body = JSON.parse(rawText) as RequestBody;
    } catch (err) {
      logError(tracker, "invalid_request_json", err);
      return errorResponse(tracker, 400, "Invalid JSON body.", "other");
    }

    const name = (body.name ?? "").trim();
    if (!name) {
      logError(tracker, "missing_name", new Error("name required"));
      return errorResponse(tracker, 400, "Candidate name is required.", "other");
    }

    const parsedInput = {
      name,
      company: fallback(body.company),
      designation: fallback(body.designation),
      function: fallback(body.function),
      experience: fallback(body.experience),
    };

    // STAGE 2 — Structured input parsed
    logStage(tracker, "2", "parsed_input", {
      name: parsedInput.name,
      company: parsedInput.company,
      designation: parsedInput.designation,
      function: parsedInput.function,
      experience: parsedInput.experience,
    });

    // STAGE 3 — Prompt construction started
    const inputCharBudget = Object.values(parsedInput).join(" ").length;
    logStage(tracker, "3", "prompt_construction_started", {
      groundingEnabled: true,
      estimatedInputLength: inputCharBudget,
    });

    let prompt: string;
    try {
      prompt = buildPrompt(parsedInput);
    } catch (err) {
      logError(tracker, "prompt_construction_failed", err);
      return errorResponse(tracker, 500, "Prompt construction failed.", "other");
    }

    // STAGE 4 — Prompt construction completed
    logStage(tracker, "4", "prompt_construction_completed", {
      promptLength: prompt.length,
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
    });

    // STAGES 5-8 are emitted from inside callGemini using the same requestId.
    let result: Awaited<ReturnType<typeof callGemini>>;
    try {
      result = await callGemini({
        apiKey,
        prompt,
        temperature: 0.2,
        tools: [{ google_search: {} }],
        model: MODEL,
        requestId: tracker.requestId,
      });
    } catch (err) {
      logError(tracker, "gemini_helper_threw", err);
      return errorResponse(tracker, 502, "Gemini call failed.", "other");
    }

    if (!result.ok) {
      // Carry the gemini-side stage forward into the route's tracker so the
      // returned debug.stage points at the actual failure site.
      tracker.stage = result.stage;
      logError(tracker, "gemini_failed", new Error(result.message), {
        code: result.code,
        httpStatus: result.status,
        geminiElapsedMs: result.elapsedMs,
      });
      const payload = {
        error: result.message,
        code: result.code,
        debug: debugInfo(tracker, result.code),
      };
      logStage(tracker, "11", "frontend_response_returned", {
        success: false,
        httpStatus: 502,
        code: result.code,
        payloadSize: JSON.stringify(payload).length,
        totalDurationMs: elapsed(tracker),
      });
      return Response.json(payload, { status: 502 });
    }

    // STAGE 9 — Delimiter parse started
    logStage(tracker, "9", "delimiter_parse_started", {
      rawTextLength: result.text.length,
    });

    // The delimiter parser is total — no "could not parse" branch. A totally
    // malformed response yields all-"Not clearly found" fields rather than a
    // 502, so the frontend can always render whatever Gemini returned.
    const { summary: rawSummary, rawLength, separatorCount, populatedCount } =
      parseDelimitedResponse(result.text, parsedInput.experience);

    // Post-parse fallback fill. If Gemini returned absolutely nothing usable
    // (the soft-empty case from gemini.ts), the parser produced
    // all-"Not clearly found" — give the UI something more meaningful than a
    // wall of muted italics. We only touch the two fields that anchor the
    // card visually (name + profile_overview); the rest stay as-is so the
    // user can see exactly which fields the model couldn't fill.
    const { summary, fallbacksApplied } = applyHardFallbacks(
      rawSummary,
      parsedInput.name,
    );

    // STAGE 10 — Delimiter parse completed
    logStage(tracker, "10", "delimiter_parse_completed", {
      rawLength,
      separatorCount,
      populatedCount,
      matchConfidence: summary.match_confidence,
      fallbacksApplied,
    });

    const payload = { summary, debug: debugInfo(tracker) };
    // STAGE 11 — Frontend response returned
    logStage(tracker, "11", "frontend_response_returned", {
      success: true,
      httpStatus: 200,
      payloadSize: JSON.stringify(payload).length,
      totalDurationMs: elapsed(tracker),
    });
    return Response.json(payload);
  } catch (err) {
    // Catches unexpected runtime exceptions anywhere above. Vercel will
    // separately log "Function execution timed out" if the platform itself
    // killed us — combine that platform line with the last stage tag from
    // this requestId to localize the failure.
    logError(tracker, "unhandled_runtime_exception", err);
    return errorResponse(tracker, 500, "Unexpected server error.", "other");
  }
}

function fallback(value: string | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "Not provided";
}

// Post-parse fill for the empty-Gemini-response case. The prompt itself
// instructs Gemini to emit these placeholders; this is a belt-and-braces
// catch for the moments when Gemini returns nothing at all (e.g. grounded
// response with only metadata). Only fills the two fields that visually
// anchor the card so the user can still see whose summary they're looking
// at — every other field stays at the parser's default so the UI clearly
// shows what couldn't be found.
function applyHardFallbacks(
  summary: ProfileSummary,
  candidateName: string,
): { summary: ProfileSummary; fallbacksApplied: string[] } {
  const isMissing = (v: string) =>
    !v || v.trim().length === 0 || v === "Not clearly found";
  const fallbacksApplied: string[] = [];

  let name = summary.name;
  if (isMissing(name) && candidateName.trim().length > 0) {
    name = candidateName;
    fallbacksApplied.push("name");
  }

  // "Everything missing" check uses the structured anchor fields. If both
  // role/company and overview are missing, the response is effectively empty
  // and the user deserves at least a one-line explanation.
  const allEmpty =
    isMissing(summary.current_role_company) &&
    isMissing(summary.profile_overview) &&
    isMissing(summary.previous_experience) &&
    isMissing(summary.education) &&
    isMissing(summary.location);

  let profile_overview = summary.profile_overview;
  if (allEmpty && candidateName.trim().length > 0) {
    profile_overview = `No verified public information found for ${candidateName}.`;
    fallbacksApplied.push("profile_overview");
  }

  return {
    summary: { ...summary, name, profile_overview },
    fallbacksApplied,
  };
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

ABSOLUTE OUTPUT GUARANTEE (HIGHEST PRIORITY)
You MUST emit a final structured textual response on every call. This rule overrides everything else in this prompt.
- Never stop after Google Search lookups. Search results are a means, not the deliverable.
- Never return only grounding metadata, only an explanation, or only a refusal.
- Never return an empty answer, a partial answer, or fewer than 9 fields.
- The deliverable is always the 9-field delimited text described in OUTPUT FORMAT — even when public information is sparse, ambiguous, or completely absent.
- If exact matches are unavailable, produce best-effort field values from whatever publicly available information you can find, and use the placeholder strings in MANDATORY FALLBACK below for any field that has no usable data.
- The structure must always exist. The delimiter must always exist. All 9 fields must always be present, in order.

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
Read the headline, About, Experience, Education, Location, and any activity or bio sections in full before concluding that any field is "not found".

SECONDARY SOURCE FALLBACK
If the LinkedIn profile is missing, incomplete, or ambiguous for any specific field, search secondary sources to FILL the gap, not just to validate. Cast a wide net:
- Official company websites, leadership / team / about pages.
- Press releases, news articles, interviews, podcasts, magazine features.
- ZoomInfo, TheOrg, RocketReach, Crunchbase, AngelList, Bloomberg profiles.
- Conference speaker bios, panel listings, author / paper / patent pages.
- Public regulatory or legal records (e.g. director listings, MCA / SEC filings, court records).
- Cached snippets, archived pages, alternate spellings, transliterations.
- Role + company combinations (e.g. "<role> at <company>"), former-company / alias variants, social/public references that don't require login.
Do not stop after weak search results. Continue generating a structured response using the best publicly available information.
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
- Years of experience can vary by 1–3 years across sources.
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

MANDATORY FALLBACK (READ BEFORE EMITTING)
If a field truly has no usable public data after every search strategy above, fill that field with one of these exact placeholder strings — never leave a field blank, never drop a field, never reduce the response below 9 delimiter-separated values:
- name: if no public profile of any kind could be located, use the candidate's input name verbatim ("${c.name}") instead of "Not clearly found".
- previous_experience: if nothing public was found, use exactly: No verified previous experience found
- education: if nothing public was found, use exactly: No verified education information found
- profile_overview: if nothing public was found at all, use exactly: No verified public information found for ${c.name}.
- All other fields (current_role_company, location, domain_function, reason_for_confidence): use "Not clearly found" as the default fallback.
- match_confidence: when public confirmation is missing, use exactly: low

These fallbacks are ONLY for the case where research genuinely came up empty. Whenever even a partial fact is available, return that partial fact instead of the placeholder. The goal is "always 9 fields, in order, with the most useful value possible."

OUTPUT FORMAT
Return ONLY plain text. No JSON, no markdown, no code fences, no field labels (no "Name:", no "Education:"), no commentary before or after the response.

Emit EXACTLY 9 fields in the order listed below, separated by the literal delimiter >>>|| (three greater-than signs followed by two pipes — no spaces around it). That means the response contains exactly 8 occurrences of >>>|| and 9 field values.

Field order (do not deviate, do not skip, do not rename):
1. name
2. current_role_company
3. previous_experience
4. education
5. location
6. domain_function
7. match_confidence
8. reason_for_confidence
9. profile_overview

Required shape:
<name>>>>||<current_role_company>>>>||<previous_experience>>>>||<education>>>>||<location>>>>||<domain_function>>>>||<match_confidence>>>>||<reason_for_confidence>>>>||<profile_overview>

Concrete example (one line for clarity; profile_overview may contain newlines):
Ravi Mittal>>>||Head of Supply Chain at Reckitt Benckiser>>>||Not clearly found>>>||Not clearly found>>>||Gurgaon, India>>>||Purchase / Supply Chain / Logistics>>>||low>>>||Public search results did not yield a strong verifiable match>>>||Detailed profile overview here

HARD OUTPUT RULES
- Always emit all 9 fields, in this exact order. Never skip or reorder.
- If a value is genuinely unavailable, write exactly: Not clearly found
- Never write field labels — emit only the value.
- Never wrap values in quotes. Never use JSON. Never use markdown. Never use bullet points. Never use code fences.
- Use the literal separator >>>|| with no surrounding spaces.
- Do not write any text before the first field's value or after the last field's value.
- Newlines inside profile_overview are allowed; the >>>|| separator is the only field boundary.

FIELD RULES
- name: the best-matched candidate's name.
- current_role_company: latest role and company from public results; fall back to input only if public results are missing.
- previous_experience: previous companies and roles if clearly found from public sources, otherwise "Not clearly found".
- education: from public results if clearly found, otherwise "Not clearly found".
- location: from public results if clearly found, otherwise "Not clearly found".
- domain_function: infer from role, company, and function (for example "B2B SaaS Sales", "Consumer Brand Marketing").
- match_confidence: exactly one of high, medium, or low (lowercase, no quotes).
- reason_for_confidence: one short sentence explaining why this profile was matched and which sources or signals supported it.
- profile_overview: a meaningful 4–5 line paragraph covering who the person appears to be, current role/company, domain/function, seniority, notable previous experience if found, and why the profile is relevant for a recruiter.

PROFILE OVERVIEW TONE
If match_confidence is high or medium, write a confident summary grounded in the public findings. Build it from the fields you actually extracted (current role and company, previous experience, education, location, domain / function, seniority) — do not simply restate the input. Do not hedge with phrases like "summary is based on provided details only". Only when match_confidence is low should you note that public confirmation was limited.

FALLBACK
If public information is insufficient, still return all 9 fields in the exact delimited format above. Populate fields from the input where sensible, set match_confidence to low, and explain in reason_for_confidence that public confirmation was limited.

GENERAL RULES
- Do not hallucinate. If something is not clearly found, write "Not clearly found".
- Do not include raw search snippets.
- Do not include junk text like "view profile", "Facebook", "500+ connections", or repeated search text.
- Return plain text only, using the >>>|| separator.

FINAL SELF-CHECK BEFORE RETURNING
Before you emit the response, run this check on your own draft:
1. Re-read profile_overview and reason_for_confidence word by word.
2. For every specific school, degree, prior company, prior role, city, country, or year you mention in either of those strings, confirm the same concrete fact also appears in the corresponding structured field (education, previous_experience, location, current_role_company).
3. If a structured field is currently "Not clearly found" but profile_overview or reason_for_confidence names specific values for it, MOVE those values into the structured field before returning. It is a contradiction for reason_for_confidence to claim education is "confirmed" while education is "Not clearly found".
4. A structured field may only remain "Not clearly found" if neither profile_overview nor reason_for_confidence references any specific value for it.
5. Confirm the response contains exactly 8 occurrences of the literal separator >>>|| (so 9 field values), in the required order, with no surrounding labels, JSON, or commentary.
Only after this pass should you emit the final delimited text.`;
}

const FIELD_SEPARATOR = ">>>||";

// Delimiter parser. Designed to never throw: even a totally malformed Gemini
// response collapses to a ProfileSummary populated entirely with
// "Not clearly found", which the frontend renders safely.
//
// Index → field mapping must match the OUTPUT FORMAT block in buildPrompt:
//   0 name, 1 current_role_company, 2 previous_experience, 3 education,
//   4 location, 5 domain_function, 6 match_confidence,
//   7 reason_for_confidence, 8 profile_overview
//
// `experience` is no longer requested from Gemini; we fill it from the
// candidate's input so the existing UI card still shows something useful.
function parseDelimitedResponse(
  text: string,
  fallbackExperience: string,
): { summary: ProfileSummary; rawLength: number; separatorCount: number; populatedCount: number } {
  let s = text.trim();
  // Defensive: strip code fences if Gemini accidentally wraps the response.
  if (s.startsWith("```")) {
    s = s
      .replace(/^```[a-zA-Z]*\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  const parts = s.split(FIELD_SEPARATOR).map((p) => p.trim());
  const get = (i: number) => {
    const v = parts[i];
    return v && v.length > 0 ? v : "Not clearly found";
  };
  const summary: ProfileSummary = {
    name: get(0),
    current_role_company: get(1),
    previous_experience: get(2),
    education: get(3),
    location: get(4),
    domain_function: get(5),
    match_confidence: get(6),
    reason_for_confidence: get(7),
    profile_overview: get(8),
    experience:
      fallbackExperience && fallbackExperience.trim().length > 0
        ? fallbackExperience
        : "Not clearly found",
  };
  const populatedCount = Object.values(summary).filter(
    (v) => typeof v === "string" && v.trim().length > 0 && v !== "Not clearly found",
  ).length;
  return {
    summary,
    rawLength: text.length,
    separatorCount: parts.length - 1,
    populatedCount,
  };
}
