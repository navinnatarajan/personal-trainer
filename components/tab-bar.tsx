import Link from "next/link";

/**
 * Three tabs, named as verbs. Lift is what you open at the gym; Plan is the weekly cycle;
 * Review is the long horizon.
 *
 * The coach has no tab deliberately — every high-value question happens in context, and a
 * separate chat tab makes the user leave that context and rebuild it by typing.
 */
export function TabBar({ active }: { active: "lift" | "plan" | "review" }) {
  const tabs = [
    { id: "lift", label: "Lift", href: "/" },
    { id: "plan", label: "Plan", href: "/plan" },
    { id: "review", label: "Review", href: "/review" },
  ] as const;

  return (
    <nav className="sticky bottom-0 grid grid-cols-3 border-t border-line bg-ink px-2 pb-3.5 pt-2.5">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={active === t.id ? "page" : undefined}
          className={`py-1 text-center font-sans text-[10px] font-bold uppercase tracking-[0.1em] ${
            active === t.id ? "text-sage" : "text-muted"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
