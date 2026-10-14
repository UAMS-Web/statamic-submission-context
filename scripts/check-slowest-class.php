<?php

declare(strict_types=1);

/**
 * Slowest-class cost guard (UAMS-Web/uams-statamic#1890)  -  fail a Pest band whose costliest test class
 * takes too large a SHARE of the band's summed class time (UAMS-Web/uams-statamic#2530), or exceeds a
 * generous absolute backstop.
 *
 * The gate reports PASS on any duration, so nothing in the repo pins what the
 * parallel band costs and a change that reclaims it passes in silence. That has
 * happened twice, and neither time did anything go red:
 *
 * - UAMS-Web/uams-statamic#1348 added `mitydigital/sitemapamic`, which registers one `sitemap.xml` route
 *   per site  -  255 on this multisite. Laravel's uncached URL generation scales with
 *   route count, so the render-heavy suite paid a ~2x tax on every test. Finding it
 *   took a wall-time bisect across a fixed 226-file set at successive commits
 *   (UAMS-Web/uams-statamic#1521 -> UAMS-Web/uams-statamic#1573).
 * - One class grew to 1085.3s  -  83% of a 1306s band. SchemaJsonLdLocationTest bound
 *   the band while eleven of twelve workers idled, and it surfaced only because
 *   UAMS-Web/uams-statamic#1718's sharding spike happened to run a per-class profile (UAMS-Web/uams-statamic#1797).
 *
 * WHAT THE NUMBER IS. A JUnit `time` attribute is the WALL-CLOCK time each test
 * took, not the CPU time it used. So a class's summed `time` moves with machine load
 * exactly as the band's wall time does: on an oversubscribed host every class
 * inflates together. UAMS-Web/uams-statamic#2525 red the `pest` job this way on a branch that changed
 * nothing relevant  -  identical test and assertion counts, the costliest class up
 * from 263.7s to 784.9s, while the host carried eleven competing `pest` processes at
 * a 15-minute load average of 28.9 on 12 cores. An absolute ceiling on that number
 * is the flaky wall-time assert UAMS-Web/uams-statamic#1537 ruled out, one level down.
 *
 * WHY A SHARE. The costliest class's share of the band's summed class time is
 * dimensionless, so inflation that hits every class alike cancels out of it. It is
 * also the quantity that decides whether a class binds the parallel band: paratest
 * distributes by class, so no scheduler finishes sooner than its largest single
 * unit, and a class starts costing wall-clock once its share passes 1/workers.
 *
 * WHY AN ABSOLUTE BACKSTOP AS WELL. A share cannot see growth that hits every class
 * at once  -  a per-test boot cost, like UAMS-Web/uams-statamic#1348's route-count tax, raises every class
 * together and leaves every share where it was. The backstop catches that, and it is
 * set far enough above contended readings that load alone does not reach it.
 *
 * The signal costs nothing extra: the `phpunit` job already runs both bands under
 * `--log-junit`, and a JUnit report carries a `time` attribute per `<testcase>`.
 *
 * Written in PHP rather than Node deliberately: the `phpunit` job in ci.yml sets up
 * PHP but **not** Node, so a Node check would either fail there or force a new
 * toolchain pin into the job. This mirrors {@see check-skip-baseline.php}, whose
 * shape it follows throughout.
 *
 * USAGE
 *     php scripts/check-slowest-class.php --report=<junit.xml> [--band=<name>]
 *                                         [--share-ceiling=<percent>]
 *                                         [--ceiling=<seconds>]
 *
 * EXIT
 *     0  the costliest class is within both its share ceiling and the backstop
 *     1  it is over either one, or the report is missing, unparseable, or carries no
 *        durations  -  a band that produced no usable report has not been verified,
 *        and passing it would reinstate the silence this guard exists to remove.
 */

/**
 * The committed share ceilings, in percent of a band's summed class time, per band.
 *
 * PLACEHOLDER, NOT MEASURED. This add-on has two tests, so one class is most of the band by
 * construction and any share ceiling below 100 would fail on a healthy run. 100.0 makes the
 * share check inert until the suite is big enough for a share to mean something; the absolute
 * backstop below is the live check meanwhile. When the suite has a dozen or so classes, take a
 * few rounds of `--log-junit` readings (one quiet, one under load), set each ceiling well above
 * the worst reading, and record the table here the way the originating repository did
 * (UAMS-Web/uams-statamic, `scripts/check-slowest-class.php`).
 *
 * A band name without its own entry takes the parallel ceiling.
 *
 * Raising a ceiling is a deliberate, reviewable act. A class over it is closing on the point
 * where it bounds the band while the other workers idle; split it rather than moving the number.
 *
 * @var array<string, float>
 */
