<?php

declare(strict_types=1);

/**
 * Test-isolation guard (UAMS-Web/uams-statamic#1149)  -  fail the build when a test uses a
 * parallel-unsafe, shared-state pattern without quarantining it.
 *
 * The suite runs under `pest --parallel` (paratest): ~N workers share one
 * filesystem. A test that mutates shared, file-backed state without isolating it
 * per worker flakes intermittently  -  a concurrent worker reads or wipes that
 * state mid-test. `AGENTS.md` documents the convention that prevents this
 * (the `serial` group, or a per-worker `TEST_TOKEN` path); this script *enforces*
 * it so a new violation fails at author time instead of flaking weeks later.
 *
 * Five high-signal patterns are checked:
 *
 *   Rule A  -  `Storage::fake(`: reroots a disk to the shared, non-tokenized
 *            `storage/framework/testing/disks/<name>` and `cleanDirectory()`s it,
 *            so a concurrent worker faking the same disk wipes this one's files.
 *   Rule B  -  `storage_path('…framework/testing…')` with no per-run uniqueness
 *            token (`uniqid`, `TEST_TOKEN`, `random_bytes`,
 *            `Str::random`, `bin2hex`) anywhere in the call: a fixed shared path
 *            two runs race.
 *   Rule C  -  a global-namespace `const`/`function` name declared in more than one
 *            parallel-group file (UAMS-Web/uams-statamic#1471): namespace-less Pest files fatal
 *            ("Constant X already defined" / "Cannot redeclare X()") the instant
 *            paratest lands both in one worker. Rules A/B are per-file; this one is
 *            cross-file  -  the collision is invisible to any single-file scan.
 *            Namespaced declarations and nested (class-const / method / closure)
 *            symbols are exempt; a name in exactly one file is always fine.
 *   Rule D  -  a top-level single-segment `use X;` in a file with NO named
 *            namespace (UAMS-Web/uams-statamic#1867): the import is a guaranteed no-op  -  the class is
 *            already global  -  and PHP raises `E_WARNING` "The use statement with
 *            non-compound name 'X' has no effect" at COMPILE time. Laravel's
 *            error handler promotes that to `ErrorException`, which under
 *            `--parallel` aborts the worker BEFORE the first test runs and takes
 *            the whole band with it. Invisible everywhere else: the file passes
 *            run alone, passes in the serial tail, and is green under Pint,
 *            Rector and Larastan. Only the parallel band turns the warning fatal.
 *   Rule E  -  an `assert(` or `\assert(` call anywhere under `tests/` (UAMS-Web/uams-statamic#1865).
 *            Not a parallelism rule; it rides here because this is already the
 *            suite's token-level lint and its CI job. `assert()` was the suite's
 *            habit for narrowing a type for PHPStan, which is wrong three ways:
 *            `zend.assertions=-1` compiles the call out, so the narrowing is
 *            configuration-dependent; a bare failure names no cause; and larastan
 *            passes on the suppression rather than on the types. UAMS-Web/uams-statamic#1733 removed the
 *            eleven unqualified narrowings but its `^\s*assert(` search never
 *            matched the dominant fully-qualified form, and shipped no guard  -
 *            which is exactly why 157 of them survived. Narrow by control flow
 *            instead.
 *
 * Detection runs over PHP tokens ({@see token_get_all}), not physical lines, so a
 * match inside a comment, docblock, or string literal is ignored, and a call
 * wrapped across lines (or whose uniqueness token sits on a continuation line) is
 * still resolved correctly. That is what lets Rule E's own prose  -  and every
 * docblock in the suite that discusses `assert()`  -  describe the banned form
 * without tripping the rule.
 *
 * A file is exempt when it is quarantined **whole-file** into the `serial` group
 * (a Pest `uses(...)->group('serial')` chain, or a class-level PHPUnit
 * `#[Group('serial')]` / `@group serial`). Separately, a file is exempt from
 * the rules {@see ALLOWLIST} names for it, with a reason. A per-test marker
 * (`it(...)->group('serial')` or a method-level PHPUnit attribute) does NOT
 * exempt the file  -  it quarantines only that test, leaving a
 * sibling `Storage::fake` in the parallel pass. `Storage::fake` is coarse by
 * design: a per-worker-disk "real fix" still trips Rule A and must be allowlisted
 * with its justification, keeping every exception visible and reasoned.
 *
 * Usage:  php scripts/check-parallel-safe-tests.php [path]   (path default: tests)
 * Exit:   0 = clean, 1 = one or more un-quarantined violations.
 *
 * Dependency-free (no Composer autoload) so its CI job needs only PHP.
 */

