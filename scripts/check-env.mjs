#!/usr/bin/env node
/**
 * Validates .env.local without printing secret values.
 *
 * Catches the failures that otherwise surface as a confusing 401 or a silent
 * misconfiguration: a value left as a placeholder, wrapping quotes, stray whitespace,
 * a truncated paste, or the service_role key accidentally given a NEXT_PUBLIC_ name.
 *
 * Usage: node scripts/check-env.mjs [path]
 */

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? ".env.local";

/** @type {Array<{key: string, required: boolean, secret: boolean, check?: (v: string) => string | null}>} */
const SPEC = [
  {
    key: "NEXT_PUBLIC_SUPABASE_URL",
    required: true,
    secret: false,
    check: (v) =>
      /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(v)
        ? null
        : "expected https://<project-ref>.supabase.co",
  },
  {
    key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    required: true,
    secret: true,
    check: (v) =>
      /^(eyJ[\w-]+\.[\w-]+\.[\w-]+|sb_publishable_[\w-]+)$/.test(v)
        ? null
        : "expected a JWT starting eyJ, or sb_publishable_...",
  },
  {
    key: "SUPABASE_SERVICE_ROLE_KEY",
    required: true,
    secret: true,
    check: (v) =>
      /^(eyJ[\w-]+\.[\w-]+\.[\w-]+|sb_secret_[\w-]+)$/.test(v)
        ? null
        : "expected a JWT starting eyJ, or sb_secret_...",
  },
  {
    key: "ANTHROPIC_API_KEY",
    required: true,
    secret: true,
    check: (v) =>
      v.startsWith("sk-ant-") ? null : "expected a key starting sk-ant-",
  },
  { key: "GOOGLE_CLIENT_ID", required: false, secret: false },
  { key: "GOOGLE_CLIENT_SECRET", required: false, secret: true },
  { key: "HEALTH_INGEST_SECRET", required: false, secret: true },
];

const PLACEHOLDERS = [/^x+$/i, /xxxx/, /^your[-_ ]/i, /^<.*>$/, /^changeme$/i];

let raw;
try {
  raw = readFileSync(path, "utf8");
} catch {
  console.error(`✗ Cannot read ${path}`);
  console.error(`  Create it with: cp .env.example .env.local`);
  process.exit(1);
}

// Parse, keeping the raw right-hand side so formatting problems stay visible.
/** @type {Map<string, {rawValue: string, line: number}>} */
const parsed = new Map();
raw.split("\n").forEach((line, i) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;
  const eq = line.indexOf("=");
  if (eq === -1) return;
  parsed.set(line.slice(0, eq).trim(), {
    rawValue: line.slice(eq + 1),
    line: i + 1,
  });
});

/** Shows enough to confirm identity, never enough to use. */
function mask(value, secret) {
  if (!secret) return value;
  const head = value.slice(0, 7);
  return `${head}…(${value.length} chars)`;
}

const problems = [];
const warnings = [];

for (const { key, required, secret, check } of SPEC) {
  const entry = parsed.get(key);

  if (!entry || entry.rawValue.trim() === "") {
    if (required) problems.push(`${key} — missing or empty`);
    else console.log(`  ·  ${key.padEnd(30)} (empty, expected for now)`);
    continue;
  }

  const rawValue = entry.rawValue;
  const value = rawValue.trim();
  const loc = `line ${entry.line}`;

  // Formatting problems, checked before content so the message is actionable.
  if (rawValue !== rawValue.trimEnd()) {
    problems.push(`${key} — trailing whitespace (${loc}); it becomes part of the value`);
    continue;
  }
  if (rawValue.startsWith(" ")) {
    problems.push(`${key} — space after '=' (${loc}); remove it`);
    continue;
  }
  if (/^["'].*["']$/.test(value)) {
    problems.push(`${key} — wrapped in quotes (${loc}); remove them`);
    continue;
  }
  if (PLACEHOLDERS.some((p) => p.test(value))) {
    problems.push(`${key} — still a placeholder (${loc})`);
    continue;
  }

  const err = check?.(value);
  if (err) {
    problems.push(`${key} — ${err} (${loc})`);
    continue;
  }

  console.log(`  ✓  ${key.padEnd(30)} ${mask(value, secret)}`);
}

// The one mistake gitignore cannot protect against: NEXT_PUBLIC_ ships to the browser.
for (const key of parsed.keys()) {
  if (/^NEXT_PUBLIC_/.test(key) && /SERVICE_ROLE|SECRET|ANTHROPIC/i.test(key)) {
    problems.push(
      `${key} — a secret must never use the NEXT_PUBLIC_ prefix; it is compiled into the browser bundle`,
    );
  }
}

// Cross-check: the anon and service_role keys must differ.
const anon = parsed.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")?.rawValue.trim();
const service = parsed.get("SUPABASE_SERVICE_ROLE_KEY")?.rawValue.trim();
if (anon && service && anon === service) {
  problems.push(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are identical — one was pasted twice",
  );
}

// The project ref in the URL should match the one embedded in a JWT-style anon key.
const url = parsed.get("NEXT_PUBLIC_SUPABASE_URL")?.rawValue.trim();
if (url && anon?.startsWith("eyJ")) {
  try {
    const claims = JSON.parse(Buffer.from(anon.split(".")[1], "base64").toString());
    const urlRef = url.match(/^https:\/\/([a-z0-9-]+)\./)?.[1];
    if (claims.ref && urlRef && claims.ref !== urlRef) {
      problems.push(
        `NEXT_PUBLIC_SUPABASE_URL and the anon key belong to different projects (${urlRef} vs ${claims.ref})`,
      );
    }
    if (claims.role && claims.role !== "anon") {
      problems.push(
        `NEXT_PUBLIC_SUPABASE_ANON_KEY has role "${claims.role}", expected "anon" — the wrong key may be pasted here`,
      );
    }
  } catch {
    warnings.push("Could not decode the anon key's claims; skipped the project-match check");
  }
}
if (service?.startsWith("eyJ")) {
  try {
    const claims = JSON.parse(Buffer.from(service.split(".")[1], "base64").toString());
    if (claims.role && claims.role !== "service_role") {
      problems.push(
        `SUPABASE_SERVICE_ROLE_KEY has role "${claims.role}", expected "service_role"`,
      );
    }
  } catch {
    warnings.push("Could not decode the service_role key's claims");
  }
}

console.log();
for (const w of warnings) console.log(`  !  ${w}`);

if (problems.length) {
  console.log(`\n✗ ${problems.length} problem${problems.length > 1 ? "s" : ""}:\n`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

console.log("✓ .env.local looks good.");
