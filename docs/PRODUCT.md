# Product guide

What Saturday Fitness is, who it's for, and the reasoning behind how it works. For the
technical picture see [`DEVELOPERS.md`](DEVELOPERS.md); for individual judgement calls and
the two corrections we've made, [`DECISIONS.md`](DECISIONS.md).

---

## The problem

For people who are already motivated, getting stronger is mostly a logistics problem. The
hard parts aren't willpower:

1. **What am I doing at the gym today?**
2. **How does progressive overload actually work** — when do I add weight, and how much?
3. **How do I change the plan** when basketball moves or I'm travelling?
4. Tracking calories.
5. Seeing it all together with sleep and steps.

Individual tools exist for each. None of them join up, and the joining-up is the work.

## Where this came from

This isn't a greenfield idea. It replaces a workflow that already ran for weeks and
produced real results — it was just spread across three places:

- A **Claude chat** doing a Sunday check-in: review last week, take next week's
  constraints, write a plan
- A **hand-generated HTML tracker** per week, used at the rack to tick off sets
- An **Excel file** holding history, updated by copy-pasting a recap back into the chat

The method worked. The friction was the three surfaces and the copy-paste between them.
**Saturday Fitness is that loop collapsed into one app** — which is why the original
tracker and spreadsheet are treated as specifications rather than inspiration.

### What the old setup got right, and we kept

- **Double progression**, stated plainly and applied without exception
- **Coaching notes that carry history** — *"You've been 8/7/6 here for weeks. Beat the
  third set. That is the entire job of this session."* A generic app cannot write that
- **A logging screen built for a phone held in one chalky hand** — big tap targets,
  pre-filled weights, per-exercise rest timers
- **Honest assumptions** — the meal log recorded what it had guessed and why

### What it got wrong, and we fixed

- **Timing was inferred from set ticks.** Start was the first set ticked, end was
  overwritten on every subsequent tick. A "22 minute session" actually meant *time between
  first and last logged set* — no warmup, ending at the last tick rather than when you
  left, and ballooning silently if a set went unlogged.
- **Everything lived in `localStorage`**, so a closed tab lost the session.
- **"Copy for Claude"** — the button that existed only because the pieces weren't joined.

---

## Who it's for

**Now:** the author plus three friends. Explicitly not a scale problem — four users, a free
Supabase tier, roughly $5/month of API spend.

**The user it suits:** someone already accountable who wants the logistics to disappear.
Not someone who needs motivating. That shapes the tone — the app is a competent training
partner, not a cheerleader.

**Success looks like:** *"I stopped opening the spreadsheet."*

---

## How it works

### Three tabs

| Tab | Job |
|---|---|
| **Lift** | Today's session. Opened in the gym doorway; get to the first set without reading |
| **Plan** | This week's progress mid-week; close the week and build the next on check-in day |
| **Review** | Am I actually getting stronger — months, not weeks |

The coach has **no tab**. Every high-value question happens in context — *"my shoulder's
cranky, swap the presses"* while looking at today's session, *"basketball moved"* while
looking at the week. A separate chat tab forces the user to leave that context and rebuild
it by typing, and invites low-value chat. There is an **Ask** affordance on Lift and Plan,
pre-loaded with what is on screen.

### The weekly loop

```
check-in day  →  review last week  →  constraints for next  →  plan generated  →  review
     ↑                                                                               │
     └──────────────────  train, log sets, adjust mid-week  ←──────────────────────── ┘
```

The **Plan tab works mid-week**, not only on check-in day. Opened on a Wednesday it shows
where you stand and lets you move what's left — because that is what actually happens when
basketball reschedules. A check-in-only screen would be dead six days a week.

### Where the intelligence actually is

Deliberately split:

**Code decides what is deterministic.** Progressive overload is a rule, not a judgement
call. `lib/progression.ts` computes, per exercise, whether every working set hit the top of
its range, and therefore whether weight goes up. Unit-tested, and the model cannot
silently get it wrong.

**The model does what needs judgement.** Exercise selection within constraints, fitting
sessions into a time budget, supersets, which lift to flag, and the coaching notes.

This split is the reason the app can be trusted with numbers *and* feel like a coach.

---

## Knowing the user — the central problem

The complaint that motivated this: another AI trainer *"didn't really know me at all, was
just giving something based on initial context, and wasn't evolving with me."*

That is the **default outcome**, not a bug in that product. The Claude API is stateless —
it remembers nothing between calls. Send profile plus goal, receive plan, and it is generic
because it *is* generic. Everything that makes this different is the context assembled on
every call.

### The seven layers

Organised by **how each is maintained**, which is what matters operationally:

