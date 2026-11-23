import { redirect } from "next/navigation";

import { getUser } from "@/lib/supabase/server";
import { TabBar } from "@/components/tab-bar";

/**
 * Review — the long-horizon view: am I actually getting stronger.
 *
 * Deliberately unbuilt. It answers questions that need months of logged data to ask, and
 * designing it before that data exists means designing against imagined numbers. The tab
 * exists so navigation is complete and the gap is visible rather than a dead link.
 */
export default async function ReviewPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  return (
    <>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-6 pt-10">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-steel">
          Review
        </span>
        <h1 className="mt-3 font-display text-[28px] font-semibold uppercase leading-[1.05] tracking-[-0.03em] text-bone">
          Not built yet
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          This is where strength curves, personal records and your weight trend will live —
          the months view rather than the week. It needs real logged sessions to be worth
          anything, so it comes after the session logger.
        </p>
      </main>
      <TabBar active="review" />
    </>
  );
}
