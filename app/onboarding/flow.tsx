"use client";

import { useState, useTransition } from "react";

import { completeOnboarding } from "./actions";
import {
  COMMON_ACTIVITIES,
  COMMON_EXCLUSIONS,
  DOW_LABEL,
  DOW_SHORT,
  DURATIONS,
  EQUIPMENT,
  GOALS,
  GYM_TYPES,
  INTENSITIES,
  SPLITS,
  TRAINING_LEVELS,
  crossFieldErrors,
  type ActivityInput,
  type OnboardingInput,
} from "./schema";

export interface LibraryEntry {
  name: string;
  muscleGroup: string;
}

/**
 * Six steps. Client-side so a step can be validated before the user moves on, and so the
 * whole thing submits once at the end rather than writing partial state.
 *
 * The equipment step is skipped entirely for a full gym: ticking eight boxes that are all
 * true conveys nothing, and people cannot recall their gym's inventory from memory anyway.
 */
export function OnboardingFlow({
  initial,
  firstName,
  returning,
  library,
}: {
  initial: OnboardingInput;
  firstName: string | null;
  returning: boolean;
  library: LibraryEntry[];
}) {
  const [data, setData] = useState<OnboardingInput>(initial);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof OnboardingInput>(key: K, value: OnboardingInput[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  const needsEquipment = data.gymType !== "full";
  const steps = ["You", "Now", "Gym", "Goals", "Week", "Sport", "Limits"];
  const total = steps.length;

  function next() {
    const stepErrors = validateStep(step, data);
    if (stepErrors.length) {
      setErrors(stepErrors);
      return;
    }
    setErrors([]);
    setStep((s) => Math.min(total - 1, s + 1));
  }

  function back() {
    setErrors([]);
    setStep((s) => Math.max(0, s - 1));
  }

  function submit() {
    const all = [...validateStep(step, data), ...crossFieldErrors(data)];
    if (all.length) {
      setErrors(all);
      return;
    }
    setErrors([]);
    startTransition(async () => {
      const result = await completeOnboarding(data);
      // On success the action redirects, so reaching here means it failed.
      if (result && !result.ok) setErrors(result.errors);
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-10 pt-6">
      <header className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-steel">
          {returning ? "Your setup" : "Setup"}
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-steel">
          {step + 1} of {total}
        </span>
      </header>

      <div className="mt-3 flex items-center gap-[6px]">
        {steps.map((s, i) => (
          <span
            key={s}
            className={`h-[3px] flex-1 rounded-full ${i <= step ? "bg-sage" : "bg-line"}`}
          />
        ))}
      </div>

      <div className="mt-7 flex flex-col gap-5">
        {step === 0 && <StepYou data={data} set={set} firstName={firstName} returning={returning} />}
        {step === 1 && <StepNow data={data} set={set} />}
        {step === 2 && <StepGym data={data} set={set} needsEquipment={needsEquipment} />}
        {step === 3 && <StepGoals data={data} set={set} />}
        {step === 4 && <StepWeek data={data} set={set} />}
        {step === 5 && <StepActivities data={data} set={set} />}
        {step === 6 && <StepLimits data={data} set={set} library={library} />}
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="mt-5 rounded-[12px] border border-alert/40 bg-alert-soft px-4 py-3"
        >
          {errors.map((e) => (
            <p key={e} className="text-[13px] leading-relaxed text-alert">
              {e}
            </p>
          ))}
        </div>
      )}

      <div className="mt-7 flex items-center gap-3">
        {step > 0 && (
          <button
            type="button"
            onClick={back}
            disabled={pending}
            className="rounded-full border border-line px-5 py-3.5 font-sans text-[13px] font-semibold uppercase tracking-[0.1em] text-muted disabled:opacity-50"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={step === total - 1 ? submit : next}
          disabled={pending}
          className="flex-1 rounded-full bg-sage px-5 py-3.5 font-sans text-[14px] font-bold uppercase tracking-[0.1em] text-ink disabled:opacity-60"
        >
          {pending
            ? "Saving…"
            : step === total - 1
              ? returning
                ? "Save and plan my week"
                : "Build my first week"
              : "Next"}
        </button>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type Setter = <K extends keyof OnboardingInput>(k: K, v: OnboardingInput[K]) => void;

function StepYou({
  data,
  set,
  firstName,
  returning,
}: {
  data: OnboardingInput;
  set: Setter;
  firstName: string | null;
  returning: boolean;
}) {
  return (
    <>
      <Title
        title={firstName && !returning ? `Hello, ${firstName}` : "About you"}
        sub={
          returning
            ? "Already filled in from what we know. Change anything that is wrong."
            : "Set once. We will not ask again."
        }
      />

      <Field label="Sex">
        <Segmented
          options={[
            { value: "male", label: "Male" },
            { value: "female", label: "Female" },
            { value: "prefer_not_to_say", label: "Rather not" },
          ]}
          value={data.sex}
          onChange={(v) => set("sex", v as OnboardingInput["sex"])}
        />
        <Hint>Used for body-composition targets only.</Hint>
      </Field>

      <Field label="Height">
        <HeightPicker value={data.heightIn} onChange={(v) => set("heightIn", v)} />
      </Field>

      <Field label="Year of birth">
        <YearPicker value={data.birthYear} onChange={(v) => set("birthYear", v)} />
        <Hint>Affects recovery capacity and how much volume is sensible.</Hint>
      </Field>
    </>
  );
}

function StepNow({ data, set }: { data: OnboardingInput; set: Setter }) {
  return (
    <>
      <Title title="Where you are now" sub="The starting point for everything that follows." />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Weight">
          <NumberInput value={data.weightLbs} onChange={(v) => set("weightLbs", v)} unit="lbs" placeholder="190" />
        </Field>
        <Field label="Waist">
          <NumberInput value={data.waistIn} onChange={(v) => set("waistIn", v)} unit="in" placeholder="34" />
        </Field>
      </div>
      <Hint>
        Waist is optional but worth it — waist-to-height tracks leanness far better than
        BMI, which calls a tall person with muscle overweight.
      </Hint>

      <Field label="How long have you been lifting?">
        <Radios
          options={TRAINING_LEVELS}
          value={data.trainingLevel}
          onChange={(v) => set("trainingLevel", v as OnboardingInput["trainingLevel"])}
        />
      </Field>
    </>
  );
}

function StepGym({
  data,
  set,
  needsEquipment,
}: {
  data: OnboardingInput;
  set: Setter;
  needsEquipment: boolean;
}) {
  function toggle(item: string) {
    const has = data.equipment.includes(item);
    set("equipment", has ? data.equipment.filter((e) => e !== item) : [...data.equipment, item]);
  }

  return (
    <>
      <Title title="Your gym" sub="Nothing gets programmed that you cannot load." />

      <Radios
        options={GYM_TYPES}
        value={data.gymType}
        onChange={(v) => set("gymType", v as OnboardingInput["gymType"])}
      />

      {needsEquipment && (
        <Field label="What's available?">
          <div className="grid grid-cols-2 gap-[7px]">
            {EQUIPMENT.map((item) => {
              const on = data.equipment.includes(item);
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => toggle(item)}
                  aria-pressed={on}
                  className={`flex items-center gap-[9px] rounded-[12px] border px-3 py-2.5 text-left text-[13px] font-medium ${
                    on
                      ? "border-sage/55 bg-sage/12 text-bone"
                      : "border-line bg-card-2 text-muted"
                  }`}
                >
                  <Check on={on} />
                  {item}
                </button>
              );
            })}
          </div>
          <Hint>
            You can fix this later too — any exercise has a &ldquo;my gym doesn&apos;t have
            this&rdquo; option.
          </Hint>
        </Field>
      )}

      <Field label="What do you prefer lifting with?">
        <Segmented
          options={[
            { value: "machines", label: "Machines" },
            { value: "mix", label: "A mix" },
            { value: "free_weights", label: "Free weights" },
          ]}
          value={data.stylePreference}
          onChange={(v) => set("stylePreference", v as OnboardingInput["stylePreference"])}
        />
        <Hint>A lean, not a rule — you will still see some of both.</Hint>
      </Field>
    </>
  );
}

function StepGoals({ data, set }: { data: OnboardingInput; set: Setter }) {
  type Goal = OnboardingInput["goals"][number];

  function toggle(goal: Goal) {
    const i = data.goals.indexOf(goal);
    if (i >= 0) {
      set("goals", data.goals.filter((g) => g !== goal) as OnboardingInput["goals"]);
    } else if (data.goals.length < 3) {
      set("goals", [...data.goals, goal] as OnboardingInput["goals"]);
    }
  }

  /** Moves a goal to a new index, shifting the rest — the list visibly reorders. */
  function moveTo(goal: Goal, index: number) {
    const from = data.goals.indexOf(goal);
    if (from < 0) return;
    const next = data.goals.filter((g) => g !== goal);
    next.splice(index, 0, goal);
    set("goals", next as OnboardingInput["goals"]);
  }

  // Fat loss and muscle gain pull against each other. Naming it means slow strength
  // progress later reads as expected rather than as the app failing.
  const conflict =
    data.goals.includes("lose_body_fat") &&
    (data.goals.includes("build_muscle") || data.goals.includes("build_strength"));

  return (
    <>
      <Title
        title="What are you after?"
        sub="Up to three, in priority order. The first one wins when they conflict."
      />

      {/* Chosen goals, in order. The items themselves move — an earlier version renumbered
          them in place, which read as a bug rather than a reorder. */}
      {data.goals.length > 0 && (
        <div className="flex flex-col gap-[7px]">
          {data.goals.map((value, rank) => {
            const g = GOALS.find((x) => x.value === value)!;
            return (
              <div
                key={value}
                className="flex items-center gap-3 rounded-[12px] border border-sage/55 bg-sage/12 px-3 py-3"
              >
                <span className="w-5 shrink-0 text-center font-mono text-[14px] font-semibold text-sage">
                  {rank + 1}
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="text-[14px] font-medium text-bone">{g.label}</span>
                  <span className="text-[11px] text-muted">{g.hint}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {rank > 0 && (
                    <button
                      type="button"
                      onClick={() => moveTo(value, 0)}
                      aria-label={`Make ${g.label} the top priority`}
                      className="rounded-full border border-line px-2.5 py-1.5 font-sans text-[10px] font-bold uppercase tracking-[0.08em] text-muted"
                    >
                      Top
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => toggle(value)}
                    aria-label={`Remove ${g.label}`}
                    className="px-2 py-1 font-mono text-[15px] leading-none text-muted"
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {data.goals.length < 3 && (
        <Field label={data.goals.length ? "Add another" : "Pick your first"}>
          <div className="flex flex-wrap gap-[7px]">
            {GOALS.filter((g) => !data.goals.includes(g.value as Goal)).map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => toggle(g.value as Goal)}
                className="rounded-full border border-line bg-card-2 px-3 py-2 text-[12px] font-semibold text-muted"
              >
                + {g.label}
              </button>
            ))}
          </div>
        </Field>
      )}

      {conflict && (
        <div className="rounded-[12px] border border-clay/45 bg-clay/12 px-4 py-3">
          <p className="text-[12px] font-bold uppercase tracking-[0.04em] text-clay">
            These two compete
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            Losing fat and adding muscle pull opposite ways.{" "}
            {data.goals[0] === "lose_body_fat"
              ? "Fat loss is first, so expect strength to climb slowly — that is the trade, not a plateau."
              : "Muscle is first, so fat loss will be slower."}
          </p>
        </div>
      )}

      <Field label="How do you want the week split?">
        <Radios
          options={SPLITS}
          value={data.splitPreference}
          onChange={(v) => set("splitPreference", v as OnboardingInput["splitPreference"])}
        />
      </Field>
    </>
  );
}

function StepWeek({ data, set }: { data: OnboardingInput; set: Setter }) {
  function toggleDay(dow: number) {
    set(
      "days",
      data.days.map((d) =>
        d.dow === dow
          ? { ...d, canTrain: !d.canTrain, durationMin: !d.canTrain ? (d.durationMin ?? 30) : null }
          : d,
      ),
    );
  }

  function cycleDuration(dow: number) {
    set(
      "days",
      data.days.map((d) => {
        if (d.dow !== dow) return d;
        const i = DURATIONS.indexOf((d.durationMin ?? 30) as (typeof DURATIONS)[number]);
        return { ...d, durationMin: DURATIONS[(i + 1) % DURATIONS.length] };
      }),
    );
  }

  return (
    <>
      <Title
        title="When can you train?"
        sub="Be honest rather than optimistic — a budget you never meet produces plans you never finish."
      />

      <div className="rounded-[18px] border border-line bg-card p-4">
        {data.days.map((d, i) => (
          <div
            key={d.dow}
            className={`flex items-center justify-between gap-3 py-2.5 ${
              i > 0 ? "border-t border-line-2" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => toggleDay(d.dow)}
              aria-pressed={d.canTrain}
              className="flex flex-1 items-center gap-[10px] text-left"
            >
              <Check on={d.canTrain} />
              <span className={`text-[14px] font-medium ${d.canTrain ? "text-bone" : "text-muted"}`}>
                {DOW_LABEL[d.dow]}
              </span>
            </button>
            {d.canTrain ? (
              <button
                type="button"
                onClick={() => cycleDuration(d.dow)}
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

      <Field label="Check in with me on">
        <div className="grid grid-cols-7 gap-[5px]">
          {data.days.map((d) => (
            <button
              key={d.dow}
              type="button"
              onClick={() => set("checkinDow", d.dow)}
              aria-pressed={data.checkinDow === d.dow}
              className={`rounded-[12px] border py-2.5 font-mono text-[12px] ${
                data.checkinDow === d.dow
                  ? "border-sage bg-sage font-semibold text-ink"
                  : "border-line bg-card-2 text-muted"
              }`}
            >
              {DOW_SHORT[d.dow]}
            </button>
          ))}
        </div>
        <Hint>
          When we review the week and plan the next. Any day — a week does not have to start
          on Monday.
        </Hint>
      </Field>
    </>
  );
}

function StepActivities({ data, set }: { data: OnboardingInput; set: Setter }) {
  const [custom, setCustom] = useState("");

  function add(name: string) {
    const clean = name.trim();
    if (!clean) return;
    if (data.activities.some((a) => a.name.toLowerCase() === clean.toLowerCase())) return;
    set("activities", [...data.activities, { name: clean, dows: [], intensity: "moderate" }]);
    setCustom("");
  }

  function update(name: string, patch: Partial<ActivityInput>) {
    set(
      "activities",
      data.activities.map((a) => (a.name === name ? { ...a, ...patch } : a)),
    );
  }

  function remove(name: string) {
    set("activities", data.activities.filter((a) => a.name !== name));
  }

  function toggleDow(activity: ActivityInput, dow: number) {
    const has = activity.dows.includes(dow);
    update(activity.name, {
      dows: has ? activity.dows.filter((d) => d !== dow) : [...activity.dows, dow].sort(),
    });
  }

  const unpicked = COMMON_ACTIVITIES.filter(
    (c) => !data.activities.some((a) => a.name.toLowerCase() === c.toLowerCase()),
  );

  return (
    <>
      <Title
        title="Anything else you do?"
        sub="Sport and cardio outside the gym. This changes the plan: a hard Tuesday game means legs go elsewhere, and someone already running three times a week does not need conditioning added on top."
      />

      {data.activities.map((a) => (
        <div
          key={a.name}
          className="flex flex-col gap-3 rounded-[14px] border border-line bg-card p-3.5"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium text-bone">{a.name}</span>
            <button
              type="button"
              onClick={() => remove(a.name)}
              aria-label={`Remove ${a.name}`}
              className="px-2 font-mono text-[15px] leading-none text-muted"
            >
              ×
            </button>
          </div>

          <div className="flex flex-col gap-[6px]">
            <span className="font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-steel">
              Usually on
            </span>
            <div className="grid grid-cols-7 gap-[4px]">
              {[1, 2, 3, 4, 5, 6, 7].map((dow) => {
                const on = a.dows.includes(dow);
                return (
                  <button
                    key={dow}
                    type="button"
                    onClick={() => toggleDow(a, dow)}
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
            {a.dows.length === 0 && <Hint>Leave blank if it is irregular.</Hint>}
          </div>

          <div className="flex flex-col gap-[6px]">
            <span className="font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-steel">
              How hard
            </span>
            <Segmented
              options={INTENSITIES.map((i) => ({ value: i.value, label: i.label }))}
              value={a.intensity}
              onChange={(v) => update(a.name, { intensity: v as ActivityInput["intensity"] })}
            />
          </div>
        </div>
      ))}

      {unpicked.length > 0 && (
        <Field label={data.activities.length ? "Add another" : "What do you do?"}>
          <div className="flex flex-wrap gap-[7px]">
            {unpicked.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => add(name)}
                className="rounded-full border border-line bg-card-2 px-3 py-2 text-[12px] font-semibold text-muted"
              >
                + {name}
              </button>
            ))}
          </div>
        </Field>
      )}

      <Field label="Something else">
        <div className="flex gap-2">
          <input
            type="text"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(custom);
              }
            }}
            placeholder="Brazilian jiu-jitsu, hiking…"
            className="min-w-0 flex-1 rounded-[12px] border border-line bg-card-2 px-3 py-3 font-sans text-[14px] text-bone outline-none placeholder:text-steel/70"
          />
          <button
            type="button"
            onClick={() => add(custom)}
            disabled={!custom.trim()}
            className="shrink-0 rounded-[12px] border border-line px-4 font-sans text-[12px] font-bold uppercase tracking-[0.08em] text-muted disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </Field>

      <Hint>Skip this if the gym is the only training you do.</Hint>
    </>
  );
}

function StepLimits({
  data,
  set,
  library,
}: {
  data: OnboardingInput;
  set: Setter;
  library: LibraryEntry[];
}) {
  const [query, setQuery] = useState("");

  function toggle(name: string) {
    const has = data.excluded.includes(name);
    set("excluded", has ? data.excluded.filter((e) => e !== name) : [...data.excluded, name]);
  }

  function addCustom() {
    const clean = query.trim();
    if (!clean || data.excluded.includes(clean)) return;
    set("excluded", [...data.excluded, clean]);
    setQuery("");
  }

  // Search the whole library, not just the shortlist — a "won't do" list is personal and
  // is not limited to the handful of lifts we thought to offer.
  const q = query.trim().toLowerCase();
  const matches = q
    ? library
        .filter((e) => e.name.toLowerCase().includes(q) && !data.excluded.includes(e.name))
        .slice(0, 8)
    : [];
  const exactInLibrary = library.some((e) => e.name.toLowerCase() === q);

  const shortlist = COMMON_EXCLUSIONS.filter((n) => !data.excluded.includes(n));

  return (
    <>
      <Title title="Anything off limits?" sub="All optional — you can skip this." />

      <Field label="Won't do">
        {data.excluded.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-[7px]">
            {data.excluded.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                aria-label={`Allow ${name} again`}
                className="flex items-center gap-2 rounded-full border border-sage bg-sage px-3 py-2 text-[12px] font-semibold text-ink"
              >
                {name}
                <span aria-hidden="true" className="font-mono text-[13px] leading-none">
                  ×
                </span>
              </button>
            ))}
          </div>
        )}

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="Search your exercises, or type anything"
          className="w-full rounded-[12px] border border-line bg-card-2 px-3 py-3 font-sans text-[14px] text-bone outline-none placeholder:text-steel/70"
        />

        {matches.length > 0 && (
          <div className="flex flex-col overflow-hidden rounded-[12px] border border-line">
            {matches.map((e, i) => (
              <button
                key={e.name}
                type="button"
                onClick={() => {
                  toggle(e.name);
                  setQuery("");
                }}
                className={`flex items-baseline justify-between gap-3 bg-card-2 px-3 py-2.5 text-left ${
                  i > 0 ? "border-t border-line-2" : ""
                }`}
              >
                <span className="text-[13px] text-bone">{e.name}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-steel">
                  {e.muscleGroup}
                </span>
              </button>
            ))}
          </div>
        )}

        {q.length > 1 && !exactInLibrary && (
          <button
            type="button"
            onClick={addCustom}
            className="self-start rounded-full border border-dashed border-line px-3 py-2 text-[12px] font-semibold text-muted"
          >
            + Add &ldquo;{query.trim()}&rdquo;
          </button>
        )}

        {!q && shortlist.length > 0 && (
          <div className="flex flex-wrap gap-[7px]">
            {shortlist.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                className="rounded-full border border-line bg-card-2 px-3 py-2 text-[12px] font-semibold text-muted"
              >
                + {name}
              </button>
            ))}
          </div>
        )}

        <Hint>
          These are never programmed again. Anything you have already logged stays in your
          history.
        </Hint>
      </Field>

      <Field label="Injuries or anything long-standing">
        <textarea
          value={data.durableConstraints ?? ""}
          onChange={(e) => set("durableConstraints", e.target.value || null)}
          rows={4}
          placeholder="Left shoulder clicks on overhead pressing. Tried RDLs and did not get on with them."
          className="w-full rounded-[12px] border border-line bg-card-2 px-3 py-3 font-sans text-[14px] leading-relaxed text-bone placeholder:text-steel/70"
        />
        <Hint>
          Only things that stay true. Week-to-week niggles go in your check-in, so you never
          retype this.
        </Hint>
      </Field>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared controls
// ---------------------------------------------------------------------------

function Title({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="font-display text-[26px] font-semibold uppercase leading-[1.05] tracking-[-0.025em] text-bone">
        {title}
      </h1>
      <p className="text-[13px] leading-relaxed text-muted">{sub}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[7px]">
      <span className="font-sans text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] leading-relaxed text-muted">{children}</p>;
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative h-[19px] w-[19px] shrink-0 rounded-[6px] border-[1.5px] ${
        on ? "border-sage bg-sage" : "border-line"
      }`}
    >
      {on && (
        <span className="absolute inset-[4px_4px_5px_4px] -translate-y-px rotate-[-45deg] border-b-2 border-l-2 border-ink" />
      )}
    </span>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-[7px]" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-[12px] border px-2 py-3 font-sans text-[13px] font-semibold ${
            value === o.value
              ? "border-sage bg-sage text-ink"
              : "border-line bg-card-2 text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Radios({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: string; label: string; hint: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-[7px]">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            className={`flex items-start gap-[11px] rounded-[12px] border px-3 py-3 text-left ${
              on ? "border-sage/60 bg-sage/15" : "border-line bg-card-2"
            }`}
          >
            <span
              aria-hidden="true"
              className={`mt-[2px] h-[17px] w-[17px] shrink-0 rounded-full border-[1.5px] ${
                on ? "border-sage bg-[radial-gradient(circle,var(--sage)_0_45%,transparent_48%)]" : "border-line"
              }`}
            />
            <span className="flex flex-col gap-[2px]">
              <span className="text-[14px] font-medium text-bone">{o.label}</span>
              <span className="text-[12px] leading-snug text-muted">{o.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Feet and inches, as native selects.
 *
 * A native select renders as a scroll wheel on iOS, which is the right interaction for a
 * value with a small fixed range — and it avoids the "is 75 inches or centimetres?"
 * confusion a bare number field invites. Stored as total inches, which is what the
 * database and waist-to-height both want.
 */
function HeightPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const feet = value !== null ? Math.floor(value / 12) : null;
  const inches = value !== null ? value - Math.floor(value / 12) * 12 : null;

  function update(nextFeet: number | null, nextInches: number | null) {
    if (nextFeet === null) return onChange(null);
    onChange(nextFeet * 12 + (nextInches ?? 0));
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={feet === null ? "" : String(feet)}
        onChange={(v) => update(v === "" ? null : Number(v), inches)}
        placeholder="ft"
        options={[4, 5, 6, 7].map((f) => ({ value: String(f), label: `${f} ft` }))}
      />
      <Select
        value={inches === null ? "" : String(inches)}
        onChange={(v) => update(feet, v === "" ? 0 : Number(v))}
        placeholder="in"
        options={Array.from({ length: 12 }, (_, i) => ({
          value: String(i),
          label: `${i} in`,
        }))}
      />
      {value !== null && (
        <span className="shrink-0 font-mono text-[12px] tabular-nums text-steel">
          {value}&quot;
        </span>
      )}
    </div>
  );
}

/** Birth year as a select, newest first — most users are nearer the recent end. */
function YearPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 84 }, (_, i) => thisYear - 14 - i);
  return (
    <Select
      value={value === null ? "" : String(value)}
      onChange={(v) => onChange(v === "" ? null : Number(v))}
      placeholder="Year"
      options={years.map((y) => ({ value: String(y), label: String(y) }))}
    />
  );
}

function Select({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
}) {
  return (
    <div className="relative flex-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={placeholder}
        className="w-full appearance-none rounded-[12px] border border-line bg-card-2 px-3 py-3 pr-9 font-mono text-[16px] font-semibold tabular-nums text-bone outline-none"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-steel"
      >
        ▾
      </span>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  unit,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  unit?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 rounded-[12px] border border-line bg-card-2 px-3 py-3">
      <input
        type="text"
        inputMode="decimal"
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onChange(null);
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : null);
        }}
        className="w-full min-w-0 bg-transparent font-mono text-[17px] font-semibold tabular-nums text-bone outline-none placeholder:text-steel/60"
      />
      {unit && <span className="shrink-0 font-mono text-[11px] text-muted">{unit}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-step validation
// ---------------------------------------------------------------------------

/**
 * Only blocks on what the next step genuinely needs.
 *
 * Height and weight gate progress because plan generation cannot do anything sensible
 * without them. Sex, waist and the whole limits step do not — they are optional by design,
 * and blocking on optional fields is how a setup flow gets abandoned.
 */
function validateStep(step: number, d: OnboardingInput): string[] {
  const errors: string[] = [];

  if (step === 0) {
    if (d.heightIn === null) errors.push("Height is needed to set starting weights sensibly.");
    else if (d.heightIn < 36 || d.heightIn > 96) errors.push("Height should be in inches — 75 for 6'3\".");
    if (d.birthYear !== null && (d.birthYear < 1920 || d.birthYear > 2020)) {
      errors.push("Birth year looks wrong.");
    }
  }

  if (step === 1) {
    if (d.weightLbs === null) errors.push("Weight is needed to track progress.");
    else if (d.weightLbs < 50 || d.weightLbs > 700) errors.push("Weight should be in pounds.");
    if (d.waistIn !== null && (d.waistIn < 15 || d.waistIn > 80)) {
      errors.push("Waist should be in inches.");
    }
  }

  if (step === 2 && d.gymType !== "full" && d.equipment.length === 0) {
    errors.push("Pick at least one piece of equipment, so nothing unloadable gets programmed.");
  }

  if (step === 3 && d.goals.length === 0) {
    errors.push("Pick at least one goal — it decides what the plan optimises for.");
  }

  if (step === 4) errors.push(...crossFieldErrors(d));

  return errors;
}
