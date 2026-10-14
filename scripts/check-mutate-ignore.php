<?php

declare(strict_types=1);

/**
 * Report `@pest-mutate-ignore` annotations that suppress nothing.
 *
 * The marker is parsed by `Pest\Mutate\Support\NodeVisitor::enterNode()` as
 * `preg_match('/@pest-mutate-ignore(.*)/', ...)`. `.` does not cross a newline, so the
 * captured tail is the remainder of the marker's own line; it is `explode(',')`d, each
 * part trimmed of `' *""/:'`, and compared against MUTATOR NAMES. Prose is never a place
 * the parser looks, and the failure is silent: the mutant simply keeps surviving, which
 * reads as a wrong reason rather than as an annotation that never applied.
 *
 * Flagged here, each measured against `pest-plugin-mutate` v5.0.2:
 *
 *   1. A tail that is neither empty nor a comma-separated list of known mutator names.
 *      `: GreaterToGreaterOrEqual because larastan needs it` left 4 of 4 mutants alive;
 *      the same line with a comma after the name left 3, because the first element then
 *      matches. The defect is punctuation-sensitive.
 *   2. A marker that does not begin its line. php-parser attaches a comment to the node
 *      that FOLLOWS it, so a trailing annotation on the statement's own line suppressed
 *      nothing (4 of 4 survived) -- MEASURED ON WINDOWS.
 *      REPORTED ONLY WHERE THE PLUGIN'S LINE MAP IS DEAD, which is what makes the
 *      comment-attachment path the only one left. Where the map is live a trailing
 *      annotation IS honored and this finding would be a false positive; the map dies
 *      when `MutationGenerator`'s `explode(PHP_EOL, ...)` split meets LF files on a
 *      CRLF runtime. `mutateIgnoreLineMapIsLive()` decides which of the two a run is
 *      looking at, by reading the installed plugin rather than by testing the platform,
 *      so an upstream fix to that split retires this finding instead of silently
 *      invalidating it.
 *   3. A bare marker with trailing whitespace, ON AN UNPATCHED PLUGIN ONLY. The tail is
 *      then `' '` -- non-empty, and matching no mutator -- so it suppresses nothing, where
 *      the same line without the space suppresses everything. `pint`'s
 *      `no_trailing_whitespace` removes it, so a formatting-only commit can flip mutation
 *      semantics in either direction.
 *      THIS REPOSITORY PATCHES THAT AWAY (UAMS-Web/uams-statamic#2327): the capture is trimmed before the empty
 *      test, so the two forms become identical and this reason is a FALSE POSITIVE wherever
 *      the patch is applied. The check is therefore skipped when the vendored plugin carries
 *      it, and kept when it does not -- which is every checkout whose `vendor/` predates the
 *      patch, since `composer install` does not re-patch an already-installed package.
 *
 * BOUND, stated because it decides how to read a clean run. This checks the ANNOTATION,
 * not the node beneath it. It cannot see the fourth failure mode -- a mutator that
 * targets the annotated node itself, such as `RemoveArrayItem` above an array entry,
 * which is not suppressible ON WINDOWS (measured: 10 of 10 mutants with the annotation
 * present). On macOS that case IS suppressible, by placing the annotation on the node's
 * own line where the line map reaches it -- so this bound is wider on Windows than on
 * macOS, for the same `PHP_EOL` reason as reason 2 above.
 * Deciding that requires mapping php-parser node types to each mutator's
 * `nodesToHandle()`, which this script does not attempt. So it is SOUND ON WHAT IT
 * FLAGS and NOT COMPLETE ON WHAT IT PASSES: a clean exit means no annotation is inert
 * for reasons 1-3, never that every annotation is effective.
 *
 * Usage:  php scripts/check-mutate-ignore.php [path ...]     (default: src tests)
 * Exit:   0 = nothing inert found, 1 = findings, 2 = usage/IO error.
 */
$roots = array_slice($argv, 1) ?: ['src', 'tests'];

