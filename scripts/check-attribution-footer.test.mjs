import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findFooterMarkers, main } from './check-attribution-footer.mjs'
import { isEmoji } from './check-no-emoji.mjs'

// #2701. The fixtures below are the two footer shapes recorded on that issue, built from
// parts so that neither this file nor anything that reads it carries the literal markers.
const ROBOT = String.fromCodePoint(0x1f916)
const SESSION = ['https://', 'claude.ai/code', '/session_', 'Fixture01AbC'].join('')
const MARKER_LINE = `${ROBOT} Generated with [Claude Code](https://claude.com/claude-code)`

const body = (...lines) => ['## Summary', '', 'Adds a thing.', '', ...lines].join('\n')

describe('the two footer shapes', () => {
    it('flags a body carrying only the marker line', () => {
        expect(findFooterMarkers(body(MARKER_LINE))).toEqual([{ line: 5, marker: 'U+1F916' }])
    })

    // The shape three of the first four specimens took: a session URL with no emoji at all,
    // which a check keyed on the emoji passes.
    it('flags a body carrying only a session URL', () => {
        expect(findFooterMarkers(body(SESSION))).toEqual([{ line: 5, marker: 'session URL' }])
    })

    it('flags both halves of the full form', () => {
        expect(findFooterMarkers(body(MARKER_LINE, '', SESSION))).toEqual([
            { line: 5, marker: 'U+1F916' },
            { line: 7, marker: 'session URL' },
        ])
    })

    // The identifier names the authoring session, not the pull request, so the check
    // matches the path shape rather than any value.
    it('flags a session URL whatever its identifier', () => {
        expect(findFooterMarkers(SESSION.replace('Fixture01AbC', 'Zz9'))).toHaveLength(1)
    })
})

describe('a clean body', () => {
    // The measured absence the issue asks for: a body carrying neither marker, but carrying
    // the near misses a loose pattern would catch.
    it('reports nothing for a body with neither marker', () => {
        const clean = body(
            'Links to https://claude.com/claude-code and https://claude.ai/code without a session.',
            'Mentions a session_ variable and the text Generated with Claude Code.',
            'Uses the (TM) mark as U+2122: ™',
        )

        expect(findFooterMarkers(clean)).toEqual([])
    })
})

describe('reuse of the emoji boundary', () => {
    // A code point the no-emoji scanner excludes must not be flagged here either, which
    // only holds if this check asks that scanner rather than keeping its own list.
    it('agrees with check-no-emoji on an excluded mark and an included one', () => {
        expect(isEmoji(0x2122)).toBe(false)
        expect(findFooterMarkers('™')).toEqual([])
        expect(isEmoji(0x2705)).toBe(true)
        expect(findFooterMarkers(String.fromCodePoint(0x2705))).toEqual([{ line: 1, marker: 'U+2705' }])
    })
})

describe('main', () => {
    let dir

    afterEach(() => {
        vi.restoreAllMocks()
        if (dir) rmSync(dir, { recursive: true, force: true })
        dir = undefined
    })

    const run = (text) => {
        dir = mkdtempSync(join(tmpdir(), 'footer-'))
        const path = join(dir, 'body.md')
        writeFileSync(path, text)
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        return main(path)
    }

    it('exits 1 on the marker line', () => expect(run(body(MARKER_LINE))).toBe(1))
    it('exits 1 on a session URL alone', () => expect(run(body(SESSION))).toBe(1))
    it('exits 0 on a clean body', () => expect(run(body('Nothing to see.'))).toBe(0))

    // The report names the marker and the line, and never echoes the URL it flags.
    it('reports without republishing the URL', () => {
        run(body(SESSION))
        const printed = console.log.mock.calls.flat().join('\n')
        expect(printed).toContain('Line 5')
        expect(printed).toContain('session URL')
        expect(printed).not.toContain('session_Fixture01AbC')
    })

    it('exits 2 without a file argument', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(main(undefined)).toBe(2)
    })
})
