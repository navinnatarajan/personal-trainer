"use client";

import { useState, useTransition } from "react";

import {
  confirmProposals,
  importContext,
  replayOnboarding,
  saveProfile,
  signOutAction,
  type ProfileEdits,
} from "./actions";
import { proposalKey, type Consolidation, type Proposal } from "@/lib/coach/consolidate";
import { proposalCategory } from "@/lib/coach/apply-proposals";

const DOW_LABEL: Record<number, string> = {
  1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday",
  5: "Friday", 6: "Saturday", 7: "Sunday",
};
const DOW_SHORT: Record<number, string> = {
  1: "Mo", 2: "Tu", 3: "We", 4: "Th", 5: "Fr", 6: "Sa", 7: "Su",
};
const DURATIONS = [20, 30, 40, 45, 60, 90] as const;

const GOALS = [
  { value: "lose_body_fat", label: "Lose body fat" },
  { value: "v_taper", label: "V-taper" },
  { value: "build_muscle", label: "Build muscle" },
  { value: "build_strength", label: "Build strength" },
  { value: "build_endurance", label: "Build endurance" },
];

const SPLITS = [
  { value: "push_pull_legs", label: "Push / Pull / Legs" },
  { value: "upper_lower", label: "Upper / Lower" },
  { value: "full_body", label: "Full body" },
  { value: "coach_decides", label: "Coach decides" },
];