$mutatorDir = __DIR__.'/../vendor/pestphp/pest-plugin-mutate/src/Mutators';
if (! is_dir($mutatorDir)) {
    fwrite(STDERR, "pest-plugin-mutate is not installed at {$mutatorDir}\n");
    exit(2);
}

/** @var array<string, true> $known */
/**
 * Whether the vendored plugin carries the annotation-parsing patch (UAMS-Web/uams-statamic#2327).
 *
 * The patch trims the captured tail before testing it for empty, which makes a bare marker
 * with trailing whitespace behave exactly like one without. Reason 3 is therefore correct
 * only against an unpatched plugin, and this is what decides which of the two a run is
 * looking at rather than assuming either.
 *
 * @return bool Whether the trim precedes the empty test in the vendored source.
 */
/**
 * Whether the plugin's per-line ignore map can actually reach this repository's files.
 *
 * Reason 2 below is correct only when the map is DEAD. `MutationGenerator` builds it with
 * `explode(PHP_EOL, $contents)`, and this repository's files are LF by policy
 * (`.gitattributes`), so on a runtime whose `PHP_EOL` is CRLF the split yields one element,
 * the map reaches nothing, and only php-parser's comment attachment remains. Where the map
 * IS live a trailing annotation is honored and reporting it is a false positive.
 *
 * This detects the installed plugin's BEHAVIOR rather than the platform, so an upstream fix
 * to that split retires the finding on its own instead of silently invalidating a
 * platform test. Both inputs are overridable so each branch can be exercised on either
 * platform  -  the alternative is a check whose Windows arm no macOS seat can run.
 *
 * @return bool Whether a trailing annotation is reachable through the line map.
 */
function mutateIgnoreLineMapIsLive(): bool
{
    $generator = getenv('MUTATE_IGNORE_GENERATOR_PATH')
        ?: __DIR__.'/../vendor/pestphp/pest-plugin-mutate/src/Support/MutationGenerator.php';

    if (! is_file($generator)) {
        return false;
    }

    $source = file_get_contents($generator);

    if (! is_string($source)) {
        return false;
    }

    $eol = getenv('MUTATE_IGNORE_EOL');
    $eol = $eol === false || $eol === '' ? PHP_EOL : str_replace(['\\r', '\\n'], ["\r", "\n"], $eol);

    // Still the PHP_EOL split: the map is live only where that separator matches the files.
    if (str_contains($source, 'explode(PHP_EOL,')) {
        return $eol === "\n";
    }

    // The split no longer keys on PHP_EOL, so the map is not separator-fragile any more.
    return true;
}

function mutateIgnoreTrimPatchApplied(): bool
{
    // The path is overridable so the two branches below can BOTH be exercised against a
    // stand-in file. Without that, a test can only assert whatever this function already
    // returns for the checkout it runs in, which would never catch this detection itself
    // being wrong. Not a behavior switch: the default is the real vendored path.
    $visitor = getenv('MUTATE_IGNORE_VISITOR_PATH')
        ?: __DIR__.'/../vendor/pestphp/pest-plugin-mutate/src/Support/NodeVisitor.php';

    if (! is_file($visitor)) {
        return false;
    }

    $source = file_get_contents($visitor);

    return is_string($source) && str_contains($source, '$mutatorsToIgnore = trim($matches[1]');
}

$known = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($mutatorDir));
foreach ($it as $file) {
    if ($file->isFile() && $file->getExtension() === 'php') {
        $known[$file->getBasename('.php')] = true;
    }
}
if ($known === []) {
    fwrite(STDERR, "no mutator names discovered under {$mutatorDir}\n");
    exit(2);
}

// Decides whether reason 3 applies to THIS checkout's vendored plugin, rather than
// assuming either state. See the header.
$trimPatchApplied = mutateIgnoreTrimPatchApplied();
$lineMapIsLive = mutateIgnoreLineMapIsLive();

$findings = [];

