# Agent Studio repository

This is a dependency-free Node.js 22+ local Codex App Server console.

- Run `npm test` after changes to project registration, HTTP boundaries or orchestration. Run `node --check` on changed JavaScript files. Tests use local fixtures and fake Codex clients; no live model call is required for routine changes.
- `projects.mjs` manages canonical registered directories. Every task must resolve inside its selected project's root; do not replace this check with a path prefix comparison.
- Keep the local server on loopback and preserve Origin/Host checks. Adding a project must not modify its files. Removing registration must retain files and reports.
- `read` intentionally skips the builder; `write` enables only the builder's workspace write sandbox. Keep this distinction visible in UI and reports.
- Runtime state, account credentials, reports, verification folders and hosting identities are private local files. Never commit them. Distribute the maintained Skill source under `skills/`; the personal install is a separate copy.
- Keep project history, mode and model preferences scoped to the selected project. A running task must not be silently cancelled when the user switches projects.
