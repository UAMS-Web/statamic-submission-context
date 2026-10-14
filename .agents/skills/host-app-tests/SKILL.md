---
name: host-app-tests
description: >-
  Run a package's host-app integration tests (the `Tests\TestCase`-derived classes in
  `tests/Feature/`) against a branch. These CANNOT run in the package's standalone Pest/PHPUnit
  CI: they need the booted host application, so they run from a claimed host worktree slot with
  the package pointed at your branch. Activate whenever the user asks to "run the host-app
  tests", "validate the change in the host app", "test the integration", or wants to confirm a
  package change end-to-end before merging, or when a change touches behavior only
  `tests/Feature/` exercises. For WHICH base class a test needs, defer to the
  `statamic-package-conventions` skill; this skill is the slot SETUP + RUN + result-interpretation
  procedure on top of it.
---
<!--
  Synced from UAMS-Web/uams-claude-skills: shared/.claude/skills/host-app-tests/SKILL.md
  Edit it there, not here; the next sync overwrites this copy.
  Delivered to this repository through the profile(s): laravel-package.
-->
<!-- cspell:ignore Browsershot Puppeteer rsync Stache -->

# Running a package's host-app integration tests

## Why this exists

The package's own CI runs only the standalone tests: the pure-unit classes (bare `PHPUnit\Framework\TestCase` or the package's own `TestCase`) and the ones that boot a minimal framework. The **host-app integration tests**, every class that `use Tests\TestCase;`, boot the full host application (config, container, real collections and blueprints, a test database). They are **not** registered in the host's `phpunit.xml`, which runs only the host's own `tests/Unit` and `tests/Feature`, so they are run **manually, by path**, from inside the host:

```
cd /path/to/host
php artisan test vendor/<vendor>/<package>/tests/Feature/<File>.php
```

Neither the package's gate nor its static analysis exercises them. So a change that only alters behavior reachable through the host (anything a real run of the package inside the application would touch) is **not validated** until you run this subset in the host. That is this skill.

The *Choosing a base class* section of the [`statamic-package-conventions`](../statamic-package-conventions/SKILL.md) skill is the companion rule: it decides **which** base class a test needs. This skill is the **setup + run** procedure and does not restate that taxonomy.

## When a run is obligatory

This skill is the **how**. The **when** is the [`host-only-behavior-needs-a-host-run`](../rule-host-only-behavior-needs-a-host-run/SKILL.md) rule: a change to behavior that only `tests/Feature/` exercises must be run here before the PR is flipped to ready. Read it before deciding you do not need this procedure.

## Setup: claim the host's package slot, then point it at your branch

Do not run these in the primary host checkout. It is served, holds the main branch, and may back another session; content mutation and cache churn from a full run is exactly what the [`worktrees`](../rule-worktrees/SKILL.md) rule isolates.

**The host keeps long-lived, pre-bootstrapped slots**, so you *claim* one rather than building a worktree. A host slot already carries its dependency installs, an `.env` repointed at its own host, its git-ignored databases, its submodules and an asset build, which is why "create a worktree and bootstrap it" is not a step here.

1. **Claim the slot the host keeps for package test runs**, never one of the host's own ticket slots and never its CI slot. Borrowing a ticket slot costs three things: it **blocks the host's local CI** (the runner checks branches out by name, so a held slot fails its validating run), it makes the occupancy signal **lie** (a host slot on a package branch reads as host ticket work to anyone checking status), and it **halves the host's concurrency budget**, pushing the next host session onto an ephemeral worktree.

   The branch you check out there is a **marker, not a work surface**: nothing is committed in the host for a package test run. It exists so the ordinary free/held reading keeps working. In principle the tree could stay detached, since the only thing that changes is the git-ignored `vendor/`, but then the status check would report the slot free while your run is mid-flight.

   **Never hand-drive the host's CI slot.** It belongs to the host's local-CI runner, which checks branches in and out of it.

   If the package slot is already held, that is **another package session**, not host work. Wait, or take an ephemeral worktree per the host's rule. Do not evict it, and do not fall back to a ticket slot.

2. **Refresh the slot before trusting a run.** This replaces the bootstrap steps, and it is a gate rather than a courtesy: the host's `content/` submodule pointer moves with its main branch, and a stale `content/` makes `Collection::findByHandle()` return `null`, so every test that touches a collection dies with `Call to a member function entryClass() on null`. **That wall of errors across unrelated suites is environmental, not a broken branch.** An entire bisect was once invalidated by taking those nulls at face value. It has **two** causes, though; see *Interpreting results* before concluding it is the submodule.

   Run the refresh **before** step 3, not after, so that the copy in step 3 is the last write to `vendor/` in every case rather than in most. The refresh's `composer install` will not overwrite an already-installed package, so it usually leaves a copied-in branch alone; but when the lockfile has moved to a newer release it replaces the package wholesale, and your copy goes with it.

