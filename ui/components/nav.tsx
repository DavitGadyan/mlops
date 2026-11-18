"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGES = [
  { href: "/", label: "Playground" },
  { href: "/benchmarks", label: "Benchmarks" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-12 max-w-[88rem] items-center gap-6 px-4">
        <span className="font-semibold">qwen7b serving</span>
        <nav className="flex h-full gap-5" aria-label="Pages">
          {PAGES.map(({ href, label }) => {
            const current = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={current ? "page" : undefined}
                className={`-mb-px flex items-center border-b-2 transition-colors duration-150 ${
                  current ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
