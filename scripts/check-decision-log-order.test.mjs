// Coverage for the decision-log order checker (#2275).
//
// The checker went into the `encoding` job of both CI definitions with no test
// (#2257), while twelve sibling scripts in this directory carry one. `encoding`
// chain-gates eight downstream jobs, so it sits upstream of most of the suite.
//
// These spawn the real script rather than importing a pure function, because
// what the gate consumes is the EXIT CODE and nothing else. A test of an
// extracted predicate would assert the thing the gate never reads.
//
// Fixtures, never the live `docs/DECISIONS.md`: a test that read the real log
// would red every time an entry is appended, which is every time the log does
// its job.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), 'check-decision-log-order.mjs')

/**
 * Run the checker against a fixture log, or against no log at all.
 *
 * Bare, the script resolves its target from `process.cwd()`, so the fixture is
 * placed at `<scratch>/docs/DECISIONS.md` and the child is given that scratch as
 * its working directory: the same shape as the CI invocation, which runs it
 * from the repository root.
 *
 * `args` reach the script as given, after `{scratch}` in any of them is replaced
 * with the scratch directory, and `files` are written under the scratch first,
 * so a case can name a log that differs from the working tree's copy (#2910).
 *
 * @param  {?string}  contents  The working tree's log body, or null to leave it absent.
 * @param  {string[]}  args  Arguments for the script.
 * @param  {Record<string, string>}  files  Extra files, keyed by path under the scratch.
 */