3. **Point the vendored package at your branch.** `composer install` places the package under `vendor/<vendor>/<package>`, often as a **dist (zip) extract with no `.git`**, so you cannot just `git checkout` inside it. Sync `src/` and `tests/` wholesale from your package branch worktree:

   ```
   SRC=/path/to/package-branch-worktree
   DST=vendor/<vendor>/<package>
   rsync -a --delete "$SRC/src/"   "$DST/src/"
   rsync -a --delete "$SRC/tests/" "$DST/tests/"
   ```

   **Sync the whole tree. Never copy `git diff --name-only origin/main HEAD`.** The host pins a tagged range, so `vendor/` sits at the newest release the constraint allows, which lags the main branch by every PR merged since. A diff-only copy lays your branch's changes onto *the last release's everything-else*, and the result is a tree that matches no commit that has ever existed. It bites three ways, all silent:

   - **A stale vendored *test* file fails and blames your branch.** The branch is innocent; the test is the old release's copy of a test main has since fixed. Your own copy of that file is correct, so nothing looks wrong until you diff vendor against the branch.
   - **A class your branch never touched goes missing.** It arrives as a bare `Class "..." not found`, which reads like a broken branch.
   - **A deletion or rename cannot be expressed at all.** A per-file copy loop only ever *adds*; a file your branch removed survives in the vendored tree and keeps running. `--delete` is what makes the sync a mirror rather than an overlay, and it is why `rsync` is the form here rather than `cp -R`.

   The same whole-tree shape is what the *baseline* half of revert-and-compare needs (see *Interpreting results*), so there is exactly one copy recipe in this skill.

   Either way, **verify the vendored tree matches the branch** before trusting a run. Diff it: a token grep only proves your *change* arrived, which is exactly the check that passes while every file you did not touch is still at the pinned release.

   ```
   diff -rq "$SRC/src" "$DST/src" && diff -rq "$SRC/tests" "$DST/tests" && echo "vendor == branch"
   ```

   Expect **no output** before the echo. `Only in ...` lines are the deletion case; `differ` lines are the stale-release case.

4. **Prepare whatever the host's own CI prepares before its suites.** A session following this skill is exactly the path that skips it, and skipping it does not fail cleanly: see *Interpreting results*. The preparation is state the host owns (a content mirror, a cache snapshot, a database), so the host's CI configuration is the specification, and **a run consumes that state**, so a value that changes between runs of unchanged code is often residue rather than a flake.

**Two things about a host slot that do not apply to a throwaway worktree:**

- **The vendored package persists between runs, and it is invisible to `git status`.** `vendor/<vendor>/<package>` is git-ignored, so the files you copied in step 3 survive a `release` and are inherited by whoever claims the slot next, while the tree reports perfectly clean. **A clean tree does not mean the vendored package is back at its pinned release**, and neither does a `composer install`. This is why step 3's verification is not optional, and why teardown ends with `composer reinstall`.
- **A run can still reach the host's `content/` submodule.** The host re-roots its Stache stores at a disposable mirror under the testing environment, so a Statamic save should not write into the submodule, but anything that builds a raw `base_path('content/...')` path bypasses that. `worktree-slots release` uses `--ignore-submodules=all`, so a dirty `content/` will **not** block the release. Check before releasing, and restore with `git -C content checkout -- <path>` (plus `git -C content clean -fd` for anything untracked; `checkout` cannot remove it).

## Run

Run by explicit path; the default suite will not pick these up:

```
php artisan test vendor/<vendor>/<package>/tests/Feature/<File>.php --compact
```

- The host-app-bound tests all live under `tests/Feature/` (see the base-class rule in the `statamic-package-conventions` skill); run them by that path.
- Scope to the files your change actually touches. These are multi-minute runs.
- **Do not run two files concurrently against one tree.** They share the host's content state and collide. Run them sequentially; the concurrency ceiling in a single package slot is **one**. Bound each run per the [`long-running-commands`](../rule-long-running-commands/SKILL.md) rule rather than letting a tool timeout detach it.
- **Bound generously above the *high* end of the observed spread**, and do not calibrate off one suite: a cap set at the fast figure manufactures a "timeout" that reads exactly like a failure. Treat any single recorded figure as a lower bound.
- **Re-running the same file? Re-seed first** (setup step 4). A value that moved between two runs of unchanged code is accumulated residue, not a flake.
- **Never pipe the runner through `tail -n`** if you care about failures: `--compact` prints the failure block *before* the summary, so `tail -4` keeps only the summary and discards which test failed and why. Capture full output (or grep for `FAILED` / `Failed asserting`).

## Interpreting results: a failure is not automatically your fault

This subset carries a standing set of **pre-existing** failures that are unrelated to any given change. Before attributing a red test to your branch:

