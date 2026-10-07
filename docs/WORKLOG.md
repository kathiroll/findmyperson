# Worklog

What was actually done and what came up, one entry per task. Append only: add new entries at the bottom and never edit an old one.

## 2026-10-08: T-000

- Onboarded the project onto the working rules. Read the code and docs without changing them, used the 39 merged pull requests to establish what is done, and wrote no code.
- Added the working rules and a coding-style section (adapted from ponytail, as the captain asked in a later message) to `AGENTS.md`, above the existing project notes, which were left as they were. `CLAUDE.md` is unchanged.
- Brought `docs/DECISIONS.md` into the D-XXX format: D-001 to D-051 are the 51 old entries, in their old order, none lost; the old "Status" line is kept as a `Source` field. Added D-052 to D-062, all Proposed and marked inferred from code.
- Checked `docs/ARCHITECTURE.md` against `main` at `88c8a6c` and corrected it in place: the commit it describes, the Home screen and tab-bar passages (now built), the operator page and its token, `response_reviews`, the Android project and SDK levels, the new folders, what `runMaintenance` does, and the pnpm layout row.
- Wrote `docs/PLAN.md` (with Non-goals), `docs/TASKS.md` (T-000 to T-039, a "Needs you" section with 13 `[!]` items and 7 candidates to remove) and this file.
- Files: `AGENTS.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/TASKS.md`, `docs/WORKLOG.md`, `docs/README.md`.
- Notes / questions raised:
  - The M0 to M7 milestone plan is outside the repository and was not seen; `docs/PLAN.md` says so and does not define M6 or M7. The detail of the recut question and the home-screen shortlist (and the Be My Eyes reference) are not in the repository either; the `[!]` items say so. -> "How far to recut" and "Home screen list" in `docs/TASKS.md`.
  - Found out of date and left alone, because T-000 only adds to `AGENTS.md` and its scope is the five record documents: the root `README.md` still says "pre-implementation"; `AGENTS.md`'s shard-compiler note still says the bucket and CDN adapters are not built (R2 landed in PR #29); `WORKSPACE.md` and `.npmrc` say the install is hoisted, but `AGENTS.md` and the installed tree say it is pnpm's isolated layout (D-001 carries a note). -> "Ratify the entries whose decider is not recorded".
  - D-038 (why R2) and D-040 (SQLite where the plan said Postgres) have no recorded approval; D-015 is inferred. All three are Proposed.
  - Attribution for the 51 older entries: where the repository or an addendum does not name who decided, the entry says "Not recorded" rather than guessing, and Status is `Accepted` meaning in force and documented, not asked.
  - Placeholders found, not changed: `CURIOUS_LINKS` on Home, `POLICIES_URL` and `ABUSE_CONTACT_URL`, `API_BASE_URL`, `REPORT_CDN_ORIGIN`, `REPORT_TRUSTED_KEYS`.
  - Nothing was run on a phone and the app was not built; no code, dependency or CI file changed, so the app builds as it did on `main`. `prettier --check` was run on every file written.
