# Handoff

Written 2026-09-30, ahead of moving this project to a new GitHub account, a new
Vercel project, and a new Claude account working in cloud sessions rather than on
a local checkout.

The point of this file, and of `docs/` generally, is that **everything a fresh
session needs is now inside the repo.** Before this commit, `CLAUDE.md` pointed at
reference docs sitting in the parent folder on one particular Mac, and several
design decisions existed only in Claude Code's local per-account memory. A cloud
session gets the git repo and nothing else, so both are now committed here.

## Where things stand

- 136 commits, 44 pull requests, all merged into `main`.
- No unmerged branches, no stashes, no tags. `main` is the whole project.
- No environment variables, no secrets, no `.env` files. The data layer is static
  mock data in `src/data/`.
- Deploys are Vercel-on-git-push. `vercel.json` holds the SPA rewrite; there is
  no `.vercel/` directory committed, so linking a new Vercel project is just an
  import of this repo (framework Vite, build `npm run build`, output `dist`).

## Running it

```bash
npm install
npm run dev     # localhost:3000
npm test        # node scripts/run-tests.mjs
npm run lint
```

## What's in docs/

- `reference/` — the four documents that drove the redesign: the style guide
  (full token reference), the New Relic UX benchmark, the UX review and
  recommendations, and the design critique of the original prototype. These were
  previously outside the repo.
- `decisions/` — design decisions worth not re-deriving, recovered from local
  memory:
  - `facet-interaction-datadog.md` — the split-row facet control, and why facet
    admission tests value *shape* rather than a cardinality ratio.
  - `query-builder-phase8.md` — what has and has not shipped on the Logs query
    builder. **The one genuinely outstanding piece of work is URL state sync.**

## Not carried over, deliberately

- `node_modules/`, `dist/` — rebuildable, git-ignored.
- `.claude/worktrees/` — local scratch worktrees, git-ignored.
- Claude Code session transcripts. These are per-account and do not migrate;
  anything from them that still mattered is in `docs/decisions/`.

`.claude/launch.json` and `.claude/settings.local.json` *are* committed, so the
dev-server config and the accumulated tool permissions travel with the repo.