0. **Rule out the missing host preparation first, because it impersonates other diagnoses.** If you skipped setup step 4, the failures do not say so. A null collection, store or tree is what it looks like, and the refresh step above teaches you to read that as a **stale `content/` submodule**. Check that first, but do not stop there: the discriminator is cheap. If the slot's drift check is clean and the submodule's HEAD matches the host's gitlink, it is the missing preparation; do it and re-run. Confirm by elimination rather than by theory: run an **untouched** test in the same file. A test that fails identically before the preparation and passes after it, with no code change in between, proves the branch innocent. A worse variant is **silent**: the command exits `0` and the assertion simply finds nothing, which reads as a regression in the branch you are testing.

   **Do not read a green run as evidence the preparation was unnecessary.** That same test passes without it on a slot whose state a previous session already built. The failure only appears cold, so "it worked for me" and "the preparation is required" are both true, of different slots.

1. **There is no live known-failure catalog: revert-and-compare (step 3 below) is the primary method.** A closed umbrella ticket is the worst kind of reference here: it still renders, still has a title that reads like a catalog, and still lists historical failures, so the step *appears* to work while telling you nothing about a red test you are looking at today. Per-file trackers are the replacement, and they close.

   **A stale vendored file is its own attribution cause, and it is on no tracker.** If setup step 3's copy was a diff rather than a whole-tree sync, the failing file may simply be the *pinned release's* copy of a test the main branch has since fixed. `diff -rq` the vendored tree against the branch before reaching for any tracker.

2. **Watch for content-model drift.** The host's `content/` submodule moves ahead of the tests. A test asserting a taxonomy term long after that taxonomy became a collection fails on current content regardless of the branch, and no cache warm can conjure a taxonomy that no longer exists.

3. **Revert-and-compare to attribute a failure.** The decisive check: reproduce the same test on a **clean** package, and the baseline is **the package's `origin/main`, never the pinned vendor copy.** The vendored package resolves to whatever tagged release the host's `composer.json` allows, which lags the main branch; comparing against it can blame your branch for a defect that merged after the pin, or clear one that did not. Sync the baseline the same way you synced the branch (the whole-tree `rsync` from setup step 3, pointed at a checkout of `origin/main`) so a file your branch deleted or renamed cannot survive into the baseline run. Then re-run the single test with `--filter`:

   ```
   php artisan test vendor/<vendor>/<package>/tests/Feature/<File>.php --filter=<test_method>
   ```

   If it fails **identically on clean `origin/main`**, it is pre-existing, not your change. Restore your branch files afterward. Do the isolation with `--filter`: some of these failures are order-dependent and only appear in a full-file run.

A run is "green for your change" when every failure **reproduces on clean `origin/main`**. That is revert-and-compare, step 3, and it is the durable half because it depends on no ticket staying open. A match in a tracker table is a shortcut to the same conclusion, not a substitute for it. The count being zero is neither necessary nor sufficient.

**But revert-and-compare cannot see a defect its two arms share.** Both arms boot the same slot, the same `content/` and the same test-environment mirror, so anything wrong with *those* reproduces identically, and "reproduces identically on `origin/main`" is exactly the phrase that normally means "pre-existing, not yours". The comparison agrees with itself and confirms the wrong conclusion.

**The tell is what the error names.** A failure about the *behavior under test* (a wrong handle, a missing field, an assertion on imported data) is **usually** the kind revert-and-compare attributes correctly, but treat the shape as a heuristic that shifts the odds, not a proof. A failure naming a null **collection, store or tree** is about the environment the test reads through, and both arms read the same one. When you see that shape, re-prepare per setup step 4 and re-run **before** comparing; a matching pair proves nothing until the harness is known good.

## Teardown

**Release the slot; never remove it.** A slot is a full host bootstrap, so deleting one throws away work the model exists to keep.

Before releasing: check that the host's `content/` submodule is clean (restore it if not), reinstall the vendored package, and then release the slot. `release` asserts a clean tree, detaches it at the main branch, and preserves the branch. Do it as your last act: a slot still holding your marker branch blocks the next package session from claiming it cleanly. Copy any imported-content or asset scratch worth keeping to the scratchpad first; everything else in the tree is disposable.

**`reinstall`, not `install`, and the difference is the whole point.** Composer does not overwrite files in an already-installed package, so `composer install` leaves the branch files you copied in exactly where they are and reports success. Verified by byte-comparison after a full run: following `composer install`, the vendored tree was **identical to the branch** and differed from `origin/main`, while `composer show` printed the pinned release it should have been serving. `composer reinstall <vendor>/<package>` genuinely restores it.

That failure is worse than an ordinary wrong command because of where it sits: a session that runs `install` gets a clean `git status`, a clean slot status, **and** a contaminated `vendor/`, with every signal it can read saying the slot is at rest. **Both teardown checks exist because `release` cannot see what they check.** It passes `--ignore-submodules=all`, so a dirty `content/` sails through; and `vendor/` is git-ignored, so branch code left there is invisible. Nothing reports either; the next session inherits both.

## References

- The [`statamic-package-conventions`](../statamic-package-conventions/SKILL.md) skill: which base class a test needs (the companion rule).
- The [`worktrees`](../rule-worktrees/SKILL.md) rule: the slot lifecycle this composes with (claim, refresh, release).
- The [`host-only-behavior-needs-a-host-run`](../rule-host-only-behavior-needs-a-host-run/SKILL.md) rule: when a run is obligatory.

