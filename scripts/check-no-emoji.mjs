#!/usr/bin/env node
// Fails the build when a durable record carries an emoji code point.
//
// Enforces .claude/rules/no-emoji-in-durable-records.md, which was documented
// and unenforced: no job in the CI chain looked for a glyph, so the corpus
// could drift out of compliance with nothing reporting it (UAMS-Web/uams-statamic#2234).
//
// Scope is the paths that rule names -- `.claude/`, `docs/`, `README.md` and `AGENTS.md` -- plus `.github/`,
// whose issue and pull-request templates are durable records. `src/`, `tests/` are deliberately NOT scanned: the rule does
// not reach source files in this repository, and whether it should is a
// separate scope question (UAMS-Web/uams-statamic#2234).
//
// Two traps this implementation exists to avoid, both measured:
//
//   1. DECODING. A `perl -ne` scan over a code-point range matches nothing
//      without `-CSD`, because the input is read as Latin-1 -- no error, exit 0,
//      and an accurate file count, so the result is a FALSE ZERO rather than a
//      visible failure. The local-CI glyph probe read `glyphs=0` on every pull
//      request for a night for exactly that reason, having validated its regex
//      but not its invocation. Node decodes UTF-8 natively, so the class cannot
//      arise here -- that is why this is a Node script and not a one-liner.
//
//   2. TYPOGRAPHIC MARKS THAT ARE NOT EMOJI. `U+2122` and `U+00AE` sit beside
//      the emoji in any range wide enough to catch every real one, and they are
//      legitimate test data in entity-encoding and sanitizer fixtures. They are
//      excluded by name. The four genuine emoji a pure range misses are added by
//      name for the same reason: correctness here is a list, not an interval.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Code-point ranges that are emoji by block. */
export const RANGES = [
    [0x1f000, 0x1faff],
    [0x2600, 0x27bf],
    [0x2b00, 0x2bff],
];

/** Emoji-classified code points that fall outside those blocks. */
export const SINGLES = new Set([0xfe0f, 0x2139, 0x203c, 0x2049, 0x3030]);

/** Typographic marks inside the ranges that are NOT emoji and must not fail a build. */
export const EXCLUDED = new Set([0x2122, 0x00ae]);

/**
 * Files where a glyph is table data rather than ornament, and is therefore allowed.
 *
 * Empty. The only entries were the `afk-waves` tracking corpus (UAMS-Web/uams-statamic#2234, UAMS-Web/uams-statamic#2238), whose
 * status column used glyphs as cell values against a legend; that skill and its
 * catalog were removed, so nothing is exempt.
 *
 * Any future entry is an exact path rather than a pattern. A pattern over
 * `.claude/reference/` or over table syntax would carve out files nobody has looked
 * at, which is how an enforcement gap reopens quietly.
 *
 * @type {Set<string>}
 */
export const ALLOWED = new Set([]);

/** Roots the rule names. Anything outside them is out of scope by design. */
const ROOTS = ['.claude', '.github', 'docs'];
const FILES = ['README.md', 'AGENTS.md'];

/** Directories never worth scanning, and never covered by the rule. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'worktrees']);

export function isEmoji(codePoint) {
    if (EXCLUDED.has(codePoint)) return false;
    if (SINGLES.has(codePoint)) return true;

    return RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;

        const path = join(dir, name);
        const stats = statSync(path);

        if (stats.isDirectory()) walk(path, out);
        else if (stats.isFile()) out.push(path);
    }

    return out;
}

/**
 * Find every forbidden code point in a string, as `label -> first line`.
 *
 * The file loop and the self-check below BOTH go through this, which is the point:
 * a control that exercises a different path than the scan proves nothing about the
 * scan. See the self-check for why that distinction is load-bearing here.
 *
 * @param  {string}  text
 * @return {Map<string, number>}
 */
