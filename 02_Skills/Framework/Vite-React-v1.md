<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Vite + React SPA (v1.0)
**Category:** Framework
**Status:** Active

---

## 1. What This Is Not

This skill covers **Vite + plain React** — a client-only single-page application with no server rendering. The `skill_react_nextjs` skill does NOT apply here. The following Next.js concepts do not exist in this stack:

| Next.js concept | Vite/React equivalent |
|---|---|
| `next.config.js` | `vite.config.ts` |
| `pages/` or `app/` directory | React Router or manual state routing |
| `getServerSideProps` / `getStaticProps` | `useEffect` + `fetch` on mount |
| `next/link`, `next/router` | `window.location` or React Router |
| Server Components | None — everything is client-side |
| `process.env.NEXT_PUBLIC_*` | `import.meta.env.VITE_*` |
| `_app.tsx` | `main.tsx` + `App.tsx` |
| Middleware (`middleware.ts`) | App-level auth gating in `App.tsx` |
| API routes (`/api/*`) | Supabase Edge Functions or external API |

---

## 2. Project Config

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  // Vitest config lives here (not a separate vitest.config.ts)
  test: {
    environment: 'jsdom',
    globals: true,
  },

  server: {
    port: 3000,
    open: true,
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'], // separate vendor chunk for caching
        },
      },
    },
  },

  optimizeDeps: {
    include: ['react', 'react-dom'], // pre-bundle for fast cold start
  },
});
```

**Rules:**
- Vitest config lives inside `vite.config.ts` under the `test` key — not in a separate `vitest.config.ts` unless there is a specific reason to split them.
- `@vitejs/plugin-react` uses Babel for HMR; `@vitejs/plugin-react-swc` uses SWC (faster but less compatible). Use the Babel variant unless build speed is a confirmed bottleneck.
- `manualChunks` separates React from app code so the vendor bundle can be cached across deploys.

---

## 3. Environment Variables

Vite replaces `process.env` with `import.meta.env`. The rules are different from Node/Next.js:

```typescript
// ✅ Client-accessible — must be prefixed VITE_
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ✅ Built-in Vite vars — no prefix needed
const isDev  = import.meta.env.DEV;     // true during `vite dev`
const isProd = import.meta.env.PROD;    // true during `vite build`
const mode   = import.meta.env.MODE;    // "development" | "production" | custom

// ✅ Dev-only logging (example_llm_router pattern)
function devLog(...args: unknown[]): void {
  if (import.meta.env.DEV) console.log(...args);
}

// ❌ Never use process.env in client Vite code
const key = process.env.VITE_SUPABASE_ANON_KEY; // undefined at runtime
```

**Rules:**
- Any variable you want available in the browser bundle MUST start with `VITE_`. Variables without the prefix are stripped from the bundle.
- `VITE_*` values are baked into the bundle at build time — they are not secret. Never put service-role keys or private API keys in `VITE_*` vars.
- The `.env` file loads automatically; `.env.local` overrides it (gitignored). Use `.env.local` for local dev secrets.

---

## 4. Entry Points

```
index.html          ← Vite's entry point (not _app.tsx or _document.tsx)
  └── src/main.tsx  ← React mount point
        └── App.tsx ← Root component (auth gating, global layout)
```

```typescript
// main.tsx — mounts the React app
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

There is no file-based routing. All routing is either:
- **Conditional render** in `App.tsx` (example_llm_router pattern — auth state drives which component renders)
- **React Router** (`createBrowserRouter`, `RouterProvider`) for multi-page apps

---

## 5. Auth Gating Pattern (Client-Side)

Without Next.js middleware, auth gating lives at the React root:

```typescript
// App.tsx — auth state drives the entire render tree
function App() {
  const { isAuthenticated, isLoading, user, signIn, signOut } = useAuth();

  // Loading state while Supabase session resolves
  if (isLoading) return <LoadingScreen />;

  // Password recovery flow (bypass normal auth gating)
  if (isRecoveryFlow()) return <ResetPassword />;

  // Not authenticated
  if (!isAuthenticated) return <Auth onSignIn={signIn} />;

  // Authenticated
  return <ChatInterface user={user} onSignOut={signOut} />;
}
```

**Rules:**
- Auth gating via conditional render in `App.tsx` — not middleware, not route guards.
- `isLoading` check must come before `isAuthenticated` check. Rendering the auth screen while the session is still loading causes a flash of the login form on authenticated users.
- `isRecoveryFlow()` checks `window.location` for `?type=recovery` or `#type=recovery` — Supabase puts recovery tokens in URL fragments, not path segments.

---

## 6. Viewport and Mobile Handling

```typescript
// hooks/useViewportHeight.ts (example_llm_router pattern)
// Fixes the "100vh is too tall on mobile" problem — mobile browsers include
// the address bar in 100vh, cutting off the bottom of the UI.
export function useViewportHeight() {
  useEffect(() => {
    const setVh = () => {
      document.documentElement.style.setProperty(
        '--app-vh',
        `${window.innerHeight * 0.01}px`
      );
    };
    setVh();
    window.addEventListener('resize', setVh);
    return () => window.removeEventListener('resize', setVh);
  }, []);
}

// Usage in CSS (via style tag or CSS file):
// height: calc(var(--app-vh, 1vh) * 100);  ← use instead of 100vh
```

---

## 7. Code Splitting

Without Next.js automatic route-based splitting, do it manually:

```typescript
import { lazy, Suspense } from 'react';

// Lazy-load heavy components
const SettingsPanel = lazy(() => import('./components/SettingsPanel'));

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SettingsPanel />
    </Suspense>
  );
}
```

`manualChunks` in `vite.config.ts` handles vendor splitting. `React.lazy()` handles feature splitting.

---

## 8. Build and Dev Commands

```bash
# Development server (hot reload)
npm run dev

# Type check (without emitting files)
npx tsc --noEmit

# Production build
npm run build

# Preview production build locally
npm run preview

# Run Vitest unit tests
npx vitest run

# Run Vitest in watch mode
npx vitest
```

**TypeScript config note:** Vite projects typically have two tsconfig files:
- `tsconfig.json` — for `src/` (targets browser, includes `dom` lib)
- `tsconfig.node.json` — for `vite.config.ts` itself (targets Node)

Both must be referenced in `tsconfig.json` via `references`. Running `tsc --noEmit` against the root config checks both.

---

## 9. High-Risk Zones

| Zone | Risk |
|------|------|
| `process.env.*` in client code | `undefined` at runtime — use `import.meta.env.VITE_*` |
| Secret keys in `VITE_*` vars | Baked into bundle, visible to anyone |
| Auth check missing `isLoading` guard | Flash of login screen on authenticated users |
| `100vh` CSS on mobile | Address bar clips content — use `--app-vh` custom property |
| No `manualChunks` | React bundled with app code, cache busted on every deploy |
| `@vitejs/plugin-react-swc` without testing | Some Babel transforms (decorators, legacy class properties) require the Babel plugin variant |