| Layer | Maintained by | Examples |
|---|---|---|
| Identity | Asked once | sex, birth year, height |
| Environment | Asked once, user updates | gym type, equipment |
| Standing preferences | Asked once + consolidated from behaviour | won't-do list, machines vs free weights |
| Measured state | Logged on a cadence | weight, waist |
| **Derived state** | **Never asked — computed** | real frequency, true session length, missed days |
| Goals | Asked once, reviewed, **ordered** | priority list plus the trade-off |
| **Episodic** | **Written by the system** | last week's plan, unmet instructions |

The two starred layers are where most products fail.

**Derived** matters because stated and observed behaviour always diverge. Asked how often
he trains, the author would say four days a week. His logs say **2.2**. An assistant that
uses the stated figure is agreeing with a self-image rather than responding to a life.

**Episodic** is what "evolving with me" actually means mechanically:

> Week 4: *"Beat the third set on pulldowns — that is the entire job."*
> Week 5: 12/12/10. Unmet.
> Week 6: 12/12/10. **Unmet again.**

A coach that cannot see its own unmet instruction writes it a third time, and that third
repetition is precisely when a user concludes the thing isn't listening. Seeing it forces
escalation: change the lift, drop a set, move it first while fresh.

### The consolidation loop, and why it is not automatic

Conversation has to update the stored profile, or the user ends up repeating themselves —
which is the felt experience of not being known. But it cannot be silent:

- **Over-persisting.** *"My shoulder hurts today"* is transient. *"Presses always aggravate
  my shoulder"* is durable. Mis-classify and pressing disappears permanently over one bad
  night's sleep.
- **Silent updates** lose trust differently — now it knows you *wrong*, invisibly.

So: **extract → propose → confirm.** The model proposes changes; the user sees them.
*"You've mentioned the shoulder twice now — should I stop programming overhead presses?"*

That confirmation does double duty. It prevents drift, **and it is the moment the memory
becomes visible.** Silent correctness feels like nothing; visible recall feels like being
known.

Consolidation runs **at the weekly check-in**, not after every session — the user is
already in a reflective frame, and per-session prompting would fatigue them.

---

## Deliberate omissions

Things a fitness app would normally have, left out on purpose.

**Total volume.** It was on the first dashboard draft and removed. Not actionable — you
can't do anything differently on Tuesday because volume was 120,285 lbs — and it's
gameable, since adding an exercise raises it while feeling like progress. Replaced with
"2 of 4 sessions", which tells you whether you're behind.

**BMI.** Misclassifies anyone tall carrying muscle, which is exactly the user. Worse as a
*goal*, where it would have the model recommend losing weight the user wants. Replaced with
**waist-to-height** — under 0.5 is the common lean threshold, and it tracks visceral fat
without punishing height.

**Ethnicity.** Considered, and rejected. The evidence isn't nothing — South Asian
populations carry more visceral fat at equivalent BMI, which is why the WHO uses lower
thresholds for Asian populations. But it is a weak proxy for something measurable
directly (waist, body fat %), there is no evidence base for ethnicity-based *programming*,
and handing a sensitive attribute to a model as free context invites generalisation that
cannot be audited. Measure the thing instead.

**Body fat %.** Wanted, deferred. Photo-based estimates carry roughly ±3–4% error, wider
than a month's real change — it would read as noise, not progress. Waits for a method that
can actually measure it.

**Voice input.** Deferred to post-v1, including the free-text step. Onboarding runs *once
per user*; set logging runs thousands of times. If voice is built, it belongs at the rack
— *"one twenty, twelve"* with chalky hands mid-rest — not in a flow executed four times.

**Core work as a route to the v-taper.** Core movements exist in the library and appear as
finishers, but they are not sold as shaping the waist. The V is shoulder width divided by
waist width: shoulders are trainable, and the waist comes from fat loss. Core training
builds muscle under the fat without shrinking the circumference, and heavy oblique work can
marginally thicken it. The prompt says this explicitly so the plan never implies otherwise.

**Average session duration.** Absent from the dashboard until there is data. All 11
imported sessions have null duration because they were never timed, and we chose not to
invent them. The tile earns its place after a week on the real timer.

**A marketing landing page.** Designed early, then dropped from scope. It serves strangers;
there are four known users.

---

## Design

Dark only, built on **Ink `#0C1014`**. The palette came from the author, and its roles are
unusually specific — colour encodes meaning rather than decorating:

