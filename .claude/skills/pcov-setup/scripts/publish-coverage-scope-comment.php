<?php

declare(strict_types=1);

/**
 * Upsert the single GitHub issue comment that mirrors coverage-scope.csv.
 *
 * Always maintains exactly one tracker comment on the issue: find every
 * comment whose body contains the tracker marker, PATCH the oldest, and
 * DELETE any extras. POST only when none exist. Never add a second tracker
 * comment for progress updates. Full inventories that exceed GitHub's
 * comment size budget (~65 KiB) publish a summary + progress table plus a
 * directory roll-up; the CSV on disk remains the full source.
 *
 * Usage:
 *   php publish-coverage-scope-comment.php --issue=2834 [--repo=UAMS-Web/uams-statamic] [--csv=<path>] [--root=<path>]
 * Exit: 0 = published, 1 = bad args / missing csv, 2 = root not found, 3 = gh failed.
 */
const TRACKER_MARKER = '<!-- coverage-scope-tracker -->';
const COMMENT_BUDGET = 60000;
/** Default pass-3 eligibility floor: p25 of finished pass-2 distribution (#2834). */
const DEFAULT_PASS2_MIN = 86.7;

$arguments = array_slice($argv, 1);
$issue = null;
$repo = 'UAMS-Web/uams-statamic';
$csvPath = null;
$rootOverride = null;
$pass2Min = DEFAULT_PASS2_MIN;

foreach ($arguments as $argument) {
    if (str_starts_with($argument, '--issue=')) {
        $issue = substr($argument, strlen('--issue='));
    } elseif (str_starts_with($argument, '--repo=')) {
        $repo = substr($argument, strlen('--repo='));
    } elseif (str_starts_with($argument, '--csv=')) {
        $csvPath = substr($argument, strlen('--csv='));
    } elseif (str_starts_with($argument, '--root=')) {
        $rootOverride = substr($argument, strlen('--root='));
    } elseif (str_starts_with($argument, '--pass2-min=')) {
        $pass2Min = (float) substr($argument, strlen('--pass2-min='));
    } elseif ($argument === '--help' || $argument === '-h') {
        fwrite(STDOUT, "Usage: php publish-coverage-scope-comment.php --issue=N [--repo=org/name] [--csv=<path>] [--root=<path>] [--pass2-min=86.7]\n");

        exit(0);
    } else {
        fwrite(STDERR, "publish-coverage-scope-comment: unknown argument {$argument}\n");

        exit(1);
    }
}

if ($issue === null || $issue === '') {
    fwrite(STDERR, "publish-coverage-scope-comment: --issue=N is required\n");

    exit(1);
}

$root = $rootOverride !== null && is_dir($rootOverride)
    ? realpath($rootOverride) ?: $rootOverride
    : findRepositoryRoot(__DIR__);

if ($root === null || $root === false) {
    fwrite(STDERR, "publish-coverage-scope-comment: repository root not found (pass --root=).\n");

    exit(2);
}

$root = str_replace('\\', '/', $root);
$csvPath ??= is_dir($root.'/storage/app')
    ? $root.'/storage/app/coverage-scope.csv'
    : $root.'/coverage-scope.csv';

if (! is_file($csvPath)) {
    fwrite(STDERR, "publish-coverage-scope-comment: missing {$csvPath}\n");

    exit(1);
}

$rows = readCsvRows($csvPath);
$csvDisplay = normalizeRel($root, $csvPath);
$body = renderTrackerMarkdown($rows, $csvDisplay, $issue, $pass2Min);

$tmp = tempnam(sys_get_temp_dir(), 'cov-scope-');
if ($tmp === false) {
    fwrite(STDERR, "publish-coverage-scope-comment: tempnam failed\n");

    exit(1);
}

file_put_contents($tmp, $body);

$trackerIds = findTrackerCommentIds($repo, $issue);
$commentId = $trackerIds[0] ?? null;