/**
 * Files exempt from named rules despite matching them. Keyed by repo-relative
 * path (forward slashes); each row lists the rules it exempts and a reason that
 * argues for each of them. A row suppresses only the rules it names: the file is
 * still scanned for every other rule, so a later change that trips one of those
 * is reported (UAMS-Web/uams-statamic#2939). Only the parallelism rules A, B, C and D can be named;
 * Rule E runs before this lookup, and a row naming any other rule is refused.
 * An entry that no longer matches its rules is a harmless no-op  -  prune it when
 * its reason is resolved.
 *
 * @var array<string, array{rules: list<string>, reason: string}>
 */
const ALLOWLIST = [];

/**
 * The rules an {@see ALLOWLIST} row may name: the parallelism rules. Rule E is not
 * among them, because an `assert()` narrowing is a typing defect no parallelism
 * exemption excuses.
 *
 * @var list<string>
 */
const ALLOWLIST_RULES = ['A', 'B', 'C', 'D'];

/**
 * Identifiers whose presence inside a `storage_path()` call makes the path
 * per-run unique (parallel-safe): `uniqid()`, `random_bytes()`, `bin2hex()`, and
 * `Str::random()` (via its `random` method name). `TEST_TOKEN` (as a string
 * literal, e.g. `env('TEST_TOKEN')`) is matched separately.
 *
 * @var list<string>
 */
const UNIQUENESS_IDENTIFIERS = ['uniqid', 'random_bytes', 'bin2hex', 'random'];

/**
 * Class names whose presence inside a `storage_path()` call makes the path per-run unique
 * because the call routes through a shared throwaway-root helper. None exists here yet; add
 * the helper's bare class name when the suite grows one (the originating repository's is
 * `ThrowawayRoot`, resolving the paratest worker's `TEST_TOKEN`). Matched on the class name
 * rather than a method, because a method name like `segment` is common enough to false-positive.
 *
 * @var list<string>
 */
const UNIQUENESS_HELPERS = [];

$repoRoot = str_replace('\\', '/', dirname(__DIR__));

foreach (ALLOWLIST as $allowlistedPath => $row) {
    $rules = $row['rules'] ?? null;
    $reason = $row['reason'] ?? null;

    if (! is_array($rules) || $rules === [] || array_diff($rules, ALLOWLIST_RULES) !== [] || ! is_string($reason) || trim($reason) === '') {
        fwrite(STDERR, sprintf(
            "check-parallel-safe-tests: ALLOWLIST row %s must name one or more of rules %s and give a reason.\n",
            $allowlistedPath,
            implode(', ', ALLOWLIST_RULES),
        ));
        exit(1);
    }
}

$scanArg = $argv[1] ?? 'tests';
$scanRoot = preg_match('#^(?:[A-Za-z]:)?/#', str_replace('\\', '/', $scanArg)) === 1
    ? str_replace('\\', '/', $scanArg)
    : $repoRoot.'/'.$scanArg;

if (! is_dir($scanRoot)) {
    fwrite(STDERR, "check-parallel-safe-tests: path not found: {$scanRoot}\n");
    exit(1);
}

/** @var list<array{file: string, line: int, rule: string, snippet: string}> $violations */
$violations = [];

/**
 * Global-namespace `const`/`function` declarations across the parallel-group test
 * files, keyed by `"<kind> <name>"`. A name declared in more than one file is a
 * cross-file collision (Rule C).
 *
 * @var array<string, list<array{file: string, line: int}>> $globalSymbols
 */
$globalSymbols = [];

$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($scanRoot, FilesystemIterator::SKIP_DOTS)
);

