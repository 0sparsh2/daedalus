import type { ReactNode } from "react";
import { cn } from "./theme";

/** The page frame: tinted background and a centred, responsive content column. */
export function Page({ children, width = "md", className }: { children: ReactNode; width?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  const max = { sm: "max-w-xl", md: "max-w-3xl", lg: "max-w-5xl", xl: "max-w-7xl" }[width];
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 antialiased">
      <main className={cn("mx-auto flex flex-col gap-6 px-4 py-8 sm:gap-8 sm:px-6 sm:py-12", max, className)}>{children}</main>
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1">
        {eyebrow && <p className="text-xs font-medium uppercase tracking-widest text-stone-500">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h1>
        {description && <p className="text-sm text-stone-500 sm:text-base">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  );
}