if (count($trackerIds) > 1) {
    $extras = array_slice($trackerIds, 1);
    fwrite(
        STDERR,
        'publish-coverage-scope-comment: deleting '.count($extras)
        ." duplicate tracker comment(s) on {$repo}#{$issue}\n"
    );
    foreach ($extras as $extraId) {
        deleteIssueComment($repo, $extraId);
    }
}

if ($commentId !== null) {
    $cmd = [
        'gh',
        'api',
        '-X',
        'PATCH',
        "repos/{$repo}/issues/comments/{$commentId}",
        '-F',
        'body=@'.$tmp,
    ];
    $action = 'Updated';
} else {
    $cmd = [
        'gh',
        'api',
        '-X',
        'POST',
        "repos/{$repo}/issues/{$issue}/comments",
        '-F',
        'body=@'.$tmp,
    ];
    $action = 'Created';
}

[$exit, $stdout, $stderr] = runGh($cmd, $root);
unlink($tmp);

if ($exit !== 0) {
    fwrite(STDERR, $stderr !== '' ? $stderr : "gh exit {$exit}\n");

    exit(3);
}

$decoded = json_decode($stdout, true);
$url = is_array($decoded) ? (string) ($decoded['html_url'] ?? '') : '';
fwrite(STDOUT, "{$action} tracker comment on {$repo}#{$issue}\n");
if ($url !== '') {
    fwrite(STDOUT, $url."\n");
}
fwrite(STDOUT, 'body bytes: '.strlen($body)."\n");

exit(0);

/**
 * @return list<array{file: string, pass1: string, pass2: string, pass3: string}>
 */
function readCsvRows(string $path): array
{
    $handle = fopen($path, 'rb');
    if ($handle === false) {
        return [];
    }

    $header = fgetcsv($handle, null, ',', '"', '\\');
    unset($header);
    $rows = [];
    while (($row = fgetcsv($handle, null, ',', '"', '\\')) !== false) {
        if (($row[0] ?? '') === '') {
            continue;
        }

        $rows[] = [
            'file' => (string) $row[0],
            'pass1' => (string) ($row[1] ?? ''),
            'pass2' => (string) ($row[2] ?? ''),
            'pass3' => (string) ($row[3] ?? ''),
        ];
    }

    fclose($handle);

    return $rows;
}

/**
 * @param  list<array{file: string, pass1: string, pass2: string, pass3: string}>  $rows
 */
