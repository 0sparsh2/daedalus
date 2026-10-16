# Project guide (read by the Daedalus agent)

- Stack: Vite 8, React 19, TypeScript, Tailwind CSS v4 (`@import "tailwindcss"` in `src/index.css`; no tailwind.config needed). Icons: `lucide-react`.
- Entry: `index.html` → `src/main.tsx` → `src/App.tsx`. Put components in `src/components/`, hooks in `src/hooks/`, helpers in `src/lib/`.
- UI kit in `src/components/ui` (import from `./components/ui`): `Page` + `PageHeader` (background, centred column, title block), `Card` (+ `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`), `Button` (primary · secondary · ghost · danger; sizes sm · md · lg · icon), `Input`, `Textarea`, `Field` (label + hint/error), `EmptyState` (icon, title, description, action), `Badge`, and `cn()`. Build screens from these so spacing, focus states and touch targets are consistent; extend them for new needs instead of restyling each element. The accent colour lives in `src/components/ui/theme.ts`: change it there to re-theme the app.
- The dev server runs on port 5173 and hot-reloads; you rarely need to restart it.
- Keep the `daedalusBridge()` plugin in `vite.config.ts` and `public/__daedalus/bridge.js`: they report preview errors back to you.
- Check your work with `npm run typecheck` and `npm run build`.
- Frontend only by default: persist data in `localStorage` unless the user asks for a backend. Use `useLocalStorage(key, initial)` from `src/hooks/use-local-storage.ts`: it works like `useState` and survives reloads. Don't hand-write load/save effects; under React's development double-render they overwrite saved data.
