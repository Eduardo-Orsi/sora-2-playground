# Repository Guidelines

## Project Structure & Module Organization
The Next.js app router lives under `src/app`, where `page.tsx` composes the playground UI and `api/` exposes server routes for video orchestration. UI building blocks sit in `src/components`; high-level forms like `creation-form.tsx` stay at the root while shared primitives belong in `src/components/ui`. Service logic, storage helpers, and OpenAI client wrappers live in `src/lib`, and shared shapes stay in `src/types`. Static assets and icons belong in `public/`; automation scripts such as `build-frontend.js` are kept in `scripts/`. Keep generated media out of the repository—use `./generated-videos` locally when running backend mode.

## Build, Test, and Development Commands
Run `npm run dev` (or `pnpm dev` / `bun dev`) to launch the Turbopack development server at `http://localhost:3000`. Use `npm run build` for the standard production bundle; `npm run build:frontend` exports the static frontend variant and writes to `out/`. Start a compiled server with `npm run start`. `npm run lint` executes the Next.js ESLint suite, and `npm run format` applies Prettier plus import sorting across `src/**/*.ts(x)`.

## Coding Style & Naming Conventions
This project is TypeScript-first; keep React components typed and prefer functional components. Follow Prettier defaults (two-space indentation, semicolons) and let the Tailwind/Sort Imports plugin order utility classes and imports automatically. Components and hooks use `PascalCase` filenames (for example, `VideoHistoryPanel.tsx`); utilities in `src/lib` use `kebab-case` modules with named exports. Keep Tailwind class names readable by grouping layout → spacing → color tokens.

## Testing Guidelines
There is no dedicated automated test suite yet; validate changes by exercising primary flows with `npm run dev` and watching both terminal and browser logs. When adding tests, colocate `*.spec.ts` or `*.test.tsx` beside the code, leverage React Testing Library, and aim to cover critical render paths and API client error handling. Document any new manual test checklist in the pull request until a formal runner is adopted.

## Commit & Pull Request Guidelines
Commit messages follow Conventional Commits (`feat:`, `docs:`, `ci:`, etc.); scope your changes so a single type describes the diff. Run `npm run lint` and `npm run format` before committing to keep CI happy. Pull requests should include a concise summary, verification notes (commands run, screenshots for UI tweaks), and links to issues or design references. Call out environment variable or deployment mode changes explicitly so reviewers can update their `.env.local`.
