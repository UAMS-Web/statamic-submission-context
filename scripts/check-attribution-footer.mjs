#!/usr/bin/env node
// Fails when a pull-request body carries the harness attribution footer (UAMS-Web/uams-statamic#2701).
//
// UAMS-Web/uams-statamic#2321 forbids that footer in pull-request and issue bodies, and the harness
// instructs authors to add it, so it arrives on pull request after pull request
// and was being removed by hand at the gate. No existing check could see it:
// `check-no-emoji.mjs` scans the filesystem, and a body is not on it.
//
// The footer arrives in three forms, measured on the UAMS-Web/uams-statamic#2701 specimens: a marker
// line carrying an emoji, a bare harness session URL carrying no emoji at all,
// or both together. So a hit is EITHER marker. A check keyed on the emoji alone
// passed four of the first eight specimens; one keyed on the URL alone passed
// three; one requiring both passed seven.
//
// The emoji half reuses `isEmoji()` from `check-no-emoji.mjs` rather than a
// second copy of its code-point list, so the two checks cannot drift apart on
// what counts as an emoji. The URL half matches the path shape, never a
// particular session identifier: one identifier was measured on three
// different pull requests, because it names the authoring session.
//
// Usage: node scripts/check-attribution-footer.mjs <body-file>

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isEmoji } from './check-no-emoji.mjs';

/**
 * The path shape of a harness session URL. Written as two halves so that this
 * file does not carry the literal it looks for.
 */
export const SESSION_URL = new RegExp(['claude\\.ai/code', '/session_[A-Za-z0-9]+'].join(''));

/**
 * Find every footer marker in a body, one entry per offending line.
 *
 * @param  {string}  body
 * @return {Array<{line: number, marker: string}>} `marker` is a code-point label
 *         such as `U+1F916`, or `session URL`. The URL itself is never echoed, so
 *         a report cannot republish what it flags.
 */
export function findFooterMarkers(body) {
    const hits = [];

    body.split('\n').forEach((text, index) => {
        const line = index + 1;

        // Report each emoji on the line by code point
        for (const char of text) {
            const codePoint = char.codePointAt(0);
            if (isEmoji(codePoint)) {
                hits.push({ line, marker: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}` });
            }
        }

        // Report a session URL on the line by its shape
        if (SESSION_URL.test(text)) {
            hits.push({ line, marker: 'session URL' });
        }
    });

    return hits;
}

/**
 * Check one body file and report. Returns the exit code rather than calling
 * `process.exit`, so a test can import this module without ending its run.
 *
 * @param  {string|undefined}  path
 * @return {number} 0 clean, 1 footer found, 2 the self-check failed or no file
 */
export function main(path) {
    if (!path) {
        console.error('usage: node scripts/check-attribution-footer.mjs <body-file>');
        return 2;
    }

    // Prove both halves can see their marker before trusting a clean result,
    // through the same function the body goes through
    const control = [
        `Generated with ${String.fromCodePoint(0x1f916)} a tool`,
        ['https://', 'claude.ai/code', '/session_', 'Control01'].join(''),
        'A clean line.',
    ].join('\n');
    const found = findFooterMarkers(control).map((hit) => `${hit.line}:${hit.marker}`).join(' ');

    if (found !== '1:U+1F916 2:session URL') {
        console.error('attribution-footer check: SELF-CHECK FAILED - it cannot see what it is looking for.');
        console.error(`  expected "1:U+1F916 2:session URL", got "${found}"`);
        return 2;
    }

    const body = readFileSync(path, 'utf8');
    const hits = findFooterMarkers(body);

    if (hits.length === 0) {
        console.log(`attribution-footer check: clean (${body.split('\n').length} lines read, self-check passed).`);
        return 0;
    }

    for (const hit of hits) {
        console.log(`::error::Line ${hit.line} of the pull-request body carries ${hit.marker}. UAMS-Web/uams-statamic#2321 forbids the harness attribution footer in pull-request bodies, and the no-emoji rule forbids emoji there.`);
    }

    return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main(process.argv[2]);
}
