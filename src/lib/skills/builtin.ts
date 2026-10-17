import type { Skill } from "./skill-file";

/**
 * Skills that ship with Daedalus, tuned to the starter app (Vite, React, TypeScript, Tailwind
 * and the UI kit). Projects can switch any of them off in Customize, and add their own.
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "charts",
    description: "Add charts (bar, line, area, pie) with Recharts. Use when the user asks for a chart, graph, dashboard or trend.",
    body: `# Charts with Recharts

1. Install with run_command: \`npm install recharts\`.
2. Wrap every chart in \`<ResponsiveContainer width="100%" height={280}>\`. It needs a fixed height, or a parent with one, or it renders at 0 px.
3. Shape the data as plain objects: one key for the x axis, one per series, e.g. \`[{ day: "Mon", minutes: 30 }]\`.
4. Style: the app's accent colour for the main series, neutral greys for grid and axes, at most three series colours. \`<CartesianGrid vertical={false} strokeDasharray="3 3" />\`, axes with \`tickLine={false} axisLine={false}\`, and a \`<Tooltip />\`.
5. Put each chart in a Card with a title and a one-line description. Format numbers with \`Intl.NumberFormat\`.
6. With no data, show the kit's EmptyState instead of an empty chart.
7. Keep axis labels short so the chart works at phone width.`,
  },
  {
    name: "forms",
    description: "Build forms with validation, clear errors and accessible labels using the UI kit. Use for sign-up, settings, booking, checkout or any multi-field input.",
    body: `# Forms

1. Use the kit's \`Field\` for every input: it ties the label to the input and shows hints or errors.
2. Keep the form's values in one \`useState\` object and one \`errors\` object.
3. Validate on submit, then on change for fields that already showed an error. Messages say how to fix it ("Enter an email like name@example.com").
4. Set \`aria-invalid\` on invalid inputs; focus the first invalid field after a failed submit.
5. Use the right input types: email, number, date, tel. Mark required fields in the label.
6. Disable the submit button while saving and show progress; never clear what the user typed when something fails.
7. After success, say what happened ("Booking saved for Tue 3 pm") and offer the next step.
8. Long forms: group fields into Cards with headings; two columns at most, one column on phones.`,
  },
  {
    name: "routing",
    description: "Add multiple pages with their own URLs (navigation, detail pages, back button) using React Router. Use when the app needs more than one screen with an address.",
    body: `# Pages and navigation with React Router

1. Install with run_command: \`npm install react-router\`.
2. In \`src/main.tsx\`, wrap \`<App />\` in \`<BrowserRouter>\` imported from "react-router".
3. In App: \`<Routes>\` with one \`<Route path="..." element={...} />\` per page, a detail route like \`/items/:id\` read with \`useParams\`, and a \`path="*"\` page for unknown addresses.
4. Navigate with \`<Link to>\` or \`<NavLink>\` (it marks the active page) and \`useNavigate()\` after actions.
5. Put pages in \`src/pages/\`; keep a shared header with the navigation inside the kit's Page.
6. Data shared between pages lives above the routes (or in useLocalStorage), not inside one page.
7. For hosting, unknown paths must serve index.html. On Vercel add \`vercel.json\`: \`{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }\`.`,
  },
  {
    name: "api-data",
    description: "Fetch data from a public web API (weather, maps, rates, any JSON endpoint) with loading, error and empty states. Use whenever the app calls an external API from the browser.",
    body: `# Calling public APIs from the app

1. Confirm the endpoint and parameters first (research), and that it works from a browser without a secret key. Never put a secret key in frontend code: if the API needs one, tell the user it needs a backend.
2. Write a small typed function per call in \`src/lib/\`; check \`res.ok\` and the response shape before using it.
3. Model every state: idle, loading (skeleton or spinner), error (plain message plus Retry), empty, and data.
4. Use an AbortController so a newer request cancels an older one; ignore stale responses.
5. Debounce search boxes (about 300 ms) and trim the input.
6. Keep recent results in state so going back doesn't refetch; show units and any attribution the API requires.
7. Test the real call once with run_command (\`curl\`) to see the actual response before writing types.`,
  },
  {
    name: "testing",
    description: "Add automated tests with Vitest and Testing Library. Use when the user asks for tests, or for logic tricky enough to deserve them (dates, money, streaks).",
    body: `# Tests with Vitest

1. Install with run_command: \`npm install -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom\`.
2. In \`vite.config.ts\`, add \`/// <reference types="vitest/config" />\` at the top and \`test: { environment: "jsdom", setupFiles: "./src/test/setup.ts" }\` to the config.
3. Create \`src/test/setup.ts\` with \`import "@testing-library/jest-dom/vitest";\` and add the script \`"test": "vitest run"\`.
4. Test pure logic first (move it out of components into \`src/lib/\`), then the main user flow with \`render\`, \`screen.getByRole\` and \`userEvent\`.
5. Name tests after behaviour ("keeps the streak after a reload"), not implementation.
6. Run \`npm test\` with run_command and fix failures before finishing.`,
  },
];

export const builtinSkill = (name: string) => BUILTIN_SKILLS.find((s) => s.name === name);
