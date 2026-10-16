/**
 * The app's accent colour, in one place. To re-theme every button, focus ring, badge and
 * highlight, swap the colour name below (e.g. emerald → indigo, rose, amber, sky, violet).
 * Keep whole class names: Tailwind finds classes by scanning for complete strings.
 */
export const accent = {
  solid: "bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800",
  soft: "bg-emerald-50 text-emerald-700",
  text: "text-emerald-700",
  border: "border-emerald-600",
  ring: "focus-visible:ring-emerald-500",
};

export const cn = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" ");
