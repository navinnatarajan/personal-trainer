# Feedback log

Observations from using the app, with what each turned out to mean. Kept separate from
`DECISIONS.md`: this is raw input and diagnosis, that is settled reasoning.

---

## 2026-11-23 — first production session

Seven items from signing in and generating a week on the deployed app.

### 1. Buttons do not read as buttons
The text blends into the background, so it is not obvious they are tappable.

**Diagnosis:** partly real, partly a side effect of the local build failing to download
fonts — but the secondary buttons genuinely are low-contrast outlines with muted text.
The primary Sage button is fine; everything else reads as a label.

### 2. The generating screen is dull
Wants a progress bar with quotes, and an animation — suggested a figure attempting a
powerlift, synced to progress.

**Diagnosis:** the progress bar and staged copy already exist; what is missing is
personality and motion. Worth noting the constraint: progress is driven by *elapsed time
against a measured ~70s average*, not by real completion, so any animation must not imply
precision the number does not have.

### 3. The stored context is stale, and there is no way to fix it
The coach still believes basketball happens on Tuesdays. That stopped being true after the
ankle fracture. Two asks: a way to run onboarding as a new user would see it, and a way to
paste in current context from a Claude conversation.

**Diagnosis — this is the most important item.** `user_activities` still holds
`Basketball [Tue] hard` and `Volleyball [Thu] hard`, and `durable_constraints` still says
*"no explosive movements/running for the next 1 month"* — written on 31 October, so now
expired. **There is no profile editing anywhere in the app.** Onboarding writes once and
nothing can change it afterwards, which guarantees the context goes stale and the coach
gets worse over time. This is the gap the consolidation loop was meant to close and it has
not been built.

### 4. No navigation to profile or other pages
Wants navigational cues even if greyed out.

**Diagnosis:** a tab bar landed the same day (Lift / Plan / Review), but there is no route
to a profile or settings at all — because no such page exists. Related to #3: the
navigation is missing because the destination is missing.

### 5. No way to sign out
**Diagnosis:** correct, and it is a regression. The `signOut` action exists and was wired
into the old placeholder home, which was replaced by the Lift screen without carrying it
over.

### 6. Plan review is one long scroll
Wants to tap into a specific day rather than scrolling the whole week.

**Diagnosis:** fair. Four sessions with every exercise and coaching note expanded is a
wall on a phone. The designs called for one day open and the rest collapsed; the built
version expands all of them.

### 7. The recommendation was wrong, and the week note is hard to read
Only three training days were scheduled. The user's actual availability is Wednesday,
Friday, Saturday and Sunday, with **Tuesday now being physiotherapy**.

**Diagnosis — two separate problems.**

*The data is wrong.* `day_preferences` holds Mon 30, Tue 30, Wed off, Thu 30, Fri 30,
Sat 60, Sun off — which is neither what the user wants now nor what they described. The
model scheduled Tue/Fri/Sat from that stale set. **The model was not given a chance to get
this right**, and no amount of prompt work fixes a wrong input. Same root cause as #3.

*The note is a wall of text.* The week note is a single long paragraph set at body size
with no breaks. It carries the reasoning that makes the plan feel considered, and it is
the thing most likely to go unread in that form.

---

## Themes

Three of the seven (#3, #4, #7) are the same gap wearing different clothes: **the profile
can be written once and never edited.** Everything downstream degrades from there —
activities that no longer happen, constraints that have expired, availability that is
simply wrong.

Two (#1, #6) are presentation: affordance and density.

One (#2) is delight.

One (#5) is a regression introduced by replacing the placeholder home.