| | | |
|---|---|---|
| **Sage** `#CFD5B4` | Primary | Today's session, primary actions, active nav |
| **Mist** `#7F9BA0` | Secondary | Push · Pull · Arms days, progress |
| **Clay** `#D08A6B` | Secondary | Legs days, rest timer, *hold the weight* |
| **Moss** `#7FA06A` | Secondary | Completed sets, **earned** increases |

Neutrals: Surface `#141A20`, Line `#2B353D`, Muted `#9BA39C`, Bone `#DEDECB`.

**Hanken Grotesk** for everything, **IBM Plex Mono for digits only** — weights and reps
need to line up down a column and a rest timer must not jitter as it counts.

Sage appears **exactly once per screen**, on the next action. Two Sage elements and neither
reads as the next thing to do.

The Moss/Clay distinction carries the single most important idea in the product: **earned
versus hold.** Cable Row at 100 × 10/10/10 cleared every set, so 102.5 is Moss. Lat
Pulldown at 120 × 12/12/10 fell short on the third, so it holds at 120 in Clay. That
distinction is what the spreadsheet existed to track.

Current screens live in [`design/screens.html`](design/screens.html), published as an
artifact and updated as decisions land.

### Copy

No jargon before its definition. The calibration week says **"2 left in tank"**, never
"2 RIR" — the abbreviation is only ever needed in week one, so it never has to be taught.

Consequences get named rather than hidden. Closing a week says *which* sessions get marked
missed and that they stop counting toward progression, instead of *"are you sure?"*.

---

## Onboarding

Six steps, five of them under twenty seconds. It asks for **less** than the model consumes,
because two layers are computed rather than asked.

1. **About you** — sex, height, birth year
2. **Where you are now** — weight, waist, how long you've been lifting
3. **Your gym** — type, plus machines/mix/free-weights lean. Equipment checklist shown
   *only* for limited setups, because a full-gym user ticking eight boxes conveys nothing
   and nobody recalls their gym's inventory anyway
4. **Goals** — up to three, **ranked**, with the conflict named on screen, plus the
   **split preference**: push/pull/legs, upper/lower, full-body, or let the coach decide
5. **Your week** — days, per-day duration, and the check-in day
6. **Anything off limits** — won't-do list and durable constraints. Skippable

Then a seventh screen that isn't a question: **"Week one finds your weights."**

### Session shape

Every session follows the same shape, enforced by the validator rather than hoped for:
**one or two compounds first**, then one to three accessories, then optionally one core
movement as a finisher. Warmup time is reserved *inside* the budget, never added to it —
previously a 30-minute plan meant 40 minutes in practice.

The split preference shapes which sessions exist before any exercise is chosen. Full-body
is offered for beginners on purpose — one push, one pull and one leg compound per session
means higher frequency per muscle group and more practice per movement, and it still works
when only two sessions actually happen.

Anchor lifts are a stronger thing than a favourite: a lift the user treats as
non-negotiable, which must appear at least twice a week. Usually it is whatever is most
tied to their stated goal, and a single appearance quietly works against what they are
training for.

### Why week one is calibration

Every starting weight we could recommend is a guess. Rather than hide that behind a
confident number, week one prescribes **reps with two left in the tank** and lets the user
find the weight — which then *becomes* the baseline.

This solves the beginner problem without a recommendation engine, and it needed no code:
`progressionState` already returns `establish_baseline` for any lift with no history. It is
also the honest framing — too light costs one session; too heavy costs an injury.

### Equipment self-corrects

Beyond asking, every prescribed exercise carries a **"my gym doesn't have this"** action
that writes back to the profile. This is how the library grew in reality — Chest Press
(Hammer) and Tricep Extension (Machine) both appeared weeks into the imported history, as
the author explored his gym.

---

## Roadmap

**Phase 0 — foundation** ✅ Auth, schema, imported history, progression and timing logic,
design settled.

**Phase 1 — the loop.** Onboarding, check-in, plan generation, session logger, dashboard,
contextual coach. *Ship and use for two weeks before anything else.* If the loop works the
product is proven; if it doesn't, nothing else would have saved it.

**Phase 2 — health data.** A web app cannot read Apple Health or Health Connect directly —
both are on-device only, Google Fit's REST API is gone, and the legacy Fitbit Web API was
decommissioned in September 2026. Aggregators start around $300–400/month, indefensible for
four users. So `HealthProvider` is an interface with three implementations, cheapest first:
manual entry at check-in, an iOS Shortcuts automation posting to a webhook (free, no native
app), and the Google Health API.

**Phase 3 — calorie tracking.** Photo plus description → vision → meal log. Deferred from
the start, and correctly: the author eats reasonably well, so it was never the binding
constraint.

**Later:** voice logging at the rack, add-to-calendar, a native wrapper.
