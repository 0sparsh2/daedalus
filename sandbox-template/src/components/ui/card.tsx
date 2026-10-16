import type { HTMLAttributes } from "react";
import { cn } from "./theme";

type Props = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: Props) {
  return <div className={cn("rounded-2xl border border-stone-200 bg-white shadow-sm", className)} {...props} />;
}
export function CardHeader({ className, ...props }: Props) {
  return <div className={cn("flex flex-col gap-1 p-5 pb-0 sm:p-6 sm:pb-0", className)} {...props} />;
}
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-base font-semibold text-stone-900", className)} {...props} />;
}
export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-stone-500", className)} {...props} />;
}
export function CardContent({ className, ...props }: Props) {
  return <div className={cn("p-5 sm:p-6", className)} {...props} />;
}
export function CardFooter({ className, ...props }: Props) {
  return <div className={cn("flex items-center justify-end gap-2 border-t border-stone-100 px-5 py-4 sm:px-6", className)} {...props} />;
}
