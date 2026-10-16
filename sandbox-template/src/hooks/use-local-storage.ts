import { useEffect, useState } from "react";

/**
 * useState that survives a reload. Reads localStorage once, while the first render runs, so
 * React's development double-effects can't overwrite saved data; writes on every change.
 *   const [habits, setHabits] = useLocalStorage<Habit[]>("habits", []);
 */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: keep working in memory.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
