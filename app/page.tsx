"use client";

import { useState, type ReactNode } from "react";

type Candidate = {
  name: string;
  company: string;
  designation: string;
  function: string;
  experience: string;
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

type PitchCore = {
  context: string;
  insights: string;
};

type Faq = { q: string; a: string };

const NOT_PROVIDED = "Not provided";

const PITCH_TITLE = "Calling Pitch – Reactivation (iimjobs profile update)";
const PITCH_SUBTITLE =
  "Premium users who haven't updated their profile in the last one year";
const YOUR_NAME_PLACEHOLDER = "<your name>";

const HOOK_TEXT = [
  "Based on your background, your profile falls into a high-demand segment on iimjobs.",
  "We've noticed your profile hasn't been updated recently. An updated profile gets significantly better visibility with recruiters & helps you see a more relevant job feed.",
  "I just wanted to quickly help you refresh a few key details, so you don't miss out on relevant leadership opportunities.",
  "It'll take under 2 minutes — shall we quickly update it now?",
].join("\n\n");

const PITCH_QUESTIONS = [
  "Are you currently actively exploring or just passively open to opportunities?",
  "What is your Current company? Designation?",
  "What's your current CTC? (If not sharing)",
  "Preferred job locations?",
  "Notice period?",
];

const FAQS: Faq[] = [
  {
    q: "What is iimjobs?",
    a: "iimjobs is a job platform focused on mid to senior-level professionals across domains like consulting, finance, marketing, product, HR, and other leadership roles. We connect professionals with top brands hiring for roles typically 20+ LPA and above.",
  },
  {
    q: "How did you get my details?",
    a: "You are a registered user on iimjobs. However, your profile has been dormant for a while. An updated profile gets significantly better visibility with recruiters & helps you see a more relevant job feed.",
  },
  {
    q: "Why are you calling me?",
    a: "We're helping iimjobs users ensure their profiles are up to date. An updated profile gets significantly better visibility with recruiters & helps you see a more relevant job feed.",
  },
  {
    q: "Is this a sales call?",
    a: "Not at all. There's no paid service involved here. This is purely to help improve your profile visibility on iimjobs.",
  },
  {
    q: "I'm not actively looking.",
    a: "That's completely fine. Many professionals stay passively open. We can mark your status accordingly — it just ensures you don't miss a strong opportunity unexpectedly.",
  },
  {
    q: "I haven't received relevant calls.",
    a: "That usually happens when key details like CTC, notice period, or job preference are outdated. Recruiters filter very specifically — even small gaps reduce visibility. Let's fix that quickly.",
  },
  {
    q: "Can't I update this myself?",
    a: "Absolutely. You can log in anytime. Since we're already speaking, we can take care of the core details in under 2 minutes. You will get an email confirmation after it.",
  },
  {
    q: "What are the relevant roles for me?",
    a: "We have active openings across domains like consulting, finance, marketing, product, HR, and other leadership roles. You will be able to see the most suitable open roles once you update your details. Logging into iimjobs will then give you the latest roles.",
  },
];

function buildOpening(name: string) {
  return [
    `Hello, good morning/afternoon. Am I speaking with ${name}?`,
    `Hi ${name}, this is ${YOUR_NAME_PLACEHOLDER} calling from iimjobs.\nI'm part of the Career Advisory team.`,
    "Is this a good time for a quick 2-minute conversation?",
  ].join("\n\n");
}

function buildClosing(name: string) {
  return [
    "Perfect — that's all I need.",
    "Your profile will now reflect the latest information, and you'll receive a confirmation email shortly.",
    "This will help improve your visibility to recruiters hiring for roles aligned with your experience.",
    `Thanks for your time, ${name} — wishing you the very best for your next career move!`,
  ].join("\n\n");
}

export default function Home() {
  const [rawInput, setRawInput] = useState("");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [summary, setSummary] = useState<ProfileSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [pitch, setPitch] = useState<PitchCore | null>(null);
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchError, setPitchError] = useState<string | null>(null);

  function resetDownstream() {
    setSummary(null);
    setSummaryError(null);
    setPitch(null);
    setPitchError(null);
  }

  function handleStructure() {
    const parts = rawInput.split("|").map((s) => s.trim());
    const [name = "", company = "", designation = "", fn = "", experience = ""] =
      parts;

    resetDownstream();

    if (!name) {
      setParseError("Candidate name is required.");
      setCandidate(null);
      return;
    }

    setParseError(null);
    setCandidate({
      name,
      company: company || NOT_PROVIDED,
      designation: designation || NOT_PROVIDED,
      function: fn || NOT_PROVIDED,
      experience: experience || NOT_PROVIDED,
    });
  }

  async function handleGenerateSummary() {
    if (!candidate) return;
    setSummaryLoading(true);
    setSummaryError(null);
    setSummary(null);
    setPitch(null);
    setPitchError(null);
    try {
      const res = await fetch("/api/profile-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidate),
      });
      const data: { summary?: ProfileSummary; error?: string } = await res
        .json()
        .catch(() => ({ error: "Invalid server response." }));

      if (!res.ok || !data.summary) {
        setSummaryError(
          data.error ?? `Request failed with status ${res.status}.`,
        );
        return;
      }
      setSummary(data.summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      setSummaryError(`Failed to generate summary: ${message}`);
    } finally {
      setSummaryLoading(false);
    }
  }

  async function handleGeneratePitch() {
    if (!candidate || !summary) return;
    setPitchLoading(true);
    setPitchError(null);
    setPitch(null);
    try {
      const res = await fetch("/api/sales-pitch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parsedInput: candidate,
          profileSummary: summary,
        }),
      });
      const data: { pitch?: PitchCore; error?: string } = await res
        .json()
        .catch(() => ({ error: "Invalid server response." }));

      if (!res.ok || !data.pitch) {
        setPitchError(
          data.error ?? `Request failed with status ${res.status}.`,
        );
        return;
      }
      setPitch(data.pitch);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      setPitchError(`Failed to generate sales pitch: ${message}`);
    } finally {
      setPitchLoading(false);
    }
  }

  const candidateName = candidate?.name || summary?.name || "there";
  const openingText = buildOpening(candidateName);
  const closingText = buildClosing(candidateName);

  function buildFullPitchText(p: PitchCore) {
    const questionLines = PITCH_QUESTIONS.map((q) => `- ${q}`).join("\n");
    const faqLines = FAQS.map((f) => `${f.q}\n${f.a}`).join("\n\n");
    return [
      PITCH_TITLE,
      PITCH_SUBTITLE,
      "",
      "Opening:",
      openingText,
      "",
      "Context Setting (Why this call):",
      stripBold(p.context) || "—",
      "",
      "Insights:",
      stripBold(p.insights) || "—",
      "",
      "Hook:",
      HOOK_TEXT,
      "",
      "Quick Update Questions:",
      questionLines,
      "",
      "Closing:",
      closingText,
      "",
      "FAQs:",
      faqLines,
    ].join("\n");
  }

  return (
    <div className="flex min-h-screen flex-1 bg-zinc-50 px-4 py-12 text-zinc-900">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header>
          <h1 className="text-3xl font-semibold tracking-tight">
            Calling Insights AI
          </h1>
          <p className="mt-2 text-zinc-600">
            Paste candidate data, structure it, generate a public profile
            summary, then produce a ready-to-speak calling pitch.
          </p>
        </header>

        <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <label
            htmlFor="candidate-input"
            className="block text-sm font-medium text-zinc-800"
          >
            Paste Candidate Data
          </label>
          <textarea
            id="candidate-input"
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            placeholder={
              "Name | Company | Designation | Function | Experience\n" +
              "Example: Shail Gaurav | Naukri.com | Chief Business Officer | Marketing | 18"
            }
            rows={4}
            className="mt-2 w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          />
          {parseError && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {parseError}
            </p>
          )}
          <button
            type="button"
            onClick={handleStructure}
            className="mt-4 inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
          >
            Structure Data
          </button>
        </section>

        {candidate && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Structured Candidate Data</h2>
            <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name" value={candidate.name} />
              <Field label="Company" value={candidate.company} />
              <Field label="Designation" value={candidate.designation} />
              <Field label="Function" value={candidate.function} />
              <Field label="Experience" value={candidate.experience} />
            </dl>
            <button
              type="button"
              onClick={handleGenerateSummary}
              disabled={summaryLoading}
              className="mt-6 inline-flex items-center justify-center rounded-md border border-zinc-900 bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {summaryLoading
                ? "Generating profile summary..."
                : "Generate Profile Summary"}
            </button>
            {summaryLoading && (
              <p className="mt-3 text-sm text-zinc-500">
                Generating profile summary...
              </p>
            )}
            {summaryError && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {summaryError}
              </p>
            )}
          </section>
        )}

        {summary && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Profile Summary</h2>
            <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name" value={summary.name} />
              <Field
                label="Current Role & Company"
                value={summary.current_role_company}
              />
              <Field
                label="Previous Experience"
                value={summary.previous_experience}
              />
              <Field label="Experience" value={summary.experience} />
              <Field label="Education" value={summary.education} />
              <Field label="Location" value={summary.location} />
              <Field
                label="Domain / Function"
                value={summary.domain_function}
              />
              <Field
                label="Match Confidence"
                value={summary.match_confidence}
              />
            </dl>
            <div className="mt-6">
              <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Reason for Confidence
              </h3>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-zinc-800">
                {summary.reason_for_confidence || "Not clearly found"}
              </p>
            </div>
            <div className="mt-6">
              <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Profile Overview
              </h3>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-zinc-800">
                {summary.profile_overview}
              </p>
            </div>
            <button
              type="button"
              onClick={handleGeneratePitch}
              disabled={pitchLoading}
              className="mt-6 inline-flex items-center justify-center rounded-md border border-zinc-900 bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pitchLoading
                ? "Generating sales pitch..."
                : "Generate Sales Pitch"}
            </button>
            {pitchLoading && (
              <p className="mt-3 text-sm text-zinc-500">
                Generating sales pitch...
              </p>
            )}
            {pitchError && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {pitchError}
              </p>
            )}
          </section>
        )}

        {pitch && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{PITCH_TITLE}</h2>
                <p className="mt-1 text-sm text-zinc-600">{PITCH_SUBTITLE}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <CopyButton
                  label="Copy Context"
                  getText={() => stripBold(pitch.context)}
                />
                <CopyButton
                  label="Copy Insights"
                  getText={() => stripBold(pitch.insights)}
                />
                <CopyButton
                  label="Copy Full Pitch"
                  getText={() => buildFullPitchText(pitch)}
                  primary
                />
              </div>
            </div>

            <PitchBlock label="Opening">
              <span className="whitespace-pre-line">{openingText}</span>
            </PitchBlock>

            <PitchBlock label="Context Setting (Why this call)">
              {pitch.context ? (
                <RenderBold text={pitch.context} />
              ) : (
                <span className="italic text-zinc-400">Not generated</span>
              )}
            </PitchBlock>

            <PitchBlock label="Insights">
              {pitch.insights ? (
                <RenderBold text={pitch.insights} />
              ) : (
                <span className="italic text-zinc-400">Not generated</span>
              )}
            </PitchBlock>

            <PitchBlock label="Hook">
              <span className="whitespace-pre-line">{HOOK_TEXT}</span>
            </PitchBlock>

            <PitchBlock label="Quick Update Questions">
              <ul className="list-disc space-y-1 pl-5">
                {PITCH_QUESTIONS.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </PitchBlock>

            <PitchBlock label="Closing">
              <span className="whitespace-pre-line">{closingText}</span>
            </PitchBlock>

            <PitchBlock label="FAQs">
              <dl className="space-y-4">
                {FAQS.map((faq) => (
                  <div key={faq.q}>
                    <dt className="font-medium text-zinc-900">{faq.q}</dt>
                    <dd className="mt-1 text-zinc-700">{faq.a}</dd>
                  </div>
                ))}
              </dl>
            </PitchBlock>
          </section>
        )}

        <footer className="mt-auto pt-10 pb-4 text-center text-xs text-gray-400">
          IIMJobs (InfoEdge India Pvt. Ltd.) | Powered by Sakshi(Marketing) 😛
        </footer>
      </main>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const muted =
    value === "Not provided" ||
    value === "Not clearly found" ||
    value.trim() === "";
  return (
    <div className="flex flex-col rounded-md bg-zinc-50 px-3 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-sm ${muted ? "italic text-zinc-400" : "text-zinc-900"}`}
      >
        {value || "Not clearly found"}
      </dd>
    </div>
  );
}

function PitchBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-5 first-of-type:mt-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </h3>
      <div className="mt-1.5 text-sm leading-6 text-zinc-800">{children}</div>
    </div>
  );
}

function RenderBold({ text }: { text: string }) {
  const pattern = /\*\*(.+?)\*\*/g;
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let keyCounter = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(
        <span key={`t-${keyCounter++}`}>
          {text.slice(lastIdx, match.index)}
        </span>,
      );
    }
    parts.push(<strong key={`b-${keyCounter++}`}>{match[1]}</strong>);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(<span key={`t-${keyCounter++}`}>{text.slice(lastIdx)}</span>);
  }
  return <>{parts}</>;
}

function stripBold(text: string) {
  return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

function CopyButton({
  label,
  getText,
  primary = false,
}: {
  label: string;
  getText: () => string;
  primary?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    const text = getText();
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed";
  const styles = primary
    ? "bg-zinc-900 text-white hover:bg-zinc-800"
    : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100";
  return (
    <button type="button" onClick={onClick} className={`${base} ${styles}`}>
      {copied ? "Copied!" : label}
    </button>
  );
}