export function scanText(text) {
    // Iterating the string yields whole code points, so a surrogate pair is
    // read as one character rather than two halves that match nothing.
    const hits = [];
    let line = 1;
    for (const char of text) {
        if (char === '\n') {
            line += 1;
            continue;
        }

        const codePoint = char.codePointAt(0);
        if (!isEmoji(codePoint)) continue;

        hits.push({ label: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`, line });
    }

    return hits;
}

/**
 * Scan the corpus and report. Returns the process exit code rather than calling
 * `process.exit`, so a test can import this module without ending its own run.
 *
 * @return {number} 0 clean, 1 findings, 2 the self-check failed
 */
export function main() {
    const targets = [];
    for (const root of ROOTS) {
        try {
            walk(root, targets);
        } catch {
            // A root that does not exist in this checkout is not a failure.
        }
    }
    for (const file of FILES) {
        try {
            if (statSync(file).isFile()) targets.push(file);
        } catch {
            // Same.
        }
    }


    /*
     * SELF-CHECK, in the scanning invocation rather than in a test (UAMS-Web/uams-statamic#2234).
     *
     * The failure this exists for is not a wrong pattern -- it is a correct pattern that
     * never meets its input. A `perl -ne` range scan without `-CSD` reads UTF-8 as Latin-1
     * bytes, matches nothing, exits 0, and reports an accurate file count: a false zero
     * that is byte-identical to a clean corpus. A glyph probe read `glyphs=0` on every
     * pull request for a night that way, having validated its regex and not its harness.
     *
     * A separate unit test cannot close that. It proves the pattern is sound in the
     * process the test runs in, and says nothing about the process doing the scanning --
     * which is the layer that failed. So the guard proves its own detection here, on
     * every run, immediately before it trusts an empty result.
     */
    const CONTROL_EXPECTED = [0x1f680, 0x2705, 0x2b50, 0xfe0f, 0x2139, 0x203c, 0x2049, 0x3030];
    const CONTROL_ALLOWED = [0x2122, 0x00ae];

    const controlText = [
        CONTROL_EXPECTED.map((c) => String.fromCodePoint(c)).join(' '),
        CONTROL_ALLOWED.map((c) => String.fromCodePoint(c)).join(' '),
    ].join('\n');

    const controlFound = new Set(scanText(controlText).map((hit) => hit.label));
    const label = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    const controlMissed = CONTROL_EXPECTED.map(label).filter((name) => !controlFound.has(name));
    const controlFalsePositives = CONTROL_ALLOWED.map(label).filter((name) => controlFound.has(name));

    if (controlMissed.length > 0 || controlFalsePositives.length > 0) {
        console.error('no-emoji guard: SELF-CHECK FAILED - the scanner cannot see what it is looking for.');
        console.error('A clean result from this run would be meaningless, so it is not reported as one.');

        if (controlMissed.length > 0) {
            console.error(`  not detected:    ${controlMissed.join(' ')}`);
        }

        if (controlFalsePositives.length > 0) {
            console.error(`  wrongly flagged: ${controlFalsePositives.join(' ')}`);
        }

        return 2;
    }

    const findings = [];
    for (const path of targets) {
        const relativePath = relative(process.cwd(), path).split(sep).join('/');

        if (ALLOWED.has(relativePath)) continue;

        let text;
        try {
            text = readFileSync(path, 'utf8');
        } catch {
            continue;
        }

        const hits = scanText(text);

        if (hits.length > 0) {
            findings.push({ path: relativePath, hits });
        }
    }

    console.log(
        `no-emoji guard: self-check passed (${CONTROL_EXPECTED.length} detected, ${CONTROL_ALLOWED.length} correctly ignored)`
    );
    console.log(
        `no-emoji guard: scanned ${targets.length - ALLOWED.size} files under ${[...ROOTS, ...FILES].join(', ')}`,
        `(${ALLOWED.size} allowed by name)`
    );

    if (findings.length === 0) {
        console.log('no-emoji guard: clean');
        return 0;
    }

    const totalHits = findings.reduce((sum, finding) => sum + finding.hits.length, 0);

    console.error(`\nno-emoji guard: ${totalHits} emoji code point(s) in ${findings.length} file(s).\n`);

    /*
     * Every occurrence is listed, not the first per code point. Reporting one and hiding
     * its twin turns a sweep into a discovery loop: fix the line the guard named, re-run,
     * meet the next one. The per-file cap keeps a single dense file from burying the
     * others while still reporting its true count.
     */
    const PER_FILE_CAP = 20;

    for (const { path, hits } of findings) {
        for (const { label, line } of hits.slice(0, PER_FILE_CAP)) {
            console.error(`  ${path}:${line}  ${label}`);
        }

        if (hits.length > PER_FILE_CAP) {
            console.error(`  ${path}: ... and ${hits.length - PER_FILE_CAP} more in this file`);
        }
    }
    console.error(
        '\nSee .claude/rules/no-emoji-in-durable-records.md. Use words, not a glyph:',
        '\na line that needs a warning marker needs a clause naming what goes wrong.'
    );
    return 1;

}

// Run only when invoked as a script. process.argv[1] is the entry script; comparing
// its file URL to import.meta.url distinguishes that from being imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main());
}