foreach ($iterator as $fileInfo) {
    if (! $fileInfo->isFile() || $fileInfo->getExtension() !== 'php') {
        continue;
    }

    $absolute = str_replace('\\', '/', $fileInfo->getPathname());

    // Case-insensitive prefix strip: on Windows dirname(__DIR__) and an absolute
    // scan argument can disagree on drive-letter case (`C:` vs `c:`), which would
    // otherwise leave $relative as the full path and defeat the ALLOWLIST match.
    $relative = str_starts_with(strtolower($absolute), strtolower($repoRoot).'/')
        ? substr($absolute, strlen($repoRoot) + 1)
        : $absolute;

    $contents = (string) file_get_contents($absolute);

    // Rule E runs BEFORE the ALLOWLIST and serial-quarantine skips below. Those
    // exempt a file from the *parallelism* rules; an `assert()` narrowing is a
    // typing defect that a `serial` group or an allowlist entry does nothing to
    // excuse, so neither may hide one.
    foreach (scanForAssertNarrowings($contents) as $violation) {
        $violations[] = ['file' => $relative] + $violation;
    }

    if (isWholeFileSerial($contents)) {
        continue;
    }

    // An ALLOWLIST row exempts its file from the rules it names, and only those.
    $exemptRules = ALLOWLIST[$relative]['rules'] ?? [];

    foreach (scanForViolations($contents) as $violation) {
        if (in_array(ruleLetter($violation['rule']), $exemptRules, true)) {
            continue;
        }

        $violations[] = ['file' => $relative] + $violation;
    }

    if (in_array('C', $exemptRules, true)) {
        continue;
    }

    // Rule C  -  collect this file's global const/function declarations so a name
    // declared in more than one parallel-group file can be flagged after the scan.
    foreach (collectGlobalSymbols($contents) as $symbol) {
        $globalSymbols[$symbol['kind'].' '.$symbol['name']][] = ['file' => $relative, 'line' => $symbol['line']];
    }
}

/**
 * Symbols declared in more than one file  -  the load-order-dependent redeclare
 * fatals. Keyed identically to $globalSymbols.
 *
 * @var array<string, list<array{file: string, line: int}>> $duplicateSymbols
 */
$duplicateSymbols = [];

foreach ($globalSymbols as $key => $occurrences) {
    if (count(array_unique(array_column($occurrences, 'file'))) > 1) {
        $duplicateSymbols[$key] = $occurrences;
    }
}

if ($violations === [] && $duplicateSymbols === []) {
    echo "check-parallel-safe-tests: OK  -  no un-quarantined parallel-unsafe test patterns.\n";
    exit(0);
}

if ($violations !== []) {
    usort($violations, fn (array $a, array $b): int => [$a['file'], $a['line']] <=> [$b['file'], $b['line']]);

    fwrite(STDERR, "check-parallel-safe-tests: parallel-unsafe test pattern(s) found:\n\n");

    foreach ($violations as $violation) {
        fwrite(STDERR, sprintf(
            "  %s:%d\n    Rule %s\n    %s\n\n",
            $violation['file'],
            $violation['line'],
            $violation['rule'],
            $violation['snippet'],
        ));
    }

    fwrite(STDERR, <<<'HINT'
    Fix each by making the test parallel-safe, then (if it still matches) quarantining it:
      - Add ->group('serial') / #[Group('serial')] so it runs in the serial tail, or
      - Make the shared path per-run by appending a unique token (uniqid(),
        env('TEST_TOKEN'), Str::random()) INSIDE the storage_path() call; a token
        hoisted to a local on a previous line does NOT satisfy the rule. Or
      - If it is provably safe, add it to ALLOWLIST in this script, naming the rule it
        exempts and a reason.
    Rule D is a one-line delete, even though a quarantine would silence it:
      - Remove the `use X;`. The file declares no namespace, so X already resolves
        from the global namespace, and the import raises a warning whether or not
        the file runs in parallel.
      - A whole-file `serial` quarantine does stop the Rule D report, because the
        warning is fatal only under --parallel and a quarantined file never runs
        there. The import is still dead code; delete it rather than quarantine it.
    Rule E is the one rule nothing silences. Neither `serial` nor the ALLOWLIST
    exempts it, because it is a typing defect rather than a parallelism one:
      - Narrow by control flow (an explicit `if` that throws, or `expect(...)`) so
        PHPStan verifies the type instead of assuming it.
      - For a genuine runtime invariant (not a type narrowing), write an explicit
        `if (! …) { throw new RuntimeException("…"); }` naming what went wrong.
    See the Tests section of AGENTS.md for the parallel-isolation convention.

    HINT);
}

