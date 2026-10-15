# Project guide (read by the Daedalus agent)

- Stack: Vite 8, React 19, TypeScript, Tailwind CSS v4 (`@import "tailwindcss"` in `src/index.css`; no tailwind.config needed). Icons: `lucide-react`.
- Entry: `index.html` → `src/main.tsx` → `src/App.tsx`. Put components in `src/components/`, hooks in `src/hooks/`, helpers in `src/lib/`.
- The dev server runs on port 5173 and hot-reloads; you rarely need to restart it.
- Keep the `daedalusBridge()` plugin in `vite.config.ts` and `public/__daedalus/bridge.js`: they report preview errors back to you.
- Check your work with `npm run typecheck` and `npm run build`.
- Frontend only by default: persist data in `localStorage` unless the user asks for a backend.
