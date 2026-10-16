import type { ButtonHTMLAttributes } from "react";
import { accent, cn } from "./theme";

const variants = {
  primary: `${accent.solid} shadow-sm`,
  secondary: "border border-stone-200 bg-white text-stone-800 shadow-sm hover:bg-stone-50",
  ghost: "text-stone-600 hover:bg-stone-100 hover:text-stone-900",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700",
};
const sizes = { sm: "h-9 px-3 text-sm", md: "h-10 px-4 text-sm", lg: "h-12 px-6 text-base", icon: "size-10" };

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants; size?: keyof typeof sizes }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        "disabled:pointer-events-none disabled:opacity-50",
        accent.ring,
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