const SLOWEST_CLASS_SHARE_CEILING_PERCENT = [
    'parallel' => 100.0,
];

/**
 * The absolute backstop, in seconds, for any single test class.
 *
 * PLACEHOLDER, NOT MEASURED: the suite runs in about a second, so 120s is a loose catch for
 * growth no share can see (a per-test boot cost that slows every class alike). Re-measure it
 * with the share ceilings above.
 */
const SLOWEST_CLASS_BACKSTOP_SECONDS = 120.0;

/**
 * Sum each test class's `time` across every `<testcase>` in a JUnit report.
 *
 * Parsed with DOM rather than by regex because a test name is free text that reaches
 * the report as an attribute value, and libxml does not escape `>` there. An
 * attribute-scanning pattern ends its match on that `>` and re-enters the document
 * mid-element, shifting every case boundary after it  -  the failure
 * {@see check-skip-baseline.php} records having verified against a real report.
 *
 * Aggregated from `<testcase>` rather than read off `<testsuite time="…">` because
 * paratest MERGES per-process reports: one class can appear as several `<testsuite>`
 * elements, and taking any single one under-reports the class. Summing the leaves is
 * correct under either shape.
 *
 * @param  string  $xml  The JUnit report contents
 * @return array<string, float> Total seconds per class, highest first
 *
 * @throws RuntimeException When the report is not parseable XML, or carries no timings
 */
function slowestClassTotals(string $xml): array
{
    if (trim($xml) === '') {
        throw new RuntimeException('The JUnit report is empty  -  the band cannot be verified.');
    }

    $document = new DOMDocument;

    // A truncated report (a band killed mid-write) must fail, never read as zero.
    if (! @$document->loadXML($xml)) {
        throw new RuntimeException('The JUnit report is not parseable XML  -  the band cannot be verified.');
    }

    $totals = [];

    /** @var DOMNodeList<DOMElement> $cases */
    $cases = (new DOMXPath($document))->query('//testcase');

    foreach ($cases as $case) {
        // paratest's merger writes `class`; PHPUnit's own logger writes `classname`.
        // A case carrying neither is still counted, under a name that says so  -
        // dropping it would be the silent under-report this guard exists to remove.
        $class = $case->getAttribute('class') !== ''
            ? $case->getAttribute('class')
            : ($case->getAttribute('classname') !== '' ? $case->getAttribute('classname') : '(unattributed)');

        $totals[$class] = ($totals[$class] ?? 0.0) + (float) $case->getAttribute('time');
    }

    if ($totals === []) {
        throw new RuntimeException('The JUnit report holds no <testcase> elements  -  the band cannot be verified.');
    }

    // Every case timed at zero means the report carries no usable durations, so a
    // PASS here would assert nothing at all. That is a setup failure, not a pass  -
    // the same reasoning the mutation smoke applies to `0 Mutations`.
    if (array_sum($totals) <= 0.0) {
        throw new RuntimeException('The JUnit report carries no test durations  -  the band cannot be verified.');
    }

    arsort($totals);

    return $totals;
}

/**
 * Judge the costliest class against its share ceiling and the absolute backstop.
 *
 * @param  array<string, float>  $totals  Total seconds per class, highest first
 * @param  float  $shareCeiling  The share ceiling, in percent of summed class time
 * @param  float  $backstop  The absolute per-class backstop in seconds
 * @return array{ok: bool, class: string, seconds: float, summed: float, share: float, shareCeiling: float, shareOk: bool, backstop: float, backstopOk: bool}
 */
function evaluateSlowestClass(array $totals, float $shareCeiling, float $backstop): array
{
    $class = (string) array_key_first($totals);
    $seconds = $totals[$class];
    $summed = array_sum($totals);
    $share = 100.0 * $seconds / $summed;

    $shareOk = $share <= $shareCeiling;
    $backstopOk = $seconds <= $backstop;

    return [
        'ok' => $shareOk && $backstopOk,
        'class' => $class,
        'seconds' => $seconds,
        'summed' => $summed,
        'share' => $share,
        'shareCeiling' => $shareCeiling,
        'shareOk' => $shareOk,
        'backstop' => $backstop,
        'backstopOk' => $backstopOk,
    ];
}

