<?php

declare(strict_types=1);

/**
 * Skip-baseline guard (UAMS-Web/uams-statamic#1744)  -  fail a Pest band whose skipped-test count exceeds
 * the count recorded for it.
 *
 * The gate treats "zero failures" as success, so a run that silently skips tests
 * reports PASS having tested less than it should have. During UAMS-Web/uams-statamic#1726's validation
 * three tests self-skipped and the band still passed  -  caught only because a skip
 * count had been predicted in advance and checked by hand.
 *
 * Skipping is how this suite degrades when content or Stache state is unavailable,
 * and that is deliberate: the content guards report an unresolvable entry as a
 * benign "requires the content/ submodule" skip (UAMS-Web/uams-statamic#1738), and a worker whose Stache
 * snapshot copy failed starves every content-dependent test in it (UAMS-Web/uams-statamic#1740). The
 * problem is not the skipping  -  it is that the coverage loss is invisible to the
 * gate, indistinguishable in the output from a healthy run.
 *
 * Written in PHP rather than Node deliberately: the `phpunit` job in ci.yml sets up
 * PHP but **not** Node, so a Node check would either fail there or force a new
 * toolchain pin into the job. This mirrors {@see check-parallel-safe-tests.php}.
 *
 * USAGE
 *     php scripts/check-skip-baseline.php --report=<junit.xml> --band=<parallel|serial>
 *                                         [--baseline=<path>]
 *
 * EXIT
 *     0  at or under baseline
 *     1  above baseline, or the report is missing/unreadable  -  a band that produced
 *        no report has not been verified, and treating that as a pass would
 *        reinstate the silence this guard exists to remove.
 */

/**
 * Extract every skipped `<testcase>` from a PHPUnit/paratest JUnit report.
 *
 * The discriminator is *structure*, not a tag count: a passing case is written
 * self-closing (`<testcase … />`), a skipped one wraps a `<skipped/>` child. A
 * parser keying on `<testcase` reports every test in the suite as skipped.
 *
 * Parsed with DOM rather than by regex because a test name is free text that
 * reaches the report as an attribute value, and libxml does not escape `>` there.
 * An attribute-scanning pattern ends its match on that `>` and re-enters the
 * document mid-element, so the case boundaries shift: verified against a report
 * where one *passing* test was named `it prefers a > b`, a regex parser still
 * counted the band's single skip but reported it as `(unnamed)`  -  losing exactly
 * the identity this guard exists to print.
 *
 * The skip *reason* is deliberately not extracted: PHPUnit 13 writes a bare
 * `<skipped/>` with no attributes ({@see JunitXmlLogger::createElement('skipped')})
 * and paratest's merger does the same, so there is no reason in the report to read.
 * The test identity is what the report can prove, and it is enough to go look.
 *
 * @param  string  $xml  The JUnit report contents
 * @return list<array{name: string, class: string}>
 *
 * @throws RuntimeException When the report is not parseable XML
 */
function parseSkippedCases(string $xml): array
{
    if (trim($xml) === '') {
        throw new RuntimeException('The JUnit report is empty  -  the band cannot be verified.');
    }

    $document = new DOMDocument;

    // A truncated report (a band killed mid-write) must fail, never read as zero.
    if (! @$document->loadXML($xml)) {
        throw new RuntimeException('The JUnit report is not parseable XML  -  the band cannot be verified.');
    }

    $skipped = [];

    /** @var DOMNodeList<DOMElement> $cases */
    $cases = (new DOMXPath($document))->query('//testcase[skipped]');

    foreach ($cases as $case) {
        // paratest's merger writes `class`; PHPUnit's own logger writes `classname`.
        $class = $case->getAttribute('class') !== ''
            ? $case->getAttribute('class')
            : $case->getAttribute('classname');

        $skipped[] = [
            'name' => $case->getAttribute('name') !== '' ? $case->getAttribute('name') : '(unnamed)',
            'class' => $class,
        ];
    }

    return $skipped;
}

