import type { ComponentType, ReactNode } from "react";
import { accent, cn } from "./theme";

export function EmptyState({ icon: Icon, title, description, action }: { icon: ComponentType<{ className?: string }>; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-12 text-center">
      <div className={cn("grid size-12 place-items-center rounded-full", accent.soft)}>
        <Icon className="size-6" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium text-stone-900">{title}</p>
        {description && <p className="max-w-sm text-sm text-stone-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}
