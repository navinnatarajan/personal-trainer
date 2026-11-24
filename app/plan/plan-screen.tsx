"use client";

import { useCallback, useEffect, useState, useTransition } from "react";

import { commitPlan, discardDraft, planStatus, requestPlan } from "./actions";
import type { GenerationStatus } from "@/lib/coach/run-generation";
import type { RebuildInfo } from "./actions";
import { SessionCard, type SessionSummary } from "@/components/session-card";

const DOW_LABEL: Record<number, string> = {
  1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday",
  5: "Friday", 6: "Saturday", 7: "Sunday",
};

/** Measured generation time is ~70s, so the progress copy is paced against that. */
const EXPECTED_SEC = 75;
const POLL_MS = 3000;

export function PlanScreen({
  initialStatus,
  checkinDow,
  rebuild,
}: {
  initialStatus: GenerationStatus | null;
  checkinDow: number;
  rebuild: RebuildInfo | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [committed, setCommitted] = useState(false);

  const generating = status?.status === "generating";

  /** Fetches the current status once. */
  const poll = useCallback(async () => {
    const next = await planStatus();
    setStatus(next);
    return next;
  }, []);

  // An interval rather than a self-scheduling timeout: the function does not need to
  // reference itself, and the effect's cleanup is the single place polling stops. The
  // server computes elapsed time from generation_started_at, so a reopened tab picks up
  // mid-generation rather than starting its own clock.
  useEffect(() => {
    if (!generating) return;
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [generating, poll]);

  function generate() {
    setError(null);
    startTransition(async () => {
      const res = await requestPlan(notes);
      if (!res.ok) {
        setError(res.error ?? "Could not start generating.");
        return;
      }
      await poll();
    });
  }

  function commit() {
    if (!status) return;
    setError(null);
    startTransition(async () => {
      const res = await commitPlan(status.weekPlanId);
      if (!res.ok) {
        setError(res.error ?? "Could not commit the plan.");
        return;
      }
      setCommitted(true);
      await poll();
    });
  }

  function discard(regenerate: boolean, correction?: string) {
    if (!status) return;
    setError(null);
    startTransition(async () => {
      const res = await discardDraft(status.weekPlanId);
      if (!res.ok) {
        setError(res.error ?? "Could not discard that plan.");
        return;
      }
      setStatus(null);
      if (regenerate) {
        const withCorrection = correction?.trim()
          ? `${notes}\n\nChange from the last version: ${correction.trim()}`.trim()
          : notes;
        const again = await requestPlan(withCorrection);
        if (!again.ok) {
          setError(again.error ?? "Could not start generating.");
          return;
        }
        await poll();
      }
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-10 pt-6">
      <header className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-steel">
          Plan
        </span>
        {status && (
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-steel">
            Week {status.weekNumber}
          </span>
        )}
      </header>

      <div className="mt-6 flex flex-col gap-5">
        {(status?.status === "active" || committed) && status?.plan && (
          <Committed status={status} rebuild={rebuild} onRebuild={() => discard(false)} />
        )}

        {!status && (
          <CheckIn
            notes={notes}
            setNotes={setNotes}
            onGenerate={generate}
            pending={pending}
            checkinDow={checkinDow}
          />
        )}

        {status?.status === "generating" && <Generating elapsedSec={status.elapsedSec ?? 0} />}

        {status?.status === "failed" && (
          <Failed
            message={status.error}
            onRetry={() => discard(true)}
            onStartOver={() => discard(false)}
            pending={pending}
          />
        )}

        {status?.status === "draft" && status.plan && (
          <Review
            status={status}
            onCommit={commit}
            onRegenerate={(correction) => discard(true, correction)}
            pending={pending}
          />
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-5 rounded-[12px] border border-alert/40 bg-alert-soft px-4 py-3"
        >
          <p className="text-[13px] leading-relaxed text-alert">{error}</p>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function CheckIn({
  notes,
  setNotes,
  onGenerate,
  pending,
  checkinDow,
}: {
  notes: string;
  setNotes: (v: string) => void;
  onGenerate: () => void;
  pending: boolean;
  checkinDow: number;
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-[27px] font-semibold uppercase leading-[1.05] tracking-[-0.025em] text-bone">
          Build next week
        </h1>
        <p className="text-[13px] leading-relaxed text-muted">
          Your check-in day is {DOW_LABEL[checkinDow]}. Everything the coach needs is
          already in your logs — this box is only for what it cannot know.
        </p>
      </div>

      <div className="flex flex-col gap-[7px]">
        <span className="font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
          Anything changed this week?
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          placeholder="Shoulder's cranky on overhead pressing. Volleyball Thursday. Travelling Wednesday."
          className="w-full rounded-[12px] border border-line bg-card-2 px-3 py-3 font-sans text-[14px] leading-relaxed text-bone placeholder:text-steel/70"
        />
        <p className="text-[12px] leading-relaxed text-muted">
          Injuries, events, how last week actually felt. A stated injury outranks an earned
          weight increase.
        </p>
      </div>

      <button
        type="button"
        onClick={onGenerate}
        disabled={pending}
        className="w-full rounded-full bg-sage px-5 py-3.5 font-sans text-[14px] font-bold uppercase tracking-[0.1em] text-ink disabled:opacity-60"
      >
        {pending ? "Starting…" : "Build my week"}
      </button>
      <p className="text-center text-[12px] text-steel">
        Takes about a minute. You can close this and come back.
      </p>
    </>
  );
}

function Generating({ elapsedSec }: { elapsedSec: number }) {
  const pct = Math.min(95, Math.round((elapsedSec / EXPECTED_SEC) * 100));
  const overdue = elapsedSec > EXPECTED_SEC * 1.6;

  // Named stages rather than a bare spinner: the work really does proceed in this order,
  // so the copy is honest about what is happening rather than decorative.
  const stage =
    elapsedSec < 8
      ? "Reading your logs"
      : elapsedSec < 25
        ? "Working out what you earned"
        : elapsedSec < 55
          ? "Building the sessions"
          : "Writing the coaching notes";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[27px] font-semibold uppercase leading-[1.05] tracking-[-0.025em] text-bone">
        Building your week
      </h1>

      <div className="h-[6px] w-full overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-sage transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-bone">{stage}…</span>
        <span className="font-mono text-[12px] tabular-nums text-steel">{elapsedSec}s</span>
      </div>

      <p className="text-[12px] leading-relaxed text-muted">
        {overdue
          ? "Taking longer than usual. It is still running — leaving this page will not cancel it."
          : "Safe to close this page. The plan will be here when you come back."}
      </p>
    </div>
  );
}

function Failed({
  message,
  onRetry,
  onStartOver,
  pending,
}: {
  message: string | null;
  onRetry: () => void;
  onStartOver: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[27px] font-semibold uppercase leading-[1.05] tracking-[-0.025em] text-bone">
        That did not work
      </h1>
      <div className="rounded-[12px] border border-alert/40 bg-alert-soft px-4 py-3">
        <p className="text-[13px] leading-relaxed text-alert">
          {message ?? "Generation failed for an unknown reason."}
        </p>
      </div>
      <p className="text-[13px] leading-relaxed text-muted">
        Nothing was saved and nothing was charged for a plan you did not get.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onStartOver}
          disabled={pending}
          className="flex-1 rounded-full border border-line px-5 py-3.5 font-sans text-[13px] font-semibold uppercase tracking-[0.1em] text-muted disabled:opacity-50"
        >
          Start over
        </button>
        <button
          type="button"
          onClick={onRetry}
          disabled={pending}
          className="flex-1 rounded-full bg-sage px-5 py-3.5 font-sans text-[14px] font-bold uppercase tracking-[0.1em] text-ink disabled:opacity-60"
        >
          {pending ? "Retrying…" : "Try again"}
        </button>
      </div>
    </div>
  );
}

function Review({
  status,
  onCommit,
  onRegenerate,
  pending,
}: {
  status: GenerationStatus;
  onCommit: () => void;
  onRegenerate: (correction?: string) => void;
  pending: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [correction, setCorrection] = useState("");
  const plan = status.plan!;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-sage">
          Review before committing
        </span>
        <h1 className="font-display text-[25px] font-semibold uppercase leading-[1.08] tracking-[-0.025em] text-bone">
          {plan.headline}
        </h1>
      </div>

      {status.source === "fallback" && (
        <div className="rounded-[12px] border border-clay/45 bg-clay/12 px-4 py-3">
          <p className="text-[12px] font-bold uppercase tracking-[0.04em] text-clay">
            Built without the coach
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            The weights are right but the exercise selection is mechanical, and there are no
            real coaching notes. Worth regenerating when you can.
          </p>
        </div>
      )}

      <WeekNote text={plan.week_note} />

      {status.warnings.length > 0 && (
        <div className="flex flex-col gap-[6px]">
          {status.warnings.map((w) => (
            <p
              key={w}
              className="rounded-[10px] border border-clay/35 bg-clay/10 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-clay"
            >
              {w}
            </p>
          ))}
        </div>
      )}

      {/* First day open, rest collapsed: reviewing four full sessions at once is a wall
          on a phone, and a wall gets scrolled past rather than read. */}
      {plan.sessions.map((s, i) => (
        <SessionCard key={`${s.dow}-${s.date}`} session={toSummary(s)} defaultOpen={i === 0} />
      ))}

      {asking ? (
        <div className="flex flex-col gap-[7px]">
          <span className="font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
            What should change?
          </span>
          <textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            rows={3}
            placeholder="Too much pressing on Monday. Move legs off Thursday."
            className="w-full rounded-[12px] border border-line bg-card-2 px-3 py-3 font-sans text-[14px] leading-relaxed text-bone placeholder:text-steel/70"
          />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setAsking(false)}
              disabled={pending}
              className="rounded-full border border-line px-4 py-3 font-sans text-[13px] font-semibold uppercase tracking-[0.08em] text-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onRegenerate(correction)}
              disabled={pending || !correction.trim()}
              className="flex-1 rounded-full bg-sage px-5 py-3 font-sans text-[14px] font-bold uppercase tracking-[0.1em] text-ink disabled:opacity-50"
            >
              {pending ? "Rebuilding…" : "Rebuild with this"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={onCommit}
            disabled={pending}
            className="w-full rounded-full bg-sage px-5 py-3.5 font-sans text-[14px] font-bold uppercase tracking-[0.1em] text-ink disabled:opacity-60"
          >
            {pending ? "Committing…" : "Start this week"}
          </button>
          <button
            type="button"
            onClick={() => setAsking(true)}
            disabled={pending}
            className="w-full rounded-full border border-dashed border-line px-5 py-3 font-sans text-[13px] font-semibold text-muted disabled:opacity-50"
          >
            Change something first
          </button>
          <button
            type="button"
            onClick={() => onRegenerate()}
            disabled={pending}
            className="w-full py-1 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-steel disabled:opacity-50"
          >
            Discard and rebuild
          </button>
          <p className="text-center text-[11.5px] leading-relaxed text-steel">
            Once you start the week it is locked — changes after that are mid-week
            adjustments, not a new plan.
          </p>
        </div>
      )}
    </div>
  );
}

function Committed({
  status,
  rebuild,
  onRebuild,
}: {
  status: GenerationStatus;
  rebuild: RebuildInfo | null;
  onRebuild: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const plan = status.plan!;

  return (
    <div className="flex flex-col gap-4">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-moss">
        Week {status.weekNumber} is live
      </span>
      <h1 className="font-display text-[25px] font-semibold uppercase leading-[1.08] tracking-[-0.025em] text-bone">
        {plan.headline}
      </h1>

      {/* Surfaced rather than buried: a plan built before the profile changed is working
          from data the user has already corrected, and they have no way to know that. */}
      {rebuild?.profileChangedSince && rebuild.canRebuild && (
        <div className="flex flex-col gap-2.5 rounded-[12px] border border-clay/45 bg-clay/12 px-4 py-3">
          <p className="text-[12px] font-bold uppercase tracking-[0.04em] text-clay">
            Your profile changed after this was built
          </p>
          <p className="text-[12.5px] leading-relaxed text-muted">
            This week was planned from older information. Nothing has been logged against
            it yet, so rebuilding costs nothing.
          </p>
          {confirming ? (
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-full border border-line px-4 py-2.5 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-muted"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={onRebuild}
                className="flex-1 rounded-full bg-clay px-4 py-2.5 font-sans text-[13px] font-bold uppercase tracking-[0.08em] text-ink"
              >
                Rebuild the week
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="self-start rounded-full border border-clay/60 px-4 py-2 font-sans text-[12px] font-bold uppercase tracking-[0.08em] text-clay"
            >
              Rebuild from current profile
            </button>
          )}
        </div>
      )}

      <WeekNote text={plan.week_note} />

      {plan.sessions.map((s, i) => (
        <SessionCard key={`${s.dow}-${s.date}`} session={toSummary(s)} defaultOpen={i === 0} />
      ))}

      {rebuild && rebuild.loggedSets > 0 && (
        <p className="text-[12px] leading-relaxed text-muted">
          {rebuild.loggedSets} set{rebuild.loggedSets === 1 ? "" : "s"} logged against this
          week, so it can no longer be rebuilt. Mid-week adjustments are coming.
        </p>
      )}
    </div>
  );
}

/**
 * The week note, broken into paragraphs.
 *
 * The model writes it as one long block. At body size that is a wall, and it carries the
 * reasoning that makes the plan feel considered — the part most worth reading is the part
 * most likely to be skipped in that form.
 */
function WeekNote({ text }: { text: string }) {
  const paragraphs = splitIntoParagraphs(text);
  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-line-2 bg-card-2 px-4 py-3.5">
      {paragraphs.map((para, i) => (
        <p key={i} className="text-[13px] leading-[1.6] text-bone">
          {para}
        </p>
      ))}
    </div>
  );
}

/** Groups sentences into paragraphs of two to three, preserving any breaks already there. */
function splitIntoParagraphs(text: string): string[] {
  const existing = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (existing.length > 1) return existing;

  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text];
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += 3) {
    out.push(sentences.slice(i, i + 3).join("").trim());
  }
  return out.filter(Boolean);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Maps a raw_plan session into the shared card's shape. */
function toSummary(s: any): SessionSummary {
  return {
    dow: s.dow,
    date: s.date,
    sessionName: s.session_name,
    timeBudgetMin: s.time_budget_min,
    warmupMin: s.warmup_min ?? null,
    warmupNote: s.warmup_note ?? null,
    headline: s.headline ?? null,
    exercises: (s.exercises ?? []).map((e: any) => ({
      name: e.name,
      sets: e.sets,
      targetReps: e.target_reps,
      targetWeight: e.target_weight === null ? null : Number(e.target_weight),
      restSec: e.rest_sec ?? 60,
      supersetGroup: e.superset_group ?? null,
      tag: e.tag ?? null,
      coachingNote: e.coaching_note ?? "",
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