foreach ($roots as $root) {
    if (! is_dir($root)) {
        fwrite(STDERR, "not a directory: {$root}
");
        exit(2);
    }
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root));
    foreach ($files as $file) {
        if (! $file->isFile() || $file->getExtension() !== 'php') {
            continue;
        }
        $source = file_get_contents($file->getPathname());
        if ($source === false) {
            fwrite(STDERR, "cannot read {$file->getPathname()}
");
            exit(2);
        }

        // TOKENIZE rather than scan lines. A line-based reader cannot tell a comment
        // from a STRING that contains one, and this script's own test fixtures are
        // heredocs full of deliberately-inert annotations -- it reported three of them
        // as findings against itself. Restricting to comment tokens also retires the
        // earlier prose problem by construction: a docblock sentence mentioning the
        // marker is a comment, so it is still inspected, but the marker must open the
        // comment's content to count as an annotation.
        foreach (token_get_all($source) as $token) {
            if (! is_array($token) || ($token[0] !== T_COMMENT && $token[0] !== T_DOC_COMMENT)) {
                continue;
            }
            [$id, $text, $line] = $token;

            $at = strpos($text, '@pest-mutate-ignore');
            if ($at === false) {
                continue;
            }

            $where = $file->getPathname().':'.$line;

            // Strip the comment opener, then require the marker to be the first thing
            // inside. Anything else in front of it is prose ABOUT the marker.
            $body = preg_replace('{^(/\*\*?|//|#)}', '', $text, 1) ?? $text;
            $lead = substr($body, 0, strpos($body, '@pest-mutate-ignore') ?: 0);
            if (trim($lead, ' 	
*') !== '') {
                continue;                       // prose mentioning the marker
            }

            // A comment that does not START its own line attaches to the NEXT node.
            // Locate it by the TOKEN'S OWN LINE, not by searching the source for its text:
            // `// @pest-mutate-ignore` recurs, and strpos() would find the first one every
            // time. That regression was caught by this script's own positive control.
            $sourceLines = $sourceLines ?? preg_split('/\R/', $source);
            $thisLine = $sourceLines[$line - 1] ?? '';
            $markerAt = strpos($thisLine, '@pest-mutate-ignore');
            $before = $markerAt === false ? '' : substr($thisLine, 0, $markerAt);
            if (trim($before, ' 	/*#') !== '') {
                // Only inert where the line map is dead. Where it is live the plugin honors
                // a trailing annotation and this finding would be a false positive.
                if (! $lineMapIsLive) {
                    $findings[] = [$where, 'does not begin its line, so it attaches to the NEXT node', trim(explode('
', $text)[0])];

                    continue;
                }

                // Map live: the position is fine, so this annotation is legitimate AND its
                // tail still has to be a real mutator list. Falling through rather than
                // `continue`ing is what keeps `: NotAMutatorAtAll` reportable here  -  before
                // the position check was conditional, every trailing annotation was flagged
                // and the bad tail went with it, so nothing ever reached the tail checks.
            }

            preg_match('/@pest-mutate-ignore(.*)/', $text, $m);
            $tail = $m[1] ?? '';

            if ($tail === '') {
                continue;                       // bare and clean: suppresses every mutator
            }

            if (trim($tail) === '') {
                // Only inert on an unpatched plugin; with UAMS-Web/uams-statamic#2327's trim applied this
                // suppresses everything, exactly as the space-free form does.
                if (! $trimPatchApplied) {
                    $findings[] = [$where, 'bare marker with trailing whitespace suppresses NOTHING', trim(explode('
', $text)[0])];
                }

                continue;
            }

            $names = array_map(static fn (string $n): string => trim($n, ' 	*/:'), explode(',', $tail));
            $unknown = array_values(array_filter($names, static fn (string $n): bool => $n !== '' && ! isset($known[$n])));

            if ($unknown !== []) {
                $findings[] = [$where, 'tail is not a mutator list; unmatched: '.implode(', ', $unknown), trim(explode('
', $text)[0])];
            }
        }
    }
}

if ($findings === []) {
    echo "check-mutate-ignore: no inert annotations found (reasons 1-3; see docblock for what this cannot see)\n";
    exit(0);
}

foreach ($findings as [$where, $why, $line]) {
    echo "{$where}\n  {$why}\n  {$line}\n\n";
}
echo 'check-mutate-ignore: '.count($findings)." inert annotation(s)\n";
exit(1);
