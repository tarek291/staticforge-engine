import type { ReactElement, ReactNode } from "react";

/**
 * Dashboard shell.
 *
 * Kept separate from the generated pages' layout in every way that matters:
 * these routes are dynamic, noindex, and carry operator chrome. A visitor never
 * reaches them, and the static site never pays for them.
 */
export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-12">
      <div className="flex items-baseline justify-between border-b border-neutral-200 pb-4 dark:border-neutral-800">
        <span className="font-mono text-sm tracking-tight">staticforge</span>
        <span className="text-xs uppercase tracking-wide text-neutral-500">
          local control
        </span>
      </div>
      {children}
    </div>
  );
}