function renderTrackerMarkdown(
    array $rows,
    string $csvPath,
    string $issue,
    float $pass2Min
): string {
    $total = count($rows);
    $pass1Yes = 0;
    $pass2Filled = 0;
    $pass3Eligible = 0;
    $pass3BelowBar = 0;
    $pass3Filled = 0;
    $pass3Yes = 0;
    $dirs = [];

    foreach ($rows as $row) {
        if ($row['pass1'] === 'yes') {
            $pass1Yes++;
        }
        if ($row['pass2'] !== '') {
            $pass2Filled++;
            $pct = (float) $row['pass2'];
            if ($pct >= $pass2Min) {
                $pass3Eligible++;
            } else {
                $pass3BelowBar++;
            }
        }
        if ($row['pass3'] !== '') {
            $pass3Filled++;
            if ($row['pass3'] === 'yes') {
                $pass3Yes++;
            }
        }

        $parts = explode('/', $row['file']);
        $dir = ($parts[0] ?? '').'/'.($parts[1] ?? '');
        $dirs[$dir] ??= ['total' => 0, 'p1' => 0, 'p2' => 0, 'p3' => 0];
        $dirs[$dir]['total']++;
        if ($row['pass1'] === 'yes') {
            $dirs[$dir]['p1']++;
        }
        if ($row['pass2'] !== '') {
            $dirs[$dir]['p2']++;
        }
        if ($row['pass3'] !== '') {
            $dirs[$dir]['p3']++;
        }
    }

    ksort($dirs);
    $pass2MinLabel = rtrim(rtrim(number_format($pass2Min, 1, '.', ''), '0'), '.');

    $lines = [
        TRACKER_MARKER,
        '## Coverage scope tracker',
        '',
        'Living view of `storage/app/coverage-scope.csv` for #'.$issue.'. Refresh after each pass-2 / pass-3 batch with `publish-coverage-scope-comment.php`.',
        '',
        '### Counts',
        '',
        '| Metric | Count |',
        '| --- | ---: |',
        "| Inventory files | {$total} |",
        "| Pass 1 touched (`yes`) | {$pass1Yes} |",
        "| Pass 2 line % filled | {$pass2Filled} |",
        "| Pass 3 eligible (pass2 ≥ {$pass2MinLabel}%) | {$pass3Eligible} |",
        "| Pass 3 below bar (pass2 < {$pass2MinLabel}%) | {$pass3BelowBar} |",
        "| Pass 3 mutation-clean filled | {$pass3Filled} |",
        "| Pass 3 `yes` | {$pass3Yes} |",
        '',
        '### Pass plan',
        '',
        '1. **Pass 1 (one set)**: `build-coverage-scope-csv.php --pass1`: FQCN referenced in `tests/`.',
        '2. **Pass 2 (~30s batches)**: `--pass2 --batch=3` (calibrate per machine): line % for each `pass1=yes` row still empty. **Done** for this inventory.',
        '3. **Pass 3 eligibility bar**: **'.$pass2MinLabel.'%** (p25 of the finished pass-2 distribution). Pass 2 stays the measured %; the bar only selects who enters pass 3.',
        '4. **Pass 3 (~30s batches)**: mutation-clean for each eligible row. `pass3_mutation_clean` = `yes` / `no` / short note for explained survivors.',
        '',
        'Local CSV path: `'.$csvPath.'`.',
        '',
    ];

    $pass3Progress = array_values(array_filter(
        $rows,
        static fn (array $row): bool => $row['pass3'] !== ''
    ));

    $lines[] = '### Progress (pass 3)';
    $lines[] = '';
    if ($pass3Progress === []) {
        $lines[] = '_No pass 3 cells filled yet._';
        $lines[] = '';
    } else {
        $lines[] = '| file | pass1 | pass2 % | pass3 |';
        $lines[] = '| --- | --- | --- | --- |';
        foreach ($pass3Progress as $row) {
            $lines[] = '| `'.$row['file'].'` | '.$row['pass1'].' | '.$row['pass2'].' | '.$row['pass3'].' |';
        }
        $lines[] = '';
    }

    $belowBar = array_values(array_filter(
        $rows,
        static function (array $row) use ($pass2Min): bool {
            return $row['pass2'] !== '' && (float) $row['pass2'] < $pass2Min;
        }
    ));

    $lines[] = '### Below bar (pass2 < '.$pass2MinLabel.'%)';
    $lines[] = '';
    if ($belowBar === []) {
        $lines[] = '_None._';
        $lines[] = '';
    } else {
        $lines[] = '| file | pass2 % |';
        $lines[] = '| --- | ---: |';
        foreach ($belowBar as $row) {
            $lines[] = '| `'.$row['file'].'` | '.$row['pass2'].' |';
        }
        $lines[] = '';
    }

    $lines[] = '### Inventory by directory';
    $lines[] = '';
    $lines[] = '| directory | files | pass1 yes | pass2 filled | pass3 filled |';
    $lines[] = '| --- | ---: | ---: | ---: | ---: |';
    foreach ($dirs as $dir => $counts) {
        $lines[] = '| `'.$dir.'` | '.$counts['total'].' | '.$counts['p1'].' | '.$counts['p2'].' | '.$counts['p3'].' |';
    }
    $lines[] = '';

    $fullTable = renderFullTable($rows);
    $candidate = implode("\n", $lines)."\n### Full inventory\n\n".$fullTable."\n";

    if (strlen($candidate) <= COMMENT_BUDGET) {
        $lines[] = '### Full inventory';
        $lines[] = '';
        $lines[] = $fullTable;
        $lines[] = '';
    } else {
        $lines[] = '### Full inventory';
        $lines[] = '';
        $lines[] = 'Omitted here: the compact full table is '.strlen($fullTable).' bytes and exceeds the GitHub comment budget. The Progress and directory tables above are the published view; the complete matrix stays in `storage/app/coverage-scope.csv`.';
        $lines[] = '';
    }

    return implode("\n", $lines);
}

