"use client";

import { useState } from "react";

/**
 * One training day, collapsed to a summary until tapped.
 *
 * Four sessions with every exercise and coaching note expanded is a wall on a phone, and
 * a wall gets scrolled past rather than read. Collapsed, the week is scannable and the
 * detail is one tap away — which is also how the plan is actually used: you look at one
 * day, not at the week.
 */

export interface SessionExercise {
  name: string;
  sets: number;
  targetReps: string;
  targetWeight: number | null;
  restSec: number;
  supersetGroup: string | null;
  tag: string | null;
  coachingNote: string;
}

export interface SessionSummary {
  dow: string;
  date: string;
  sessionName: string;
  timeBudgetMin: number;
  warmupMin: number | null;
  warmupNote: string | null;
  headline: string | null;
  exercises: SessionExercise[];
}

export function SessionCard({
  session,
  defaultOpen = false,
  accent = "line",
}: {
  session: SessionSummary;
  defaultOpen?: boolean;
  /** Today's session is worth marking out from the rest of the week. */
  accent?: "line" | "sage";
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className={`overflow-hidden rounded-[14px] border bg-card ${
        accent === "sage" ? "border-sage/50" : "border-line"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
      >
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="font-mono text-[12px] font-semibold text-bone">
            {session.dow.toUpperCase()} · {session.sessionName}
          </span>
          <span className="font-mono text-[11px] text-muted">
            {session.exercises.length} exercises · {session.timeBudgetMin}m
            {session.warmupMin ? ` · warmup ${session.warmupMin}m` : ""}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 font-mono text-[11px] text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-line-2 px-4 pb-4 pt-3.5">
          {session.headline && (
            <p className="text-[12.5px] leading-relaxed text-muted">{session.headline}</p>
          )}

          {session.warmupNote && (
            <p className="text-[12px] leading-relaxed text-mist">
              <span className="font-semibold text-bone">Warmup:</span> {session.warmupNote}
            </p>
          )}

          <div className="flex flex-col">
            {session.exercises.map((ex, i) => (
              <div
                key={`${ex.name}-${i}`}
                className={`flex flex-col gap-1 py-2.5 ${
                  i > 0 ? "border-t border-line-2" : ""
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13.5px] leading-snug text-bone">
                    {ex.name}
                    {ex.tag && (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.1em] text-clay">
                        {ex.tag}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums text-bone">
                    {ex.targetWeight === null ? (
                      <span className="font-normal text-mist">find it</span>
                    ) : (
                      ex.targetWeight
                    )}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-muted">
                  {ex.sets} × {ex.targetReps} · rest {ex.restSec}s
                  {ex.supersetGroup ? ` · superset ${ex.supersetGroup}` : ""}
                </span>
                {ex.coachingNote && (
                  <p className="text-[12px] leading-relaxed text-muted">{ex.coachingNote}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