function runChecker(contents, args = [], files = {}) {
    const scratch = mkdtempSync(join(tmpdir(), 'decision-log-'))

    try {
        if (contents !== null) {
            mkdirSync(join(scratch, 'docs'), { recursive: true })
            writeFileSync(join(scratch, 'docs', 'DECISIONS.md'), contents, 'utf8')
        }

        for (const [path, body] of Object.entries(files)) {
            mkdirSync(dirname(join(scratch, path)), { recursive: true })
            writeFileSync(join(scratch, path), body, 'utf8')
        }

        const resolvedArgs = args.map((arg) => arg.replaceAll('{scratch}', scratch))
        const result = spawnSync(process.execPath, [CHECKER, ...resolvedArgs], {
            cwd: scratch,
            encoding: 'utf8',
        })

        return {
            status: result.status,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            scratch,
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}

const ORDERED = [
    '# Decisions',
    '',
    'Newest entries are appended to the end.',
    '',
    '## 2026-07-14 - Pin the importer to a tagged release',
    '',
    'Body.',
    '',
    '## 2026-08-02 - Reverse the log to oldest-first',
    '',
    'Body.',
    '',
    '## 2026-09-06 - Prove divergence with content',
    '',
    'Body.',
    '',
].join('\n')

const OUT_OF_ORDER = [
    '# Decisions',
    '',
    '## 2026-07-14 - Pin the importer to a tagged release',
    '',
    'Body.',
    '',
    '## 2026-09-06 - Prove divergence with content',
    '',
    'Body.',
    '',
    '## 2026-08-02 - Reverse the log to oldest-first',
    '',
    'Body.',
    '',
].join('\n')

// Two entries, so a report on it cannot be confused with one on ORDERED (three).
const OTHER_REVISION = [
    '# Decisions',
    '',
    '## 2026-10-01: An entry only the named copy holds',
    '',
    'Body.',
    '',
    '## 2026-10-02: Another',
    '',
    'Body.',
    '',
].join('\n')

// An entry dated 2026-10-05 moved past two entries that share 2026-10-07: the
// shape of a real misplacement. Swapping two same-dated entries could not break
// oldest-first, so it would say nothing about whether the ordering half can fire.
const MOVED_ACROSS_A_DATE = [
    '# Decisions',
    '',
    '## 2026-10-04: Before the move',
    '',
    'Body.',
    '',
    '## 2026-10-07: First of the day',
    '',
    'Body.',
    '',
    '## 2026-10-07: Second of the day',
    '',
    'Body.',
    '',
    '## 2026-10-05: Moved past the day after it',
    '',
    'Body.',
    '',
].join('\n')

const WELDED = [
    '# Decisions',
    '',
    '## 2026-07-14 - Pin the importer to a tagged release',
    '',
    'Body.',
    '',
    '**Companion.** #1234 (this record).',
    '## 2026-08-02 - Reverse the log to oldest-first',
    '',
    'Body.',
    '',
].join('\n')

// A dated heading inside a fence, deliberately BOTH welded and out of order, so
// the case fails on either axis if fences stop being skipped. The log documents
// its own entry shape this way, so this is the real shape rather than a
// contrived one.
const FENCED_TEMPLATE = [
    '# Decisions',
    '',
    'Entries look like this:',
    '',
    '```markdown',
    'Prose immediately above, and an older date than everything below.',
    '## 2020-01-01 - <short decision title> (<#issue>)',
    '```',
    '',
    '## 2026-07-14 - Pin the importer to a tagged release',
    '',
    'Body.',
    '',
    '## 2026-08-02 - Reverse the log to oldest-first',
    '',
    'Body.',
    '',
].join('\n')

describe('check-decision-log-order', () => {
    it('passes an ordered log and reports what it actually read', () => {
        const { status, stdout } = runChecker(ORDERED)

        expect(status).toBe(0)

        // The count and the range are the positive control on the harness itself.
        // A spawn that silently found no headings would also exit 0 on the empty
        // path - except that path exits 2 - so asserting the numbers proves the
        // pass came from reading three entries rather than from reading nothing.
        expect(stdout).toContain('3 entries')
        expect(stdout).toContain('2026-07-14')
        expect(stdout).toContain('2026-09-06')
    })

    it('fails an out-of-order log and names BOTH adjacent entries', () => {
        const { status, stderr } = runChecker(OUT_OF_ORDER)

        expect(status).toBe(1)

        // Naming both sides of the break is the whole value of the message: a
        // 2,200-line log gives a reader no other way to locate it, and "the file
        // is unsorted" is not actionable. A regression that reported only the
        // later entry would still exit 1 and still look like a working check.
        expect(stderr).toContain('2026-08-02')
        expect(stderr).toContain('2026-09-06')
        expect(stderr).toContain('is OLDER than')
        expect(stderr).toContain('which precedes it')
    })

    it('fails an entry heading that has no blank line above it', () => {
        const { status, stderr } = runChecker(WELDED)

        // The separator a `merge=union` append drops at the seam (#2463). It is
        // cosmetic - every reader matches the heading per line, so the entry is
        // still parsed - which is exactly why nothing else sees it, and why it
        // accumulated to eight instances on `main` before this arm existed.
        expect(status).toBe(1)
        expect(stderr).toContain('not preceded by a blank line')
        expect(stderr).toContain('2026-08-02')

        // The offending line itself, not merely that one exists. A message that
        // named only the heading would leave a reader hunting for what is above
        // it in a 2,400-line file.
        expect(stderr).toContain('**Companion.** #1234')
    })

    it('reports a welded seam distinctly from an ordering break', () => {
        const { stderr } = runChecker(WELDED)

        // WELDED is correctly ordered, so any ordering vocabulary here would mean
        // the two findings had been folded into one message. They have different
        // remedies: one inserts a blank line, the other moves an entry.
        expect(stderr).not.toContain('is OLDER than')
        expect(stderr).not.toContain('oldest-first order')
    })

    it('ignores a dated heading inside a fenced block', () => {
        const { status, stdout } = runChecker(FENCED_TEMPLATE)

        // The fenced heading is both welded and older than everything after it,
        // so a regression that stopped skipping fences fails this on either axis
        // rather than needing the exact one that broke.
        expect(status).toBe(0)

        // And it is excluded from the count rather than merely tolerated: three
        // headings appear in the fixture, two of them entries.
        expect(stdout).toContain('2 entries')
        expect(stdout).not.toContain('2020-01-01')
    })

    it('exits 2 when the log is absent, distinguishably from both other outcomes', () => {
        const { status, stderr } = runChecker(null)

        // #2257 gave this its own exit deliberately: an unreadable log is a
        // failure rather than a pass, so a rename cannot turn the check into a
        // silent no-op. Nothing exercised that branch until now, which is how a
        // later refactor could collapse it into 0 and leave the gate reporting
        // success while looking at nothing.
        expect(status).toBe(2)
        expect(status).not.toBe(0)
        expect(status).not.toBe(1)
        expect(stderr).toContain('cannot read')
    })

    it('exits 2 when the log is readable but holds no entries', () => {
        const { status, stderr } = runChecker('# Decisions\n\nProse, but no dated headings.\n')

        // The other way the check can go blind. An empty result here means the
        // heading shape changed, not that the log is ordered - and the ordered
        // path would otherwise report "0 entries" and exit 0, which is the
        // false green this arm exists to prevent.
        expect(status).toBe(2)
        expect(stderr).toContain('no "## YYYY-MM-DD" entries')
    })

    it('accepts equal dates, since two decisions can land the same day', () => {
        const sameDay = [
            '## 2026-09-06 - First',
            '',
            'Body.',
            '',
            '## 2026-09-06 - Second',
            '',
            'Body.',
            '',
        ].join('\n')

        // The comparison is strictly-older, not non-equal. Two entries on one
        // date are ordinary - #2277 and #2281 both landed on 2026-09-06 - and a
        // check that rejected them would fail on a correct log.
        expect(runChecker(sameDay).status).toBe(0)
    })

    it('fails an entry moved across a date boundary, naming the adjacent pair', () => {
        const { status, stderr } = runChecker(MOVED_ACROSS_A_DATE)

        expect(status).toBe(1)

        // The pair is the second 2026-10-07 entry and the 2026-10-05 entry after
        // it, at lines 11 and 15; the first 2026-10-07 entry is in order.
        expect(stderr).toContain('line 15  2026-10-05  is OLDER than')
        expect(stderr).toContain('line 11  2026-10-07  which precedes it')
        expect(stderr).toContain('(1 break)')
    })

    it('reads a named path instead of the working tree, and says which file it read', () => {
        // The working tree holds ORDERED (three entries); the named copy holds two.
        const { status, stdout, scratch } = runChecker(ORDERED, ['--file', '{scratch}/revision/DECISIONS.md'], {
            'revision/DECISIONS.md': OTHER_REVISION,
        })

        expect(status).toBe(0)
        expect(stdout).toContain('2 entries')
        expect(stdout).toContain('2026-10-01 to 2026-10-02')
        expect(stdout).not.toContain('3 entries')

        // The path is in the line, so the report cannot pass for one about the
        // working tree's copy.
        expect(stdout).toContain(join(scratch, 'revision', 'DECISIONS.md'))
    })

    it('accepts the --file=<path> form too', () => {
        const { status, stdout } = runChecker(ORDERED, ['--file={scratch}/revision/DECISIONS.md'], {
            'revision/DECISIONS.md': OTHER_REVISION,
        })

        expect(status).toBe(0)
        expect(stdout).toContain('2 entries')
    })

    it('checks the named file, not the working tree, for ordering too', () => {
        // The working tree is ordered and the named copy is not, so a pass would
        // mean the working tree had been read instead.
        const { status, stderr, scratch } = runChecker(ORDERED, ['--file', '{scratch}/revision/DECISIONS.md'], {
            'revision/DECISIONS.md': MOVED_ACROSS_A_DATE,
        })

        expect(status).toBe(1)
        expect(stderr).toContain(join(scratch, 'revision', 'DECISIONS.md'))
        expect(stderr).toContain('line 15  2026-10-05  is OLDER than')
    })

    it('exits 2 for a named path that does not exist, even with a good working tree', () => {
        // The working tree's log is present and ordered, which is exactly what a
        // checker that ignored the argument would report on and pass.
        const { status, stdout, stderr } = runChecker(ORDERED, ['--file', '{scratch}/nonexistent/zzz.md'])

        expect(status).toBe(2)
        expect(stderr).toContain('cannot read')
        expect(stderr).toContain('zzz.md')
        expect(stdout).not.toContain('3 entries')
    })

    it('exits 2 for an argument it does not recognize', () => {
        const { status, stderr } = runChecker(ORDERED, ['docs/DECISIONS.md'])

        // A bare path is not an option this script takes. Refusing it keeps an
        // ignored argument from reading as a report on the file it named.
        expect(status).toBe(2)
        expect(stderr).toContain('unrecognized argument')
    })

    it('exits 2 for --file with no path after it, and says so', () => {
        for (const args of [['--file'], ['--file=']]) {
            const { status, stderr } = runChecker(ORDERED, args)

            // An empty path would otherwise resolve to the working directory
            // and fail as an unreadable directory, which names the wrong cause.
            expect(status).toBe(2)
            expect(stderr).toContain('--file needs a path')
        }
    })

    it('exits 2 when --file is given twice, rather than picking one', () => {
        const { status, stderr } = runChecker(
            ORDERED,
            ['--file', '{scratch}/docs/DECISIONS.md', '--file', '{scratch}/revision/DECISIONS.md'],
            { 'revision/DECISIONS.md': OTHER_REVISION },
        )

        expect(status).toBe(2)
        expect(stderr).toContain('--file given more than once')
    })

    it('names docs/DECISIONS.md in its success line when invoked bare', () => {
        const { status, stdout } = runChecker(ORDERED)

        // The gate's invocation (#2910): unchanged exit, and the line now names
        // the file it read.
        expect(status).toBe(0)
        expect(stdout).toContain('docs/DECISIONS.md')
    })

    it('reads CRLF line endings, which is what a Windows checkout produces', () => {
        const { status, stdout } = runChecker(ORDERED.replace(/\n/g, '\r\n'))

        // The script splits on /\r?\n/. If that ever narrows to /\n/, every
        // heading on a CRLF checkout keeps a trailing \r, the anchored pattern
        // stops matching, and the checker exits 2 on a perfectly good log.
        expect(status).toBe(0)
        expect(stdout).toContain('3 entries')
    })
})