/**
 * @param  list<array{file: string, pass1: string, pass2: string, pass3: string}>  $rows
 */
function renderFullTable(array $rows): string
{
    $lines = [
        '| file | p1 | p2 | p3 |',
        '| --- | --- | --- | --- |',
    ];

    foreach ($rows as $row) {
        $file = preg_replace('#^app/#', '', $row['file']) ?? $row['file'];
        $lines[] = '| `'.$file.'` | '.$row['pass1'].' | '.$row['pass2'].' | '.$row['pass3'].' |';
    }

    return implode("\n", $lines);
}

/**
 * Issue comment IDs whose bodies contain the tracker marker, oldest first.
 *
 * @return list<string>
 */
function findTrackerCommentIds(string $repo, string $issue): array
{
    // Match contains() so a leading BOM / blank line still finds the comment;
    // order by id ascending so index 0 is the original tracker to keep.
    $cmd = [
        'gh',
        'api',
        "repos/{$repo}/issues/{$issue}/comments?per_page=100",
        '--jq',
        '[.[] | select(.body | contains('.json_encode(TRACKER_MARKER).')) | .id] | sort | .[]',
    ];

    [$exit, $stdout] = runGh($cmd, null);
    if ($exit !== 0 || trim($stdout) === '') {
        return [];
    }

    $ids = [];
    foreach (preg_split('/\R/', trim($stdout)) ?: [] as $line) {
        $line = trim($line);
        if ($line !== '' && ctype_digit($line)) {
            $ids[] = $line;
        }
    }

    return $ids;
}

/**
 * Delete a stray duplicate tracker comment.
 */
function deleteIssueComment(string $repo, string $commentId): void
{
    [$exit, , $stderr] = runGh(
        [
            'gh',
            'api',
            '-X',
            'DELETE',
            "repos/{$repo}/issues/comments/{$commentId}",
        ],
        null
    );

    if ($exit !== 0) {
        fwrite(
            STDERR,
            "publish-coverage-scope-comment: failed to delete comment {$commentId}: "
            .($stderr !== '' ? $stderr : "exit {$exit}")."\n"
        );
    }
}

/**
 * Run `gh` and capture stdout/stderr.
 *
 * @param  list<string>  $cmd
 * @return array{0: int, 1: string, 2: string}
 */
function runGh(array $cmd, ?string $cwd): array
{
    $descriptor = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    $process = proc_open(
        $cmd,
        $descriptor,
        $pipes,
        $cwd
    );
    if (! is_resource($process)) {
        return [1, '', 'failed to start gh'];
    }

    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]) ?: '';
    $stderr = stream_get_contents($pipes[2]) ?: '';
    fclose($pipes[1]);
    fclose($pipes[2]);

    return [proc_close($process), $stdout, $stderr];
}

function findRepositoryRoot(string $start): ?string
{
    $dir = realpath($start) ?: $start;

    while (true) {
        if (
            is_file($dir.'/vendor/autoload.php')
            || is_file($dir.'/phpunit.xml')
            || is_file($dir.'/phpunit.xml.dist')
        ) {
            return $dir;
        }

        $parent = dirname($dir);
        if ($parent === $dir) {
            return null;
        }

        $dir = $parent;
    }
}

function normalizeRel(string $root, string $absolute): string
{
    $rootNorm = rtrim(str_replace('\\', '/', $root), '/').'/';
    $absNorm = str_replace('\\', '/', $absolute);

    if (str_starts_with($absNorm, $rootNorm)) {
        return substr($absNorm, strlen($rootNorm));
    }

    return $absNorm;
}
