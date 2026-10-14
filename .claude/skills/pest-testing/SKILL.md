---
name: pest-testing
description: >-
  How to write tests with Pest. Trigger whenever any test is being written, edited, fixed,
  reviewed or refactored, including fixing tests that broke after a code change, adding
  assertions or datasets, converting PHPUnit to Pest, TDD workflows, and deciding which suite or
  process a new test belongs in. Covers test()/it()/expect() syntax, datasets, architecture
  tests, which expectations take a failure message, and how to read a mutation run and record a
  survivor. In a Laravel application also mocking, RefreshDatabase, Livewire component tests,
  browser testing (visit/click/fill) and smoke testing pages for JS errors. In a WordPress plugin
  also the Unit process that runs with no WordPress, the Feature process over wp-phpunit,
  dispatching every REST test through rest_do_request(), the typed helpers that keep tests
  analyzable, and the global state WordPress leaks between tests. Do not use for factories,
  seeders, migrations, controllers, models, or non-test PHP code.
license: MIT
metadata:
  author: laravel
---
<!--
  Synced from UAMS-Web/uams-claude-skills: shared/.claude/skills/pest-testing/SKILL.md
  Edit it there, not here; the next sync overwrites this copy.
  Delivered to this repository through the profile(s): pest.
-->
<!-- cspell:ignore killable Livewire nikic -->

# Pest Testing

All tests are written with Pest. Read the installed Pest major from `composer.lock` before reaching for a feature: the repositories that share this skill sit on different majors, and a flag or helper one major has, another lacks.

## Documentation

Use `search-docs` for detailed Pest patterns and documentation for the installed version.

## Basic Usage

### Creating Tests

In a Laravel application, use `php artisan make:test --pest {name}`.

The `{name}` argument should include only the path and test name, but should not include the test suite.
- Incorrect: `php artisan make:test --pest Feature/SomeFeatureTest` will generate `tests/Feature/Feature/SomeFeatureTest.php`
- Correct: `php artisan make:test --pest SomeControllerTest` will generate `tests/Feature/SomeControllerTest.php`
- Incorrect: `php artisan make:test --pest --unit Unit/SomeServiceTest` will generate `tests/Unit/Unit/SomeServiceTest.php`
- Correct: `php artisan make:test --pest --unit SomeServiceTest` will generate `tests/Unit/SomeServiceTest.php`

Name files `*Test.php`. The testsuite suffix is `Test.php`, so a file named otherwise is silently never run, which reads exactly like a passing suite.

### Test Organization

- Do NOT remove tests without approval; these are core application code.

- Unit/Feature tests: `tests/Feature` and `tests/Unit` directories.
- Browser tests: `tests/Browser/` directory.

### Basic Test Structure

Pest supports both `test()` and `it()` functions. Before writing new tests, check existing test files in the same directory to match the project's convention. Use `test()` if existing tests use `test()`, or `it()` if they use `it()`. Match what is already there in the rest of the file too: `function (): void` closures, `expect()`, and `declare(strict_types=1);`.

<!-- Basic Pest Test Example -->
```php
it('is true', function () {
    expect(true)->toBeTrue();
});
```

Helper functions declared at the top of a test file are global. Keep their names specific (`indexAsSuperAdmin`, `requestWithSecret`); a generic one collides across files in the same process.

### Running Tests

In a Laravel application:

- Run minimal tests with filter before finalizing: `php artisan test --compact --filter=testName`.
- Run all tests: `php artisan test --compact`.
- Run file: `php artisan test --compact tests/Feature/ExampleTest.php`.

## Assertions

Use specific assertions (`assertSuccessful()`, `assertNotFound()`) instead of `assertStatus()`:

<!-- Pest Response Assertion -->
```php
it('returns all', function () {
    $this->postJson('/api/docs', [])->assertSuccessful();
});
```

| Use | Instead of |
|-----|------------|
| `assertSuccessful()` | `assertStatus(200)` |
| `assertNotFound()` | `assertStatus(404)` |
| `assertForbidden()` | `assertStatus(403)` |

## Not every expectation takes a failure message