/**
 * Compare a band's skips against its baseline.
 *
 * Under-baseline never fails: fewer skips means more tests ran, and failing there
 * would punish the fix for a skip.
 *
 * @param  list<array{name: string, class: string}>  $skippedCases
 * @param  int  $expected  The recorded baseline for this band
 * @return array{ok: bool, actual: int, expected: int, excess: int, under: bool}
 */
function evaluateSkipBaseline(array $skippedCases, int $expected): array
{
    $actual = count($skippedCases);
    $excess = $actual - $expected;

    return [
        'ok' => $excess <= 0,
        'actual' => $actual,
        'expected' => $expected,
        'excess' => $excess,
        'under' => $excess < 0,
    ];
}

/**
 * Read a band's expected skip count out of the baseline document.
 *
 * @param  string  $baselineRaw  The baseline JSON
 * @param  string  $band  The band key (`parallel` or `serial`)
 * @return int The expected skip count
 *
 * @throws RuntimeException When the band has no recorded baseline
 */
function expectedSkipsForBand(string $baselineRaw, string $band): int
{
    /** @var array{bands?: array<string, array{expected?: mixed}>}|null $parsed */
    $parsed = json_decode($baselineRaw, true);
    $expected = $parsed['bands'][$band]['expected'] ?? null;

    if (! is_int($expected)) {
        throw new RuntimeException("No skip baseline recorded for band \"{$band}\".");
    }

    return $expected;
}

$options = getopt('', ['report:', 'band:', 'baseline::']);
$report = $options['report'] ?? null;
$band = $options['band'] ?? null;

if (! is_string($report) || ! is_string($band)) {
    fwrite(STDERR, "Usage: php scripts/check-skip-baseline.php --report=<junit.xml> --band=<parallel|serial> [--baseline=<path>]\n");
    exit(1);
}

$baselinePath = is_string($options['baseline'] ?? null)
    ? $options['baseline']
    : dirname(__DIR__).'/tests/skip-baseline.json';

if (! is_file($report)) {
    fwrite(STDERR, "Skip baseline: no JUnit report at {$report}  -  the band cannot be verified.\n");
    exit(1);
}

if (! is_file($baselinePath)) {
    fwrite(STDERR, "Skip baseline: no baseline document at {$baselinePath}.\n");
    exit(1);
}

// A misconfigured guard must read as a failure, not as a stack trace  -  every
// throw below names a band this run could not verify.
try {
    $expected = expectedSkipsForBand((string) file_get_contents($baselinePath), $band);
    $skipped = parseSkippedCases((string) file_get_contents($report));
} catch (RuntimeException $failure) {
    fwrite(STDERR, "Skip baseline: {$failure->getMessage()}\n");
    exit(1);
}

$result = evaluateSkipBaseline($skipped, $expected);

if ($result['ok']) {
    $note = $result['under'] ? ' (below baseline  -  more tests ran than expected)' : '';
    echo "Skip baseline OK: {$band} band skipped {$result['actual']}, baseline {$result['expected']}{$note}.\n";
    exit(0);
}

fwrite(STDERR, "Skip baseline EXCEEDED: {$band} band skipped {$result['actual']}, baseline {$result['expected']} (+{$result['excess']}).\n");
fwrite(STDERR, "Tests skipped in this band:\n");

foreach ($skipped as $case) {
    fwrite(STDERR, "  - {$case['class']}::{$case['name']}\n");
}

fwrite(
    STDERR,
    "\nA skip above baseline means the band tested LESS than it should have and would "
    .'otherwise have reported PASS. Find why the test stopped running (a starved Stache '
    .'worker per #1740, an uninitialized content/ submodule, a guard firing on a lookup '
    ."that should have resolved per #1738) before touching {$baselinePath}.\n"
);

exit(1);
