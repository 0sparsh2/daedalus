import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "./theme";

const field =
  "w-full rounded-xl border border-stone-200 bg-white px-3.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 transition-colors focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200 disabled:opacity-50";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, "min-h-24 py-2.5", className)} {...props} />;
}

/** A labelled field: <Field label="Name">{(id) => <Input id={id} />}</Field> */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-stone-700">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-sm text-red-600">{error}</p> : hint ? <p className="text-sm text-stone-500">{hint}</p> : null}
    </div>
  );
}