`toBe()`, `toBeTrue()`, `toBeFalse()` and `toBeGreaterThan()` accept a message as their last argument. **`toContain()` and `toHaveKey()` do not**, and passing one does not error; it silently changes what is asserted:

- **`toContain(...$values)` is variadic.** `expect($haystack)->not->toContain('nf_sub', 'why this matters')` reads as *"contains neither of these"*, which is true whenever the message string is absent. It **passes with `nf_sub` sitting in the array.**
- **`toHaveKey($key, $value)`** takes an expected *value* second. `expect($map)->toHaveKey($key, 'the API did not serve it')` asserts the value equals that sentence.

Both were written in `uamswp-migration-api` and both were caught only by a negative control: the first turned a guard into a no-op, the second failed loudly for a reason that looked like a data bug. When an assertion needs a message, reach for a form that has one:

```php
// Inert: the message is read as a second value to look for.
expect($postTypes)->not->toContain($type, 'submission storage, not content');

// Bites.
expect(in_array($type, $postTypes, true))->toBeFalse('submission storage, not content');
```

This is the specific reason the [mutation discipline](#mutation-testing) matters for *guards* as much as for production code: a guard that has quietly stopped asserting is green forever, and looks exactly like a guard with nothing to complain about.

## Mocking

Import mock function before use: `use function Pest\Laravel\mock;`

### A mocked facade is still installed during `afterEach`: never clean up through one

Pest runs a file's `afterEach` **before** `parent::tearDown()`, so a facade you swapped inside the test is still the facade root while your cleanup runs. Cleanup that calls back through it silently does nothing, and the test still reports green:

```php
// The race test mocks isDirectory() to simulate a stale check…
File::partialMock()->shouldReceive('isDirectory')->with($dir)->andReturnFalse();

// …and Filesystem::deleteDirectory() OPENS with its own isDirectory() guard,
// so this no-ops and the directory survives. Fourteen accumulated before
// anyone noticed (UAMS-Web/uams-statamic#1853).
afterEach(fn () => File::deleteDirectory($dir));
```

Clean up through a real instance instead, which no mock can intercept:

```php
afterEach(function () use (&$dirs): void {
    $files = new Illuminate\Filesystem\Filesystem;   // NOT the File facade

    foreach ($dirs as $dir) {
        $files->deleteDirectory($dir);
    }
});
```

Two things make this hard to catch, so assume it rather than wait for a symptom: `storage/framework/testing/.gitignore` is `*`, so leaked fixtures never show in `git status`; and Mockery's `close()` runs first in Pest's chained `afterEach`, so an exhausted `->once()` expectation does **not** fail the test when the cleanup re-enters it. **Whenever a test both mocks a facade and creates files, verify the cleanup by listing the directory before and after a run**; green is not evidence here.

## Datasets

Use datasets for repetitive tests (validation rules, etc.):

<!-- Pest Dataset Example -->
```php
it('has emails', function (string $email) {
    expect($email)->not->toBeEmpty();
})->with([
    'james' => 'james@laravel.com',
    'taylor' => 'taylor@laravel.com',
]);
```

## Pest Features

### Architecture Testing

Architecture tests enforce code conventions:

<!-- Architecture Test Example -->
```php
arch('controllers')
    ->expect('App\Http\Controllers')
    ->toExtendNothing()
    ->toHaveSuffix('Controller');
```

### Test Sharding

Split tests across parallel processes for faster CI runs.

### Browser Testing

Browser tests run in real browsers for full integration testing:

- Browser tests live in `tests/Browser/`.
- Use Laravel features like `Event::fake()`, `assertAuthenticated()`, and model factories.
- Use `RefreshDatabase` for clean state per test.
- Interact with page: click, type, scroll, select, submit, drag-and-drop, touch gestures.
- Test on multiple browsers (Chrome, Firefox, Safari) if requested.
- Test on different devices/viewports (iPhone 14 Pro, tablets) if requested.
- Switch color schemes (light/dark mode) when appropriate.
- Take screenshots or pause tests for debugging.

<!-- Pest Browser Test Example -->
```php
it('may reset the password', function () {
    Notification::fake();

    $this->actingAs(User::factory()->create());

    $page = visit('/sign-in');

    $page->assertSee('Sign In')
        ->assertNoJavaScriptErrors()
        ->click('Forgot Password?')
        ->fill('email', 'nuno@laravel.com')
        ->click('Send Reset Link')
        ->assertSee('We have emailed your password reset link!');

    Notification::assertSent(ResetPassword::class);
});
```

### Smoke Testing

Quickly validate multiple pages have no JavaScript errors:

<!-- Pest Smoke Testing Example -->
```php
$pages = visit(['/', '/about', '/contact']);

$pages->assertNoJavaScriptErrors()->assertNoConsoleLogs();
```

### Visual Regression Testing

Capture and compare screenshots to detect visual changes.

## Tests are under static analysis too

Where `phpstan.neon.dist` lists `tests` among its paths, a broken mock, a wrong-typed fixture or an assertion calling a method that no longer exists is a real analysis failure, and a test-only diff still has to pass static analysis.

## The suite runs on the deployment target

Run the suite on the PHP version production runs. That is not a substitute for `phpVersion` in `phpstan.neon.dist`, which remains the only thing that reports a construct the older PHP cannot *parse*: PHPStan parses with `nikic/php-parser` regardless of the interpreter, and a parse error never reaches the test runner. Keep both.

## Mutation testing

Pest's `--mutate` mutates the source and requires the suite to notice. **A surviving mutant is a false-green test**: the code changed and nothing failed. The coverage driver it needs, the invocation forms that silently do nothing, and the checks that show a run executed at all are in [`pcov-setup`](../pcov-setup/SKILL.md); read that before trusting any score, including a perfect one. This section is how to read a run that did execute, and how to record what you decide about each survivor.

**The criterion belongs to [`adversarial-review`](../../rules/adversarial-review.md)**: no unexplained survivors, never a score. It is not restated here.

- **Every survivor ends in one of three states: killed, deleted, or annotated.** A survivor is a test to write, dead code to delete (mutation testing is the best dead-code finder you have), or an equivalent mutant annotated with the reason it cannot be killed. Kill, delete, annotate stay exhaustive; there is no fourth disposition where a survivor is simply left unexplained. If a survivor can be neither killed nor safely annotated (the node it would protect has no start line to stand above without also suppressing a sibling), restructure so it does, or delete the code the mutant targets.
- **Don't chase a literal 100%.** Every *killable* mutant dead is the goal; the last few percent are usually **equivalent mutants** (no input distinguishes them) whose only "kill" is an annotation in production source or deleting a defensive guard. Categorize every survivor; most fall into four buckets:
  1. **Real coverage gap** → add a dataset row that exercises that branch (an untested boundary `>=`, an untested fallback, positional vs named params, a plural/singular branch).
  2. **Inert data-table mutant** (`RemoveArrayItem` over a big alias/lookup map) → under `--covered-only` these are spawned simply because a legitimate test *executed* the data-returning method; killing each needs one near-circular assertion per entry. Default: accept and document the rationale in the test's docblock, unless the goal is 0 survivors, in which case generate an exhaustive dataset (see [`phpunit-to-pest`](../phpunit-to-pest/SKILL.md)).
  3. **Dead code** (the value is never read: a computed-then-`unset` local) → delete the dead code.
  4. **Equivalent mutant** (no input can change observable output: a `(int)`/`(string)` cast on a value already typed `int`/`string`, an unreachable defensive guard, a default that a clamp maps back to itself) → either remove the redundancy *legitimately* (tighten an `int|string` array shape to `array{divisor: positive-int, …}` so the casts become genuinely removable and static analysis stays green) or, for code that must stay defensive, annotate it as below. Judge each one; killing an equivalent mutant means contorting a test to assert something that cannot differ.
- **Record the judgment on the line rather than carrying it in your head. Annotate an accepted survivor standalone, on the line above the node, never trailing on the node's own line.** Bare `// @pest-mutate-ignore` skips every mutator on that node; `// @pest-mutate-ignore:MutatorName,OtherMutator` scopes it to the ones named. Put the reason on its own line above the annotation, never after the mutator name on the same line: the plugin splits the tail on `,` and compares each part to a mutator name with `===`, so any prose after the mutator makes the whole annotation match nothing and the survivor stays uncounted. The mutator name is not optional: a bare marker blanket-suppresses the node and every child, which raises the apparent result rather than showing up as a survivor.
- **Two mechanisms make a standalone annotation work, and neither reaches a trailing one.** A line map, keyed on the node's own `getStartLine()`, protects the node itself; a comment-attachment scan protects everything nested inside it. Both need the marker at or before the node's first line: on a multi-line construct's *closing* line it is inert, since the map matches only the start line and the scan only reaches forward. Trailing on the node's own line is worse than inert: php-parser attaches a trailing comment to the *next* node, so the marker silently suppresses the following statement while leaving its own node unprotected.
- **A bare trailing annotation can also poison every annotation after it in the file.** The line-to-mutator map is built once per file and never reset between entries, so a bare marker landing on a trailing line inherits whatever mutator list the previous colon-form annotation set, instead of defaulting to "all". This is a second, independent reason trailing placement is unsafe; it is not rescued by choosing a "safer" trailing spot.
- **A run cannot tell a silently-failed annotation from a wrong reason**: both read as an ordinary surviving mutant. Treat a survivor as suspect until the annotation is confirmed standalone, on or above the node's own line, with nothing but the mutator name after the colon.
- **The config-level `ignore()` and `except()` are not substitutes for it.** They silence a whole path, or a mutator across the repository, so neither can carry a per-survivor justification and neither is visible at the line someone is reading.
- **The annotation mechanics above were measured in `uamswp-migration-api` against `pestphp/pest-plugin-mutate` v3.0.5 (`e10dbdc9`), `pestphp/pest` v3.8.7 (`f108313b`) and `nikic/php-parser` v5.8.0 (`044a6a39`)**; re-check before relying on this if any of the three has moved since.
- **Whenever survivors are accepted as equivalents, the test file's docblock must state which survive and why, ending on "every killable mutant is dead" (or the equivalent)**, so a reader and the next adversarial pass know the residual score is equivalents, not an untested gap.
- **Name the platform the score was taken on, in the same line as the score.** A mutation score is the claim where omitting the machine costs the most: `100%` is simultaneously the house standard and the precise signature of a run that executed nothing, so a corpus of unattributed scores cannot audit itself in either direction.
- **Never pass `--filter` to a `--mutate` run; scope it with `--path`**, and read a reported timeout as unverified, never as a kill. Why is in [`pcov-setup`](../pcov-setup/SKILL.md).
- **`0 Mutations for 0 Files created` is a setup failure, not a pass.** Usually a missing coverage driver or a path the finder could not resolve (see [`pcov-setup`](../pcov-setup/SKILL.md)).
- **Pass-3 / inventory harden is single-flight.** One `--mutate` per worktree at a time. While it runs, prep the next eligible class but do not remutate it; commit the current class when it is mutation-clean (or every survivor is explained), then kick the next narrow mutate. Full rule and safe overlap list: [`pcov-setup`](../pcov-setup/SKILL.md) (three-pass walk).

## Common Pitfalls

- Deleting tests without approval.
- Forgetting datasets for repetitive validation tests.
- Passing a message to `toContain()` or `toHaveKey()`, which silently changes the assertion.
- Reading `0 Mutations for 0 Files created` as a pass.
- Passing `--filter` to a `--mutate` run, or reading its timeouts as kills.
- Starting a second `--mutate` (or overlapping `--parallel` / heavy Pest) in the same worktree while one is still running.
- Annotating an accepted survivor on the node's own line, or with prose after the mutator name.

- Not importing `use function Pest\Laravel\mock;` before using mock.
- Using `assertStatus(200)` instead of `assertSuccessful()`.
- Forgetting `assertNoJavaScriptErrors()` in browser tests.
- Prefixing `Feature/` or `Unit/` in `{name}` when using `make:test`.
- Cleaning up through a mocked facade in `afterEach`.

