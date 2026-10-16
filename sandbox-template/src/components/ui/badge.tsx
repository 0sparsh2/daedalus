import type { HTMLAttributes } from "react";
import { accent, cn } from "./theme";

const tones = { accent: accent.soft, neutral: "bg-stone-100 text-stone-700", success: "bg-green-50 text-green-700", warning: "bg-amber-50 text-amber-800", danger: "bg-red-50 text-red-700" };

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium", tones[tone], className)} {...props} />;
}
