import { z } from "zod";

/**
 * What onboarding collects, as one validated object.
 *
 * Shared by the client (step validation) and the Server Action (authoritative check).
 * Server Functions are reachable by direct POST, not only through the UI, so the server
 * re-validates everything regardless of what the form enforced.
 */

export const GOALS = [
  { value: "lose_body_fat", label: "Lose body fat", hint: "Get leaner, see definition" },
  { value: "v_taper", label: "V-taper", hint: "Shoulder and back width" },
  { value: "build_muscle", label: "Build muscle", hint: "Size and visible definition" },
  { value: "build_strength", label: "Build strength", hint: "Move heavier weight" },
  { value: "build_endurance", label: "Build endurance", hint: "Last longer, recover faster" },
] as const;

export const SPLITS = [
  {
    value: "push_pull_legs",
    label: "Push / Pull / Legs",
    hint: "Separate days. Wants three or four sessions a week.",
  },
  {
    value: "upper_lower",
    label: "Upper / Lower",
    hint: "Alternating. Works well on two or three days.",
  },
  {
    value: "full_body",
    label: "Full body",
    hint: "Every session hits a push, a pull and a leg movement. Good for building the habit.",
  },
  {
    value: "coach_decides",
    label: "Let the coach decide",
    hint: "Chosen from your goals and the days you have.",
  },
] as const;

export const GYM_TYPES = [
  { value: "full", label: "Full gym", hint: "Racks, machines, cables — the usual commercial setup" },
  { value: "limited", label: "Limited setup", hint: "Some of it. I'll tell you what's there" },
  { value: "home_basics", label: "Home, basics only", hint: "Dumbbells, a bench, maybe bands" },
] as const;

export const EQUIPMENT = [
  "Barbell & rack",
  "Dumbbells",
  "Cables",
  "Machines",
  "Leg press",
  "Hack squat",
  "Pull-up bar",
  "Kettlebells",
  "Bands",
  "Bench",
] as const;

export const TRAINING_LEVELS = [
  { value: "beginner", label: "Just starting", hint: "Under 6 months — we'll start light and find your weights" },
  { value: "novice", label: "A while now", hint: "6 months to 2 years" },
  { value: "intermediate", label: "Experienced", hint: "2+ years, I know my numbers" },
  { value: "advanced", label: "Very experienced", hint: "Years of structured training" },
] as const;

/** Common exclusions offered as chips. Free text covers the rest. */
export const COMMON_EXCLUSIONS = [
  "Deadlifts",
  "Romanian Deadlift (DB)",
  "Barbell squats",
  "Hack Squat",
  "DB Shoulder Press",
  "Pull-Up",
  "Flat Bench (BB)",
] as const;

const DayPrefSchema = z.object({
  dow: z.number().int().min(1).max(7),
  canTrain: z.boolean(),
  /** Null when the day is off. Range matches the database constraint. */
  durationMin: z.number().int().min(5).max(300).nullable(),
});

export const OnboardingSchema = z.object({
  // --- identity: asked once, never again ---
  sex: z.enum(["male", "female", "prefer_not_to_say"]).nullable(),
  heightIn: z.number().min(36).max(96).nullable(),
  birthYear: z.number().int().min(1920).max(2020).nullable(),

  // --- where they are now ---
  weightLbs: z.number().min(50).max(700).nullable(),
  waistIn: z.number().min(15).max(80).nullable(),
  trainingLevel: z.enum(["beginner", "novice", "intermediate", "advanced"]),

  // --- environment ---
  gymType: z.enum(["full", "limited", "home_basics"]),
  /** Only meaningful for a limited setup; a full gym implies everything. */
  equipment: z.array(z.string()).max(40),
  stylePreference: z.enum(["machines", "mix", "free_weights"]),

  // --- goals, in priority order ---
  goals: z
    .array(z.enum(["lose_body_fat", "v_taper", "build_muscle", "build_strength", "build_endurance"]))
    .min(1, "Pick at least one goal")
    .max(3, "Three goals at most — more than that and nothing is a priority"),
  splitPreference: z.enum(["push_pull_legs", "upper_lower", "full_body", "coach_decides"]),

  // --- the week ---
  days: z.array(DayPrefSchema).length(7),
  checkinDow: z.number().int().min(1).max(7),

  // --- limits ---
  excluded: z.array(z.string()).max(60),
  durableConstraints: z.string().max(2000).nullable(),
});

export type OnboardingInput = z.infer<typeof OnboardingSchema>;

/**
 * Checks that cannot be expressed in the schema itself.
 *
 * Kept separate from Zod so the messages can be specific about what to do, rather than
 * "invalid input". Returned as a list so a step can show every problem at once.
 */
export function crossFieldErrors(input: OnboardingInput): string[] {
  const errors: string[] = [];

  const training = input.days.filter((d) => d.canTrain);
  if (training.length === 0) {
    errors.push("Pick at least one day you can train.");
  }
  for (const d of training) {
    if (d.durationMin === null) {
      errors.push(`Set how long you have on ${DOW_LABEL[d.dow]}.`);
    }
  }

  // push/pull/legs genuinely needs the days to work; saying so beats generating a
  // compromised week and letting the user wonder why it looks odd.
  if (input.splitPreference === "push_pull_legs" && training.length < 3) {
    errors.push(
      "Push / Pull / Legs needs at least three training days. Pick another day, or choose Upper / Lower or Full body.",
    );
  }
  if (input.splitPreference === "upper_lower" && training.length < 2) {
    errors.push("Upper / Lower needs at least two training days.");
  }

  if (input.gymType !== "full" && input.equipment.length === 0) {
    errors.push("Tell us what equipment you have, so nothing gets programmed that you cannot load.");
  }

  return errors;
}

export const DOW_LABEL: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

export const DOW_SHORT: Record<number, string> = {
  1: "Mo",
  2: "Tu",
  3: "We",
  4: "Th",
  5: "Fr",
  6: "Sa",
  7: "Su",
};

/** Duration options offered per day. */
export const DURATIONS = [20, 30, 45, 60, 90] as const;