if ($duplicateSymbols !== []) {
    ksort($duplicateSymbols);

    fwrite(STDERR, "check-parallel-safe-tests: duplicate global test symbol(s) found:\n\n");

    foreach ($duplicateSymbols as $symbol => $occurrences) {
        usort($occurrences, fn (array $a, array $b): int => [$a['file'], $a['line']] <=> [$b['file'], $b['line']]);

        $locations = implode(
            "\n",
            array_map(fn (array $o): string => sprintf('      %s:%d', $o['file'], $o['line']), $occurrences),
        );

        fwrite(STDERR, sprintf("  %s\n    declared in:\n%s\n\n", $symbol, $locations));
    }

    fwrite(STDERR, <<<'HINT'
    Two parallel-group test files that declare the same global const/function fatal
    ("Constant X already defined" / "Cannot redeclare X()") the instant paratest lands
    both in one worker process. Fix each by:
      - Renaming one declaration to a unique symbol, or
      - Namespacing the file (namespaced symbols cannot collide at global scope).

    HINT);
}

exit(1);

/**
 * The rule letter a violation's `rule` label opens with: `B` for
 * `B (hardcoded framework/testing path, …)`.
 */
function ruleLetter(string $rule): string
{
    return substr($rule, 0, 1);
}

/**
 * Whether the whole file is quarantined into the `serial` group  -  the only
 * exemption that makes *every* test in the file run in the single-process serial
 * tail. A per-test marker qualifies only that test, so it is deliberately not
 * accepted here.
 */
function isWholeFileSerial(string $contents): bool
{
    // Pest: a `uses(...)` chain ending in `->group('serial'[, ...])` applies the
    // group to every test in the file. `serial` may be any argument (the group
    // list is variadic), and the chain may include other calls (`->beforeEach()`).
    // A bare `it(...)->group('serial')` has no `uses(` prefix, so it does not match.
    if (preg_match(
        '/\buses\s*\([^;]*?\)\s*(?:->\s*\w+\s*\([^;]*?\)\s*)*->\s*group\s*\(\s*[^;)]*?([\'"])serial\1/s',
        $contents,
    ) === 1) {
        return true;
    }

    // PHPUnit class-level `#[Group('serial')]`  -  the attribute must sit
    // immediately before the class declaration (a method-level attribute is
    // followed by `function`, not `class`, so it correctly does not match).
    if (preg_match(
        '/#\[\s*Group\s*\(\s*([\'"])serial\1\s*\)\s*\](?:\s*#\[[^\]]*\])*\s*(?:abstract\s+|final\s+|readonly\s+)*class\b/',
        $contents,
    ) === 1) {
        return true;
    }

    // PHPUnit class-level `@group serial` docblock immediately before the class.
    // `serial` is anchored with a negative lookahead so `@group serial-slow` (a
    // different group that is neither excluded from the parallel pass nor added to
    // the serial tail) does not match.
    if (preg_match(
        '/@group\s+serial(?![\w-])[\s\S]*?\*\/\s*(?:#\[[^\]]*\]\s*)*(?:abstract\s+|final\s+|readonly\s+)*class\b/',
        $contents,
    ) === 1) {
        return true;
    }

    return false;
}

/**
 * Scan a file's PHP tokens for Rule A / Rule B violations. Tokenizing (rather than
 * scanning physical lines) means a pattern inside a comment or string literal is
 * ignored, and a call wrapped across lines is resolved as one unit.
 *
 * @return list<array{line: int, rule: string, snippet: string}>
 */
