@AGENTS.md

# Saturday Fitness

Start with `docs/DEVELOPERS.md` (how it works) and `docs/PRODUCT.md` (why it works that
way). `docs/DECISIONS.md` holds the reasoning behind every non-obvious call, including two
recorded corrections — read it before re-litigating anything.

## Standing rules

**Keep the docs current in the same commit as the change.** Documentation written later is
a reconstruction.

| Changed | Update |
|---|---|
| Schema, scripts, structure, conventions | `docs/DEVELOPERS.md` |
| Features, flows, product reasoning, omissions | `docs/PRODUCT.md` |
| A non-obvious decision, or one reversed | `docs/DECISIONS.md` |
| Build sequence or phase scope | `docs/PLAN.md` |
| System boundaries or a vendor choice | `docs/ARCHITECTURE.md` |

**Verify before reporting.** Run `npm test`, `npm run typecheck`, and
`./scripts/verify-schema.sh` before claiming anything works. For schema changes, verify
locally first, then confirm against the live database — and say which was checked.

**This is Next.js 16.** Middleware is called Proxy (`proxy.ts`); `middleware.ts` is never
invoked. `cookies()` is async; `params`/`searchParams` are Promises. Read
`node_modules/next/dist/docs/` rather than relying on recalled patterns.

**Rules in code, judgement in the model.** Anything deterministic — progression, session
timing, adherence maths — is computed and unit-tested, never left to the model.

**Never delete data to tidy up.** Excluded exercises keep their history; the importer
refuses to prune anything with logged sets.
