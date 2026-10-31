"use client";

import { useState, useTransition } from "react";

import { completeOnboarding } from "./actions";
import {
  COMMON_EXCLUSIONS,
  DOW_LABEL,
  DOW_SHORT,
  DURATIONS,
  EQUIPMENT,
  GOALS,
  GYM_TYPES,
  SPLITS,
  TRAINING_LEVELS,
  crossFieldErrors,
  type OnboardingInput,
} from "./schema";

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
}: {
  initial: OnboardingInput;
  firstName: string | null;
  returning: boolean;
}) {
  const [data, setData] = useState<OnboardingInput>(initial);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof OnboardingInput>(key: K, value: OnboardingInput[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  const needsEquipment = data.gymType !== "full";
  const steps = ["You", "Now", "Gym", "Goals", "Week", "Limits"];
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
        {step === 5 && <StepLimits data={data} set={set} />}
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

      <div className="grid grid-cols-2 gap-3">
        <Field label="Height">
          <NumberInput
            value={data.heightIn}
            onChange={(v) => set("heightIn", v)}
            unit="in"
            placeholder="75"
          />
          <Hint>6&apos;3&quot; is 75</Hint>
        </Field>
        <Field label="Born">
          <NumberInput
            value={data.birthYear}
            onChange={(v) => set("birthYear", v)}
            placeholder="1990"
          />
          <Hint>Affects recovery</Hint>
        </Field>
      </div>
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

  function move(goal: Goal, dir: -1 | 1) {
    const i = data.goals.indexOf(goal);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= data.goals.length) return;
    const next = [...data.goals];
    [next[i], next[j]] = [next[j], next[i]];
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

      <div className="flex flex-col gap-[7px]">
        {GOALS.map((g) => {
          const rank = data.goals.indexOf(g.value as Goal);
          const on = rank >= 0;
          return (
            <div
              key={g.value}
              className={`flex items-center gap-3 rounded-[12px] border px-3 py-3 ${
                on ? "border-sage/55 bg-sage/12" : "border-line bg-card-2"
              }`}
            >
              <button
                type="button"
                onClick={() => toggle(g.value as Goal)}
                aria-pressed={on}
                className="flex flex-1 items-center gap-3 text-left"
              >
                <span
                  className={`w-5 shrink-0 text-center font-mono text-[13px] font-semibold ${
                    on ? "text-sage" : "text-line"
                  }`}
                >
                  {on ? rank + 1 : "—"}
                </span>
                <span className="flex flex-col">
                  <span className="text-[14px] font-medium text-bone">{g.label}</span>
                  <span className="text-[11px] text-muted">{g.hint}</span>
                </span>
              </button>
              {on && (
                <span className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => move(g.value as Goal, -1)}
                    disabled={rank === 0}
                    aria-label={`Move ${g.label} up`}
                    className="px-2 font-mono text-[11px] text-muted disabled:opacity-25"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => move(g.value as Goal, 1)}
                    disabled={rank === data.goals.length - 1}
                    aria-label={`Move ${g.label} down`}
                    className="px-2 font-mono text-[11px] text-muted disabled:opacity-25"
                  >
                    ▼
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

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

function StepLimits({ data, set }: { data: OnboardingInput; set: Setter }) {
  function toggle(name: string) {
    const has = data.excluded.includes(name);
    set("excluded", has ? data.excluded.filter((e) => e !== name) : [...data.excluded, name]);
  }

  return (
    <>
      <Title title="Anything off limits?" sub="All optional — you can skip this." />

      <Field label="Won't do">
        <div className="flex flex-wrap gap-[7px]">
          {COMMON_EXCLUSIONS.map((name) => {
            const on = data.excluded.includes(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                aria-pressed={on}
                className={`rounded-full border px-3 py-2 text-[12px] font-semibold ${
                  on ? "border-sage bg-sage text-ink" : "border-line bg-card-2 text-muted"
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
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
          placeholder="Left shoulder clicks on overhead pressing. Play basketball Tuesdays, so legs the day after is rough."
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