function scanForViolations(string $contents): array
{
    $tokens = token_get_all($contents);
    $lines = explode("\n", $contents);
    $count = count($tokens);

    /** @var list<array{line: int, rule: string, snippet: string}> $violations */
    $violations = [];

    for ($i = 0; $i < $count; $i++) {
        $token = $tokens[$i];

        if (! is_array($token) || $token[0] !== T_STRING) {
            continue;
        }

        // Rule A  -  a real `Storage::fake(` static call: `Storage` `::` `fake` `(`.
        if ($token[1] === 'Storage') {
            $colon = nextMeaningful($tokens, $i + 1);
            $method = $colon !== null && is_array($tokens[$colon]) && $tokens[$colon][0] === T_DOUBLE_COLON
                ? nextMeaningful($tokens, $colon + 1)
                : null;

            if ($method !== null && tokenText($tokens[$method]) === 'fake') {
                $paren = nextMeaningful($tokens, $method + 1);

                if ($paren !== null && $tokens[$paren] === '(') {
                    $violations[] = [
                        'line' => $token[2],
                        'rule' => 'A (Storage::fake shares a non-tokenized testing disk)',
                        'snippet' => trim($lines[$token[2] - 1] ?? ''),
                    ];

                    continue;
                }
            }
        }

        // Rule B  -  `storage_path( … )` whose argument hardcodes a framework/testing
        // path with no per-run uniqueness token anywhere in the call.
        if ($token[1] === 'storage_path') {
            $open = nextMeaningful($tokens, $i + 1);

            if ($open !== null && $tokens[$open] === '(') {
                [$callTokens, $end] = collectCallTokens($tokens, $open);

                if (callHardcodesFrameworkTesting($callTokens) && ! callHasUniquenessToken($callTokens)) {
                    $violations[] = [
                        'line' => $token[2],
                        'rule' => 'B (hardcoded framework/testing path, no per-worker token)',
                        'snippet' => trim($lines[$token[2] - 1] ?? ''),
                    ];
                }

                $i = $end;
            }
        }
    }

    foreach (singleSegmentGlobalImports($tokens) as $import) {
        $violations[] = [
            'line' => $import['line'],
            'rule' => 'D (single-segment use in a namespace-less file; fatal under --parallel)',
            'snippet' => trim($lines[$import['line'] - 1] ?? ''),
        ];
    }

    return $violations;
}

/**
 * Scan a file's PHP tokens for `assert(` / `\assert(` calls (Rule E).
 *
 * Both spellings are one construct, and UAMS-Web/uams-statamic#1733's line-anchored `^\s*assert(`
 * search matched only the first  -  which is how 157 fully-qualified narrowings
 * survived a sweep that reported the suite clean. Matching on tokens catches
 * both regardless of leading whitespace, wrapping, or a preceding `(`.
 *
 * PHP 8 tokenizes the qualified call as a single `T_NAME_FULLY_QUALIFIED`
 * (`\assert`) and the bare one as `T_STRING` (`assert`), so both are checked.
 * A method or static call that merely ends in `assert`  -  `$this->assert(`,
 * `Foo::assert(`  -  is NOT the language construct and is skipped by looking at
 * the preceding meaningful token. `assertSomething(` never matches, because the
 * token's text must equal `assert` exactly.
 *
 * @param  string  $contents  The PHP source to scan.
 * @return list<array{line: int, rule: string, snippet: string}>
 */
function scanForAssertNarrowings(string $contents): array
{
    $tokens = token_get_all($contents);
    $lines = explode("\n", $contents);
    $count = count($tokens);

    /** @var list<array{line: int, rule: string, snippet: string}> $violations */
    $violations = [];

    for ($i = 0; $i < $count; $i++) {
        $token = $tokens[$i];

        if (! is_array($token)) {
            continue;
        }

        // PHP function names are case-insensitive, so `ASSERT(` / `Assert(` is the
        // same construct and narrows types identically. A case-sensitive match
        // would leave exactly the kind of hole that lets the form return.
        $isBare = $token[0] === T_STRING && strcasecmp($token[1], 'assert') === 0;
        $isQualified = defined('T_NAME_FULLY_QUALIFIED')
            && $token[0] === T_NAME_FULLY_QUALIFIED
            && strcasecmp($token[1], '\\assert') === 0;

        if (! $isBare && ! $isQualified) {
            continue;
        }

        // `$x->assert(`, `Foo::assert(`, `function assert(` and `new assert(` are
        // each something other than the language construct.
        $previous = previousMeaningful($tokens, $i - 1);

        if ($previous !== null && is_array($tokens[$previous]) && in_array(
            $tokens[$previous][0],
            [T_OBJECT_OPERATOR, T_NULLSAFE_OBJECT_OPERATOR, T_DOUBLE_COLON, T_FUNCTION, T_NEW],
            true,
        )) {
            continue;
        }

        $open = nextMeaningful($tokens, $i + 1);

        if ($open === null || $tokens[$open] !== '(') {
            continue;
        }

        $violations[] = [
            'line' => $token[2],
            'rule' => 'E (assert() type-narrowing; narrow by control flow instead)',
            'snippet' => trim($lines[$token[2] - 1] ?? ''),
        ];
    }

    return $violations;
}

