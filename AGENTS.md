# Agent instructions for statamic-addon-template

This file is the single source of agent instructions for this repository. Claude Code, Cursor and Codex all read it directly; there is no `CLAUDE.md`, because Claude Code reads `AGENTS.md` only when `CLAUDE.md` is absent. Put instructions here, never in a `CLAUDE.md`.

Everything above the generated section belongs to this repository and is edited here. The generated section is written by the sync from `UAMS-Web/uams-claude-skills`, once this repository is onboarded to it; edit the shared skills and rules there. Until then there is no generated section, and the sync inserts one after this introduction.

## About this repository

A Statamic add-on (`uams-web/statamic-addon-template`, namespace `UAMSWeb\AddonTemplate`). Replace this paragraph with what it does. It is a Composer library with no `artisan`, `.env`, database or front end of its own; a host application boots it through `extra.laravel.providers`. The `statamic-package-conventions` skill covers what that changes.

### Commands

- `composer install`: installs dependencies and applies the `patches/` set to `pestphp/pest-plugin-mutate` (temporary, Windows-safe mutation testing; see `upstream-patch-lifecycle`).
- `composer ci`: the gate, run in cost order and stopping at the first failure: the repository guards, `test:mutate-ignore`, `test:parallel-safe`, `test:pint`, `test:refactor` (Rector dry run), `stan` (Larastan), `test` (Pest `Unit` and `Integration`, run in parallel through the bundled paratest; `composer test:serial` runs the same suites in one process, which is the first thing to try when a failure looks order-dependent). GitHub Actions runs the same scripts as separate parallel jobs (`.github/workflows/ci.yml`); change a script and its job together. `main` requires each job's `name:` (and the two pull-request-body workflows' job names) as a status check through an organization ruleset, so renaming or adding a job also means updating that ruleset's list; see the header of `ci.yml`. `check-required-checks.yml` compares that list with the job names and fails on a required name no job reports (it warns on a pull request, and fails on `main`, for a job the ruleset does not require).
- `composer pint` and `composer refactor` apply formatting and the gating Rector profile; `composer refactor:sweep` runs the deliberate sweep profile.
- `npm run build` builds the Control Panel assets (`vite.config.js`, sources in `resources/js` and `resources/css`) into `resources/dist`, which is committed because a Composer install does not run npm; the `Built assets` job fails when it is stale. `@statamic/cms` is a `file:` link into `vendor/statamic/cms`, so run `composer install` before `npm ci`.
- `composer mutate`: Pest mutation testing over `src/`. Read `pcov-setup` before trusting a score.

### Layout and tests

- `src/` holds the add-on (PHP floor `^8.4`, `statamic/cms` `^6.35`); `tests/Unit` boots nothing, `tests/Integration` boots a minimal Statamic through Testbench (`tests/TestCase.php`).
- Host-bound tests belong in `tests/Feature/` and are not part of `composer ci` (PHPStan excludes the directory); the `host-only-behavior-needs-a-host-run` rule says when a host run is required, and `docs/DEVELOPMENT.md` is the host setup and the commands to run them.
- `composer test:tia` is Pest's test impact analysis for the inner loop: the first run records a dependency graph (needs PCOV; stored under `~/.pest/tia`, outside the repository), later runs replay unaffected tests from cache. It applies only to a full run, so `--testsuite` or `--filter` bypasses it, and it is never the gate: `composer ci` and CI run the real suite.
- Tests run in parallel workers, so a test must not share mutable state with another: no fixed file paths, cache keys or Stache/form storage directories. Give each worker its own directory (`ParallelTesting::token()` or `uniqid()`) when a test writes files.
- The static-analysis cache lives in `storage/phpstan` (git-ignored).

### Repository skills

- [`github-wiki`](.claude/skills/github-wiki/SKILL.md): planning, writing and publishing the GitHub wiki. It belongs to this repository; the sync leaves it alone.
- [`marketplace-review`](.claude/skills/marketplace-review/SKILL.md): Statamic's own review of an add-on against its [marketplace submission guidelines](https://statamic.com/marketplace/submission-guidelines). It is Statamic's file, kept byte-identical to [the download](https://statamic.com/downloads/marketplace-review/SKILL.md) (policy revision 2026-09-14, SHA-256 `30289fc818f0cdea540c6f054a0024ed9b60c1e6aa4a51cf345909d39461b8c6`), in `.claude/skills/` and in `.agents/skills/`, where the guidelines say to save it. Replace both copies with a fresh download rather than editing either.
