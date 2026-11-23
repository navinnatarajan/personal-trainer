import { describe, expect, it } from "vitest";

import { addDays, nextWeekStart, sanitiseError } from "./run-generation";

describe("sanitiseError", () => {
  it("redacts an Anthropic key", () => {
    const out = sanitiseError("401 invalid key sk-ant-api03-abc123DEF-xyz from upstream");
    expect(out).not.toContain("sk-ant-api03");
    expect(out).toContain("[redacted]");
  });

  it("redacts Supabase keys in both formats", () => {
    expect(sanitiseError("bad sb_secret_abc123 here")).toContain("[redacted]");
    expect(sanitiseError("bad sb_publishable_abc123 here")).toContain("[redacted]");
    expect(sanitiseError("jwt eyJhbGciOi.eyJzdWIi.sigpart failed")).toContain("[redacted]");
  });

  it("keeps the useful part of the message", () => {
    const out = sanitiseError("Rate limit exceeded, retry after 30s");
    expect(out).toBe("Rate limit exceeded, retry after 30s");
  });

  it("collapses whitespace and truncates, so a huge upstream body cannot fill the column", () => {
    const out = sanitiseError("a\n\n  b" + " x".repeat(600));
    expect(out).toContain("a b");
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe("nextWeekStart", () => {
  // The week a plan covers must come from the user's local date. toISOString() is UTC and
  // returns tomorrow between local midnight and UTC midnight, which would plan the wrong
  // week entirely — the same class of bug that once dropped a session from the history.
  it("returns the coming Monday from a midweek day", () => {
    // Wed 18 Nov 2026, 10:00 New York
    expect(nextWeekStart("America/New_York", new Date("2026-11-18T15:00:00Z"))).toBe(
      "2026-11-23",
    );
  });

  it("returns today when today is Monday", () => {
    expect(nextWeekStart("America/New_York", new Date("2026-11-23T15:00:00Z"))).toBe(
      "2026-11-23",
    );
  });

  it("returns tomorrow when today is Sunday", () => {
    expect(nextWeekStart("America/New_York", new Date("2026-11-22T15:00:00Z"))).toBe(
      "2026-11-23",
    );
  });

  it("uses the local date late in the evening, not the UTC one", () => {
    // 23:30 Sunday 22 Nov in New York is already Monday 23 Nov in UTC.
    // Local Sunday means the coming Monday is the 23rd; using UTC would give the 30th.
    const lateSunday = new Date("2026-11-23T04:30:00Z");
    expect(nextWeekStart("America/New_York", lateSunday)).toBe("2026-11-23");
  });

  it("respects a timezone ahead of UTC", () => {
    // 20:00 UTC Sunday is already Monday in Kolkata, so that week has started.
    expect(nextWeekStart("Asia/Kolkata", new Date("2026-11-22T20:00:00Z"))).toBe(
      "2026-11-23",
    );
  });
});

describe("addDays", () => {
  it("adds across a month boundary", () => {
    expect(addDays("2026-11-30", 6)).toBe("2026-12-06");
  });

  it("adds across a year boundary", () => {
    expect(addDays("2026-12-28", 6)).toBe("2027-01-03");
  });

  it("is a no-op for zero", () => {
    expect(addDays("2026-11-23", 0)).toBe("2026-11-23");
  });
});