/**
 * Index of the nearest preceding token that is not whitespace or a comment.
 *
 * The mirror of {@see nextMeaningful()}, used by Rule E to tell the `assert`
 * language construct from a method call that happens to share its name.
 *
 * @param  array<int, array{0: int, 1: string, 2: int}|string>  $tokens
 * @param  int  $index  Index to search back from, inclusive.
 * @return ?int The token index, or null when none precedes it.
 */
function previousMeaningful(array $tokens, int $index): ?int
{
    for ($i = $index; $i >= 0; $i--) {
        $token = $tokens[$i];

        if (is_array($token) && in_array($token[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
            continue;
        }

        return $i;
    }

    return null;
}

/**
 * Top-level single-segment `use X;` imports in a file that declares no named
 * namespace  -  each one a compile-time `E_WARNING` that the parallel band turns
 * fatal (Rule D).
 *
 * Only **import** statements count. A `use SomeTrait;` inside a class body is a
 * different construct and entirely legitimate, so collection is gated on brace
 * depth 0; indentation is not used, since it is style rather than syntax. A
 * closure's `use ($x)` is excluded the same way  -  it is never at depth 0  -  and
 * `use function foo;` / `use const BAR;` are included, because PHP raises the
 * identical warning for those.
 *
 * A file WITH a named namespace is exempt: there, importing a global class is
 * meaningful rather than a no-op.
 *
 * @param  array<int, array{0: int, 1: string, 2: int}|string>  $tokens
 * @return list<array{name: string, line: int}>
 */
function singleSegmentGlobalImports(array $tokens): array
{
    if (fileHasNamedNamespace($tokens)) {
        return [];
    }

    $count = count($tokens);
    $depth = 0;

    /** @var list<array{name: string, line: int}> $imports */
    $imports = [];

    for ($i = 0; $i < $count; $i++) {
        $token = $tokens[$i];

        if ($token === '{') {
            $depth++;

            continue;
        }

        if ($token === '}') {
            $depth--;

            continue;
        }

        if ($depth !== 0 || ! is_array($token) || $token[0] !== T_USE) {
            continue;
        }

        $next = nextMeaningful($tokens, $i + 1);

        if ($next === null) {
            continue;
        }

        // `use function foo;` / `use const BAR;`  -  step past the modifier and
        // judge the name that follows it.
        if (is_array($tokens[$next]) && in_array($tokens[$next][0], [T_FUNCTION, T_CONST], true)) {
            $next = nextMeaningful($tokens, $next + 1);

            if ($next === null) {
                continue;
            }
        }

        // A qualified name (`Foo\Bar`) is compound and therefore meaningful. Only
        // a bare `T_STRING` terminated by `;` is the no-op shape  -  a group use
        // (`use Foo\{A, B};`) is qualified, and an aliased `use X as Y;` still
        // warns but is vanishingly rare, so require the plain `;` terminator.
        if (! is_array($tokens[$next]) || $tokens[$next][0] !== T_STRING) {
            continue;
        }

        $terminator = nextMeaningful($tokens, $next + 1);

        if ($terminator !== null && $tokens[$terminator] === ';') {
            $imports[] = ['name' => $tokens[$next][1], 'line' => $tokens[$next][2]];
        }
    }

    return $imports;
}

/**
 * Index of the next token that is not whitespace or a comment, or null at end.
 *
 * @param  array<int, array{0: int, 1: string, 2: int}|string>  $tokens
 */
function nextMeaningful(array $tokens, int $index): ?int
{
    $count = count($tokens);

    for (; $index < $count; $index++) {
        $token = $tokens[$index];

        if (is_array($token) && in_array($token[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
            continue;
        }

        return $index;
    }

    return null;
}

/**
 * The source text of a token (its literal for a single-char token).
 *
 * @param  array{0: int, 1: string, 2: int}|string  $token
 */
function tokenText(array|string $token): string
{
    return is_array($token) ? $token[1] : $token;
}

/**
 * Collect the tokens inside a parenthesised call, starting at its opening `(`, up
 * to the matching close paren (tracking nesting). Returns the inner tokens and the
 * index of the closing paren.
 *
 * @param  array<int, array{0: int, 1: string, 2: int}|string>  $tokens
 * @return array{0: list<array{0: int, 1: string, 2: int}|string>, 1: int}
 */
function collectCallTokens(array $tokens, int $openIndex): array
{
    $count = count($tokens);
    $depth = 0;

    /** @var list<array{0: int, 1: string, 2: int}|string> $call */
    $call = [];

    for ($i = $openIndex; $i < $count; $i++) {
        $token = $tokens[$i];

        if ($token === '(') {
            $depth++;

            if ($depth === 1) {
                continue;
            }
        } elseif ($token === ')') {
            $depth--;

            if ($depth === 0) {
                return [$call, $i];
            }
        }

        $call[] = $token;
    }

    return [$call, $count - 1];
}

/**
 * Whether any string literal within the call hardcodes a `framework/testing` path.
 *
 * @param  list<array{0: int, 1: string, 2: int}|string>  $callTokens
 */
function callHardcodesFrameworkTesting(array $callTokens): bool
{
    foreach ($callTokens as $token) {
        if (is_array($token)
            && in_array($token[0], [T_CONSTANT_ENCAPSED_STRING, T_ENCAPSED_AND_WHITESPACE], true)
            && str_contains($token[1], 'framework/testing')
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Whether the call contains a per-run uniqueness token  -  a uniqueness function
 * call, a `TEST_TOKEN` reference, or the shared throwaway-root helper  -  which
 * makes the path unique per run.
 *
 * @param  list<array{0: int, 1: string, 2: int}|string>  $callTokens
 */
function callHasUniquenessToken(array $callTokens): bool
{
    foreach ($callTokens as $token) {
        if (! is_array($token)) {
            continue;
        }

        if ($token[0] === T_STRING
            && (in_array($token[1], UNIQUENESS_IDENTIFIERS, true)
                || in_array($token[1], UNIQUENESS_HELPERS, true)
                || $token[1] === 'TEST_TOKEN')
        ) {
            return true;
        }

        if (in_array($token[0], [T_CONSTANT_ENCAPSED_STRING, T_ENCAPSED_AND_WHITESPACE], true)
            && str_contains($token[1], 'TEST_TOKEN')
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Collect the global-namespace, top-level `const` and `function` declarations in a
 * file (Rule C). Pest test files are namespace-less, so two files that each declare
 * the same such symbol fatal ("already defined" / "Cannot redeclare") when paratest
 * loads both in one worker.
 *
 * Exemptions match the redeclare semantics: a file under a *named* namespace
 * declares its symbols there (no global collision), so it yields nothing; and only
 * brace-depth-0 declarations are collected, so class constants / methods (nested)
 * and anonymous closures (`$x = function () {}`)  -  which never collide at global
 * scope  -  are ignored.
 *
 * Known limitation: a symbol inside an *unnamed* `namespace { … }` block is global
 * but is skipped (the block's opening brace makes it depth 1). Pest/PHPUnit test
 * files never use bracketed namespace blocks, so this is an accepted gap.
 *
 * @return list<array{kind: string, name: string, line: int}>
 */
function collectGlobalSymbols(string $contents): array
{
    $tokens = token_get_all($contents);

    if (fileHasNamedNamespace($tokens)) {
        return [];
    }

    $count = count($tokens);
    $depth = 0;

    /** @var list<array{kind: string, name: string, line: int}> $symbols */
    $symbols = [];

    for ($i = 0; $i < $count; $i++) {
        $token = $tokens[$i];

        if ($token === '{') {
            $depth++;

            continue;
        }

        if ($token === '}') {
            $depth--;

            continue;
        }

        if (! is_array($token)) {
            continue;
        }

        // String-interpolation braces (`"{$x}"` / `"${x}"`) open with these tokens
        // and close with a plain `}`, so count them to keep the depth balanced.
        if (in_array($token[0], [T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES], true)) {
            $depth++;

            continue;
        }

        // Only top-level (global-scope) declarations can collide across files.
        if ($depth !== 0) {
            continue;
        }

        if ($token[0] === T_FUNCTION) {
            // A named function: the next meaningful token (past an optional
            // return-by-reference `&`) is the name. An anonymous function is
            // followed by `(` (or `use`), so it is skipped. The `&` is matched via
            // tokenText() because PHP 8.1+ tokenizes it as an array token
            // (T_AMPERSAND_NOT_FOLLOWED_BY_VAR_OR_VARARG), not the plain string `&`.
            $next = nextMeaningful($tokens, $i + 1);

            if ($next !== null && tokenText($tokens[$next]) === '&') {
                $next = nextMeaningful($tokens, $next + 1);
            }

            if ($next !== null && is_array($tokens[$next]) && $tokens[$next][0] === T_STRING) {
                $symbols[] = ['kind' => 'function', 'name' => $tokens[$next][1], 'line' => $token[2]];
            }

            continue;
        }

        if ($token[0] === T_CONST) {
            foreach (constDeclarationNames($tokens, $i + 1) as $const) {
                $symbols[] = ['kind' => 'const', 'name' => $const['name'], 'line' => $const['line']];
            }
        }
    }

    return $symbols;
}

/**
 * Whether the file declares a *named* (non-global) namespace, under which its
 * top-level const/function symbols cannot collide at global scope. An unnamed
 * `namespace { … }` global block is NOT a named namespace  -  its symbols are global.
 *
 * @param  array<int, array{0: int, 1: string, 2: int}|string>  $tokens
 */
function fileHasNamedNamespace(array $tokens): bool
{
    $count = count($tokens);

    for ($i = 0; $i < $count; $i++) {
        if (is_array($tokens[$i]) && $tokens[$i][0] === T_NAMESPACE) {
            $next = nextMeaningful($tokens, $i + 1);

            // A name (`namespace Foo;` / `namespace Foo\Bar { … }`) means named; a
            // `{` (the unnamed global block) does not.
            return $next !== null
                && is_array($tokens[$next])
                && in_array($tokens[$next][0], [T_STRING, T_NAME_QUALIFIED], true);
        }
    }

    return false;
}

/**
 * The declared constant names in a `const` statement, from just past the `const`
 * keyword up to the terminating `;`. Handles a multi-name `const A = 1, B = 2;`
 * (a name follows the `const` keyword or a *value-depth-0* `,`, never an `=`).
 *
 * Value nesting (`[`/`(`/`{`) is tracked so a comma *inside* an array/paren value  -
 * e.g. `const A = [User::class, Post::class]`  -  does not re-arm name collection and
 * mis-record the array value (`Post`) as a declared const. Only a comma at value
 * depth 0 separates real declarations.
 *
 * @param  array<int, array{0: int, 1: string, 2: int}|string>  $tokens
 * @return list<array{name: string, line: int}>
 */
function constDeclarationNames(array $tokens, int $index): array
{
    $count = count($tokens);
    $expectName = true;
    $depth = 0;

    /** @var list<array{name: string, line: int}> $names */
    $names = [];

    for ($i = $index; $i < $count; $i++) {
        $token = $tokens[$i];

        // The statement ends at a `;` in the const's own value scope.
        if ($token === ';' && $depth === 0) {
            break;
        }

        if ($token === '[' || $token === '(' || $token === '{') {
            $depth++;

            continue;
        }

        if ($token === ']' || $token === ')' || $token === '}') {
            $depth--;

            continue;
        }

        // Only a value-depth-0 `,` separates declarations; a comma inside a value
        // (an array/call argument list) is not a declaration boundary.
        if ($token === ',' && $depth === 0) {
            $expectName = true;

            continue;
        }

        if ($token === '=' && $depth === 0) {
            $expectName = false;

            continue;
        }

        if ($expectName && $depth === 0 && is_array($token) && $token[0] === T_STRING) {
            $names[] = ['name' => $token[1], 'line' => $token[2]];
            $expectName = false;
        }
    }

    return $names;
}