export function ProfileScreen({
  email,
  displayName,
  initial,
  excluded,
  trainingLevel,
  gymType,
}: {
  email: string;
  displayName: string | null;
  initial: ProfileEdits;
  excluded: string[];
  trainingLevel: string;
  gymType: string | null;
}) {
  const [edits, setEdits] = useState<ProfileEdits>(initial);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Context import lives in its own state so a half-finished import never mixes with
  // unsaved form edits.
  const [paste, setPaste] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<Consolidation | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  function update(patch: Partial<ProfileEdits>) {
    setEdits((e) => ({ ...e, ...patch }));
    setDirty(true);
    setSaved(false);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await saveProfile(edits);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setDirty(false);
      setSaved(true);
    });
  }

  function runImport() {
    setError(null);
    setImporting(true);
    startTransition(async () => {
      const res = await importContext(paste);
      setImporting(false);
      if (!res.ok) return setError(res.error ?? "Could not read that.");
      setResult(res.consolidation ?? null);
      // Everything starts ticked: the model only proposes what changed, so the common
      // case is accepting all of it.
      setAccepted(new Set((res.consolidation?.proposals ?? []).map(proposalKey)));
    });
  }

  function applyAccepted() {
    if (!result) return;
    const chosen = result.proposals.filter((p) => accepted.has(proposalKey(p)));
    setError(null);
    startTransition(async () => {
      const res = await confirmProposals(chosen);
      if (!res.ok || res.error) setError(res.error ?? "Some changes could not be applied.");
      if (res.ok) {
        setResult(null);
        setPaste("");
        // The form still holds pre-import values, so reload rather than show stale fields.
        window.location.reload();
      }
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-7 px-5 pb-8 pt-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-steel">
          You
        </span>
        <h1 className="font-display text-[28px] font-semibold uppercase leading-[1.05] tracking-[-0.03em] text-bone">
          {displayName ?? email}
        </h1>
        <span className="font-mono text-[11px] text-steel">{email}</span>
      </header>

      {/* ---------- context import ---------- */}
      <Section
        title="Update from a conversation"
        hint="Paste anything you've written elsewhere — a chat with Claude or ChatGPT, your own notes. It reads what changed and shows you before anything is saved."
      >
        {!result ? (
          <>
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={5}
              placeholder="Paste here. Things like what you're training now, injuries that healed, days that changed, sports you've stopped or started."
              className="w-full rounded-[12px] border border-line bg-card-2 px-3 py-3 font-sans text-[14px] leading-relaxed text-bone placeholder:text-steel/70"
            />
            <PrimaryButton
              onClick={runImport}
              disabled={pending || !paste.trim()}
              label={importing ? "Reading…" : "Read this"}
            />
          </>
        ) : (
          <ProposalList
            result={result}
            accepted={accepted}
            setAccepted={setAccepted}
            onApply={applyAccepted}
            onCancel={() => {
              setResult(null);
              setAccepted(new Set());
            }}
            pending={pending}
          />
        )}
      </Section>

      {/* ---------- training days ---------- */}
      <Section title="When you train">
        <div className="rounded-[14px] border border-line bg-card px-4 py-1">
          {edits.days.map((d, i) => (
            <div
              key={d.dow}
              className={`flex items-center justify-between gap-3 py-2.5 ${i > 0 ? "border-t border-line-2" : ""}`}
            >
              <button
                type="button"
                onClick={() =>
                  update({
                    days: edits.days.map((x) =>
                      x.dow === d.dow
                        ? {
                            ...x,
                            canTrain: !x.canTrain,
                            durationMin: !x.canTrain ? (x.durationMin ?? 30) : null,
                          }
                        : x,
                    ),
                  })
                }
                aria-pressed={d.canTrain}
                className="flex flex-1 items-center gap-[10px] text-left"
              >
                <Check on={d.canTrain} />
                <span className={`text-[14px] ${d.canTrain ? "text-bone" : "text-muted"}`}>
                  {DOW_LABEL[d.dow]}
                </span>
              </button>
              {d.canTrain ? (
                <button
                  type="button"
                  onClick={() => {
                    const i2 = DURATIONS.indexOf((d.durationMin ?? 30) as (typeof DURATIONS)[number]);
                    update({
                      days: edits.days.map((x) =>
                        x.dow === d.dow
                          ? { ...x, durationMin: DURATIONS[(i2 + 1) % DURATIONS.length] }
                          : x,
                      ),
                    });
                  }}
                  className="rounded-full border border-line bg-card-2 px-3 py-1.5 font-mono text-[13px] tabular-nums text-bone"
                >
                  {d.durationMin ?? 30} min
                </button>
              ) : (
                <span className="px-3 py-1.5 font-mono text-[13px] text-line">—</span>
              )}
            </div>
          ))}
        </div>

        <Label>Check in on</Label>
        <div className="grid grid-cols-7 gap-[5px]">
          {edits.days.map((d) => (
            <button
              key={d.dow}
              type="button"
              onClick={() => update({ checkinDow: d.dow })}
              aria-pressed={edits.checkinDow === d.dow}
              className={`rounded-[12px] border py-2.5 font-mono text-[12px] ${
                edits.checkinDow === d.dow
                  ? "border-sage bg-sage font-semibold text-ink"
                  : "border-line bg-card-2 text-muted"
              }`}
            >
              {DOW_SHORT[d.dow]}
            </button>
          ))}
        </div>
      </Section>

      {/* ---------- activities ---------- */}
      <Section
        title="Sport and cardio"
        hint="Outside the gym. This is load, not rest — it moves hard leg work away from a game and the day after."
      >
        {edits.activities.length === 0 && (
          <p className="text-[13px] text-muted">Nothing recorded.</p>
        )}
        {edits.activities.map((a) => (
          <div key={a.name} className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-card p-3.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] font-medium text-bone">{a.name}</span>
              <button
                type="button"
                onClick={() =>
                  update({ activities: edits.activities.filter((x) => x.name !== a.name) })
                }
                aria-label={`Remove ${a.name}`}
                className="rounded-full border border-line px-3 py-1 font-sans text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-7 gap-[4px]">
              {[1, 2, 3, 4, 5, 6, 7].map((dow) => {
                const on = a.dows.includes(dow);
                return (
                  <button
                    key={dow}
                    type="button"
                    onClick={() =>
                      update({
                        activities: edits.activities.map((x) =>
                          x.name === a.name
                            ? {
                                ...x,
                                dows: on
                                  ? x.dows.filter((v) => v !== dow)
                                  : [...x.dows, dow].sort(),
                              }
                            : x,
                        ),
                      })
                    }
                    aria-pressed={on}
                    className={`rounded-[9px] border py-2 font-mono text-[11px] ${
                      on ? "border-mist bg-mist text-ink" : "border-line bg-card-2 text-muted"
                    }`}
                  >
                    {DOW_SHORT[dow]}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-3 gap-[6px]">
              {["light", "moderate", "hard"].map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() =>
                    update({
                      activities: edits.activities.map((x) =>
                        x.name === a.name ? { ...x, intensity: lvl } : x,
                      ),
                    })
                  }
                  aria-pressed={a.intensity === lvl}
                  className={`rounded-[10px] border py-2 font-sans text-[12px] font-semibold capitalize ${
                    a.intensity === lvl
                      ? "border-sage bg-sage text-ink"
                      : "border-line bg-card-2 text-muted"
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>
        ))}
        <AddActivity
          onAdd={(name) =>
            update({
              activities: [...edits.activities, { name, dows: [], intensity: "moderate" }],
            })
          }
          existing={edits.activities.map((a) => a.name)}
        />
      </Section>

      {/* ---------- goals ---------- */}
      <Section title="Goals" hint="In priority order. The first one wins when they conflict.">
        <div className="flex flex-col gap-[7px]">
          {edits.goals.map((g, rank) => (
            <div
              key={g}
              className="flex items-center gap-3 rounded-[12px] border border-sage/55 bg-sage/12 px-3 py-3"
            >
              <span className="w-5 text-center font-mono text-[14px] font-semibold text-sage">
                {rank + 1}
              </span>
              <span className="flex-1 text-[14px] text-bone">
                {GOALS.find((x) => x.value === g)?.label ?? g}
              </span>
              {rank > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    update({ goals: [g, ...edits.goals.filter((x) => x !== g)] })
                  }
                  className="rounded-full border border-line px-2.5 py-1.5 font-sans text-[10px] font-bold uppercase tracking-[0.08em] text-muted"
                >
                  Top
                </button>
              )}
              <button
                type="button"
                onClick={() => update({ goals: edits.goals.filter((x) => x !== g) })}
                aria-label="Remove goal"
                className="px-2 font-mono text-[15px] leading-none text-muted"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {edits.goals.length < 3 && (
          <div className="flex flex-wrap gap-[7px]">
            {GOALS.filter((g) => !edits.goals.includes(g.value)).map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => update({ goals: [...edits.goals, g.value] })}
                className="rounded-full border border-line bg-card-2 px-3 py-2 text-[12px] font-semibold text-muted"
              >
                + {g.label}
              </button>
            ))}
          </div>
        )}

        <Label>Split</Label>
        <div className="grid grid-cols-2 gap-[6px]">
          {SPLITS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => update({ splitPreference: s.value })}
              aria-pressed={edits.splitPreference === s.value}
              className={`rounded-[10px] border px-3 py-2.5 font-sans text-[12.5px] font-semibold ${
                edits.splitPreference === s.value
                  ? "border-sage bg-sage text-ink"
                  : "border-line bg-card-2 text-muted"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Section>

      {/* ---------- constraints ---------- */}
      <Section
        title="Standing constraints"
        hint="Only things that stay true. Week-to-week niggles go in your check-in."
      >
        <textarea
          value={edits.durableConstraints ?? ""}
          onChange={(e) => update({ durableConstraints: e.target.value || null })}
          rows={4}
          placeholder="Injuries, equipment the gym lacks, anything long-standing."
          className="w-full rounded-[12px] border border-line bg-card-2 px-3 py-3 font-sans text-[14px] leading-relaxed text-bone placeholder:text-steel/70"
        />
        {excluded.length > 0 && (
          <>
            <Label>Never programmed</Label>
            <div className="flex flex-wrap gap-[6px]">
              {excluded.map((n) => (
                <span
                  key={n}
                  className="rounded-full border border-line bg-card-2 px-3 py-1.5 font-mono text-[11.5px] text-muted"
                >
                  {n}
                </span>
              ))}
            </div>
            <p className="text-[12px] text-steel">
              Change these by pasting a note above, or in setup.
            </p>
          </>
        )}
      </Section>

      {/* ---------- save ---------- */}
      <div className="flex flex-col gap-2">
        <PrimaryButton
          onClick={save}
          disabled={pending || !dirty}
          label={pending ? "Saving…" : saved ? "Saved" : dirty ? "Save changes" : "No changes"}
        />
        {error && (
          <div role="alert" className="rounded-[12px] border border-alert/40 bg-alert-soft px-4 py-3">
            <p className="text-[13px] leading-relaxed text-alert">{error}</p>
          </div>
        )}
      </div>

      {/* ---------- read-only + account ---------- */}
      <Section title="Set at signup">
        <dl className="divide-y divide-line-2 rounded-[14px] border border-line bg-card px-4">
          <Row label="Training level" value={trainingLevel} />
          <Row label="Gym" value={gymType ?? "not set"} />
        </dl>
        <form action={replayOnboarding}>
          <button
            type="submit"
            className="w-full rounded-full border border-line bg-card-2 px-5 py-3 font-sans text-[13px] font-semibold text-muted"
          >
            Run setup again
          </button>
        </form>
        <p className="text-[12px] leading-relaxed text-steel">
          Walks the first-run flow with your answers pre-filled. Nothing is deleted.
        </p>
      </Section>

      <form action={signOutAction} className="pb-2">
        <button
          type="submit"
          className="w-full rounded-full border border-alert/40 px-5 py-3 font-sans text-[13px] font-semibold uppercase tracking-[0.08em] text-alert"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------

function ProposalList({
  result,
  accepted,
  setAccepted,
  onApply,
  onCancel,
  pending,
}: {
  result: Consolidation;
  accepted: Set<string>;
  setAccepted: (s: Set<string>) => void;
  onApply: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  function toggle(p: Proposal) {
    const key = proposalKey(p);
    const next = new Set(accepted);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setAccepted(next);
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="rounded-[12px] border border-mist/40 bg-mist/10 px-3.5 py-3">
        <p className="text-[12.5px] leading-relaxed text-bone">{result.interpretation}</p>
      </div>

      {result.proposals.length === 0 && (
        <p className="text-[13px] text-muted">
          Nothing in there differs from what is already saved.
        </p>
      )}

      {result.proposals.map((p) => {
        const key = proposalKey(p);
        const on = accepted.has(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => toggle(p)}
            aria-pressed={on}
            className={`flex items-start gap-3 rounded-[12px] border px-3.5 py-3 text-left ${
              on ? "border-sage/55 bg-sage/12" : "border-line bg-card-2 opacity-60"
            }`}
          >
            <Check on={on} />
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-steel">
                {proposalCategory(p)}
              </span>
              <span className="text-[13.5px] leading-snug text-bone">{p.summary}</span>
              <span className="border-l-2 border-line pl-2.5 text-[11.5px] italic leading-snug text-muted">
                &ldquo;{p.evidence}&rdquo;
              </span>
            </span>
          </button>
        );
      })}

      {result.unclear.length > 0 && (
        <div className="rounded-[12px] border border-clay/35 bg-clay/10 px-3.5 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-clay">
            Not sure about
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {result.unclear.map((u) => (
              <li key={u} className="text-[12px] leading-snug text-muted">
                {u}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-full border border-line px-4 py-3 font-sans text-[13px] font-semibold uppercase tracking-[0.08em] text-muted disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={pending || accepted.size === 0}
          className="flex-1 rounded-full bg-sage px-5 py-3 font-sans text-[14px] font-bold uppercase tracking-[0.1em] text-ink disabled:opacity-50"
        >
          {pending ? "Applying…" : `Apply ${accepted.size}`}
        </button>
      </div>
    </div>
  );
}

function AddActivity({
  onAdd,
  existing,
}: {
  onAdd: (name: string) => void;
  existing: string[];
}) {
  const [value, setValue] = useState("");
  const clean = value.trim();
  const duplicate = existing.some((e) => e.toLowerCase() === clean.toLowerCase());

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && clean && !duplicate) {
            e.preventDefault();
            onAdd(clean);
            setValue("");
          }
        }}
        placeholder="Add a sport or activity"
        className="min-w-0 flex-1 rounded-[12px] border border-line bg-card-2 px-3 py-3 font-sans text-[14px] text-bone outline-none placeholder:text-steel/70"
      />
      <button
        type="button"
        onClick={() => {
          if (!clean || duplicate) return;
          onAdd(clean);
          setValue("");
        }}
        disabled={!clean || duplicate}
        className="shrink-0 rounded-[12px] border border-line bg-card-2 px-4 font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-muted disabled:opacity-40"
      >
        Add
      </button>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[17px] font-semibold uppercase tracking-[-0.01em] text-bone">
          {title}
        </h2>
        {hint && <p className="text-[12.5px] leading-relaxed text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
      {children}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="text-[13px] capitalize text-bone">{value.replace(/_/g, " ")}</dd>
    </div>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative mt-[1px] h-[19px] w-[19px] shrink-0 rounded-[6px] border-[1.5px] ${
        on ? "border-sage bg-sage" : "border-line"
      }`}
    >
      {on && (
        <span className="absolute inset-[4px_4px_5px_4px] -translate-y-px rotate-[-45deg] border-b-2 border-l-2 border-ink" />
      )}
    </span>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-full bg-sage px-5 py-3.5 font-sans text-[14px] font-bold uppercase tracking-[0.1em] text-ink disabled:opacity-40"
    >
      {label}
    </button>
  );
}
