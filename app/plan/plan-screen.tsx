"use client";

import { useCallback, useEffect, useState, useTransition } from "react";

import { commitPlan, discardDraft, planStatus, requestPlan } from "./actions";
import type { GenerationStatus } from "@/lib/coach/run-generation";

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
}: {
  initialStatus: GenerationStatus | null;
  checkinDow: number;
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

        {(status?.status === "active" || committed) && status?.plan && (
          <Committed status={status} />
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

      <div className="rounded-[14px] border border-line-2 bg-card-2 px-4 py-3.5">
        <p className="text-[13px] leading-[1.55] text-bone">{plan.week_note}</p>
      </div>

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

      {plan.sessions.map((s) => (
        <div
          key={`${s.dow}-${s.date}`}
          className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-card p-4"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[12px] font-semibold text-bone">
              {s.dow.toUpperCase()} · {s.session_name}
            </span>
            <span className="font-mono text-[11px] text-muted">
              {s.time_budget_min}m · warmup {s.warmup_min}m
            </span>
          </div>
          <p className="text-[12.5px] text-muted">{s.headline}</p>
          <p className="text-[12px] leading-relaxed text-mist">
            <span className="font-semibold text-bone">Warmup:</span> {s.warmup_note}
          </p>
          <div className="flex flex-col">
            {s.exercises.map((ex) => (
              <div
                key={ex.name}
                className="flex flex-col gap-1 border-t border-line-2 py-2.5 first:border-t-0"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13.5px] text-bone">
                    {ex.name}
                    {ex.tag && (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.1em] text-clay">
                        {ex.tag}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums text-bone">
                    {ex.target_weight === null ? (
                      <span className="font-normal text-mist">find it</span>
                    ) : (
                      ex.target_weight
                    )}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-muted">
                  {ex.sets} × {ex.target_reps} · rest {ex.rest_sec}s
                  {ex.superset_group ? ` · superset ${ex.superset_group}` : ""}
                </span>
                <p className="text-[12px] leading-relaxed text-muted">{ex.coaching_note}</p>
              </div>
            ))}
          </div>
        </div>
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

function Committed({ status }: { status: GenerationStatus }) {
  const plan = status.plan!;
  return (
    <div className="flex flex-col gap-4">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-moss">
        Week {status.weekNumber} is live
      </span>
      <h1 className="font-display text-[25px] font-semibold uppercase leading-[1.08] tracking-[-0.025em] text-bone">
        {plan.headline}
      </h1>
      <div className="rounded-[14px] border border-line-2 bg-card-2 px-4 py-3.5">
        <p className="text-[13px] leading-[1.55] text-bone">{plan.week_note}</p>
      </div>
      <div className="flex flex-col gap-[7px]">
        {plan.sessions.map((s) => (
          <div
            key={`${s.dow}-${s.date}`}
            className="flex items-baseline justify-between gap-3 rounded-[12px] border border-line bg-card px-4 py-3"
          >
            <span className="font-mono text-[12px] font-semibold text-bone">
              {s.dow.toUpperCase()} · {s.session_name}
            </span>
            <span className="font-mono text-[11px] text-muted">
              {s.exercises.length} exercises · {s.time_budget_min}m
            </span>
          </div>
        ))}
      </div>
      <p className="text-[12px] leading-relaxed text-muted">
        This week is locked. Mid-week adjustments are coming — for now, train it and log
        your sets.
      </p>
    </div>
  );
}
