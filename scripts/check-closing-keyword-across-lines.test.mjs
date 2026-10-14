// Coverage for the cross-line closing-directive checker (#2464).
//
// These spawn the real script rather than importing the predicate, because what
// a caller consumes is the EXIT CODE and nothing else - 0 clean, 1 findings, 2
// cannot run. A test of the exported matcher alone would assert the thing no
// caller reads.
//
// The positive control is the REAL instance and is written out verbatim rather
// than reduced to a minimal case. `#2464` asks for exactly that, and the reason
// is in the shape: a minimal `closed\n#1` fixture is trivially matched by a
// pattern that would still miss a status table, because the table's keyword is
// preceded by column padding and its reference carries trailing row text. A
// synthetic case cannot fail the way the real one did.
//
// Fixtures rather than the live repository: a test that shelled out to
// `f12ba37e4` would pass only in a clone that has it, and would be measuring
// git rather than the checker.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), 'check-closing-keyword-across-lines.mjs')

/**
 * The status table from `f12ba37e4`, the squash commit for `#2446`.
 *
 * Reproduced as it appears in the commit: the keyword is the last token of one
 * row and the reference is the first of the next, with the alignment that put
 * them there. This body also carries `Deliberately closes nothing`, which is
 * what the author believed it said.
 */
const REAL_INSTANCE = [
    'docs: record the upstream-report decision for the traverser patch',
    '',
    'Refs #2241. Deliberately closes nothing: the filing that ticket now',
    'describes has not happened yet.',
    '',
    '#2037  write the patch                       closed',
    '#2241  file the bug upstream                 retitled, action-flavor added',
    '#2259  open the upstream pull request        unchanged, blocked by #2241',
    '',
].join('\n')

/**
 * Run the checker against a fixture file.
 *
 * @param  {string}  contents
 * @return {{status: number, stderr: string}}
 */
function check(contents) {
    const scratch = mkdtempSync(join(tmpdir(), 'closing-keyword-'))
    const path = join(scratch, 'body.md')

    try {
        writeFileSync(path, contents, 'utf8')
        const result = spawnSync(process.execPath, [CHECKER, '--file', path], { encoding: 'utf8' })

        return { status: result.status, stderr: result.stderr ?? '' }
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}

describe('the real instance', () => {
    it('reports the pair that closed #2241', () => {
        const { status, stderr } = check(REAL_INSTANCE)

        expect(status).toBe(1)
        expect(stderr).toContain('closed #2241')
    })

    it('reports it once, not once per reference in the table', () => {
        const { stderr } = check(REAL_INSTANCE)

        expect(stderr).toContain('Found 1 closing directive')
    })

    it('does not report #2259, whose row also ends in a reference', () => {
        // `blocked by #2241` ends that row and `#2259` opens the one before it.
        // Neither pair has a keyword adjacent to a reference across the break,
        // so a pattern keying on "reference at start of line" would over-report
        // here and this pins that it does not.
        const { stderr } = check(REAL_INSTANCE)

        expect(stderr).not.toContain('#2259')
    })
})

describe('the deliberate form is left alone', () => {
    it('passes a same-line Closes #N', () => {
        const { status } = check('Fix the thing\n\nCloses #2466.\n')

        expect(status).toBe(0)
    })

    it('passes a body with no reference at all', () => {
        const { status } = check('Fix the thing\n\nNothing to see.\n')

        expect(status).toBe(0)
    })
})

describe('words that merely end in a keyword', () => {
    // `disclosed`, `enclosed` and `foreclosed` all end in `closed`. Without a
    // word boundary on the left each is a false positive, and each is ordinary
    // English that could plausibly end a line in a pull-request body.
    it.each(['disclosed', 'enclosed', 'foreclosed', 'closely'])('does not match %s', (word) => {
        const { status } = check(`The terms were ${word}\n#2241 remains open.\n`)

        expect(status).toBe(0)
    })

    it('still matches the bare keyword in the same position', () => {
        // The negative control above proves nothing on its own - an instrument
        // that matches nothing passes it. This is the same fixture shape with
        // the one word that IS a keyword.
        const { status, stderr } = check('The issue was closed\n#2241 remains open.\n')

        expect(status).toBe(1)
        expect(stderr).toContain('closed #2241')
    })
})

describe('whitespace between the keyword and the reference', () => {
    it('matches across a trailing space', () => {
        expect(check('status  closed   \n#2241  next row\n').status).toBe(1)
    })

    it('matches across a blank line, which is still only whitespace to the parser', () => {
        expect(check('status  closed\n\n#2241  next row\n').status).toBe(1)
    })

    it('matches across CRLF', () => {
        expect(check('status  closed\r\n#2241  next row\r\n').status).toBe(1)
    })

    it('matches an indented reference', () => {
        expect(check('status  closed\n    #2241  next row\n').status).toBe(1)
    })
})

describe('every closing keyword GitHub honors', () => {
    it.each(['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'])(
        'matches %s',
        (keyword) => {
            expect(check(`row  ${keyword}\n#2241  next\n`).status).toBe(1)
        },
    )

    it('matches a cross-repository reference', () => {
        const { status, stderr } = check('row  closed\nUAMS-Web/wordpress-importer#494  next\n')

        expect(status).toBe(1)
        expect(stderr).toContain('UAMS-Web/wordpress-importer#494')
    })
})

describe('an input it cannot read is a failure, not a pass', () => {
    it('exits 2 on a missing file', () => {
        const result = spawnSync(process.execPath, [CHECKER, '--file', join(tmpdir(), 'no-such-body.md')], {
            encoding: 'utf8',
        })

        expect(result.status).toBe(2)
    })

    it('exits 2 on an unknown option rather than scanning nothing and passing', () => {
        const result = spawnSync(process.execPath, [CHECKER, '--nope'], { encoding: 'utf8' })

        expect(result.status).toBe(2)
    })

    // The three below are self-review findings, and each one failed in the
    // REASSURING direction before it was fixed - the script exited 0 and the
    // caller had no way to tell a clean body from a broken read.

    it('exits 2 on an empty body, which is indistinguishable from a clean one', () => {
        expect(check('').status).toBe(2)
    })

    it('exits 2 on the literal "null", which is what --jq .body prints for an absent body', () => {
        // The documented invocation is `gh api … --jq .body | … --stdin`, so
        // this is that command's own failure mode rather than a contrived one.
        expect(check('null\n').status).toBe(2)
    })

    it('does not fall back to the default range when an explicit range selects nothing', () => {
        // `HEAD..HEAD` is empty by construction. Falling back to
        // `origin/main..HEAD` would answer a question nobody asked, and would
        // report 0 or 1 depending on the branch the suite happens to run on.
        const result = spawnSync(process.execPath, [CHECKER, '--range', 'HEAD..HEAD'], {
            cwd: dirname(CHECKER),
            encoding: 'utf8',
        })

        expect(result.status).toBe(2)
        expect(result.stderr).toContain('selected no text to scan')
    })
})