$options = getopt('', ['report:', 'band::', 'share-ceiling::', 'ceiling::']);
$report = $options['report'] ?? null;
$band = is_string($options['band'] ?? null) ? $options['band'] : 'suite';

if (! is_string($report)) {
    fwrite(STDERR, "Usage: php scripts/check-slowest-class.php --report=<junit.xml> [--band=<name>] [--share-ceiling=<percent>] [--ceiling=<seconds>]\n");
    exit(1);
}

// An override that does not parse must fail rather than fall back to the committed
// number, since judging the band against a ceiling nobody asked for is a verdict on
// the wrong question. Read from argv rather than from getopt, which reports
// `--share-ceiling 5` (a space, not `=`) as a flag with no value and drops an empty
// `--ceiling=` altogether.
foreach (array_slice($argv, 1) as $argument) {
    if (preg_match('/^--(share-ceiling|ceiling)(?:=(.*))?$/', (string) $argument, $flag) === 1) {
        $value = $flag[2] ?? '';

        if (! is_numeric($value) || (float) $value <= 0.0) {
            fwrite(STDERR, "Slowest class: --{$flag[1]} needs a positive number, written as --{$flag[1]}=<value>.\n");
            exit(1);
        }
    }
}

$shareCeiling = is_string($options['share-ceiling'] ?? null)
    ? (float) $options['share-ceiling']
    : (SLOWEST_CLASS_SHARE_CEILING_PERCENT[$band] ?? SLOWEST_CLASS_SHARE_CEILING_PERCENT['parallel']);

$backstop = is_string($options['ceiling'] ?? null)
    ? (float) $options['ceiling']
    : SLOWEST_CLASS_BACKSTOP_SECONDS;

if (! is_file($report)) {
    fwrite(STDERR, "Slowest class: no JUnit report at {$report}  -  the {$band} band cannot be verified.\n");
    exit(1);
}

// A misconfigured guard must read as a failure, not as a stack trace  -  every throw
// above names a band this run could not verify.
try {
    $totals = slowestClassTotals((string) file_get_contents($report));
} catch (RuntimeException $failure) {
    fwrite(STDERR, "Slowest class: {$failure->getMessage()}\n");
    exit(1);
}

$result = evaluateSlowestClass($totals, $shareCeiling, $backstop);

if ($result['ok']) {
    printf(
        "Slowest class OK: %s band's costliest class is %s at %.1fs, %.2f%% of %.1fs summed class time (share ceiling %.2f%%, backstop %.1fs).\n",
        $band,
        $result['class'],
        $result['seconds'],
        $result['share'],
        $result['summed'],
        $result['shareCeiling'],
        $result['backstop'],
    );
    exit(0);
}

if (! $result['shareOk']) {
    fwrite(STDERR, sprintf(
        "Slowest class EXCEEDED: %s band's %s is %.2f%% of %.1fs summed class time, share ceiling %.2f%% (over by %.2f points).\n",
        $band,
        $result['class'],
        $result['share'],
        $result['summed'],
        $result['shareCeiling'],
        $result['share'] - $result['shareCeiling'],
    ));
}

if (! $result['backstopOk']) {
    fwrite(STDERR, sprintf(
        "Slowest class EXCEEDED: %s band's %s cost %.1fs, backstop %.1fs (over by %.1fs).\n",
        $band,
        $result['class'],
        $result['seconds'],
        $result['backstop'],
        $result['seconds'] - $result['backstop'],
    ));
}

fwrite(STDERR, "Costliest classes in this band:\n");

foreach (array_slice($totals, 0, 5, true) as $class => $seconds) {
    fwrite(STDERR, sprintf("  %8.1fs  %6.2f%%  %s\n", $seconds, 100.0 * $seconds / $result['summed'], $class));
}

fwrite(
    STDERR,
    "\nparatest distributes by CLASS, so the band cannot finish sooner than its largest "
    .'one  -  a class this size bounds the whole run while the other workers idle (#1797 '
    .'found one at 1085.3s of a 1306s band). Split the class rather than raising a '
    .'ceiling in scripts/check-slowest-class.php. A share is load-invariant, so a share '
    .'failure is a property of the change, not of a busy host (#2530). '
    .'`vendor/bin/pest --update-shards` writes a per-class profile to diagnose it, but '
    .'note it runs the suite functionally at roughly 4x the CPU, so it is the follow-up '
    ."diagnostic and never a band time.\n"
);

exit(1);
