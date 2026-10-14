import { describe, it, expect } from 'vitest'
import { isEmoji, scanText, ALLOWED, EXCLUDED, RANGES } from './check-no-emoji.mjs'

const cp = (codePoint) => String.fromCodePoint(codePoint)

// #2234. The rule this guards is documented in .claude/rules/no-emoji-in-durable-records.md;
// what these pin is the boundary it draws, which is a LIST rather than an interval. A range
// wide enough to catch every real emoji also swallows two typographic marks that are
// legitimate test data elsewhere in the estate, and no interval separates them.
describe('the emoji boundary', () => {
    it('catches the block ranges', () => {
        for (const codePoint of [0x1f680, 0x1f41e, 0x2705, 0x274c, 0x26a0, 0x2b50]) {
            expect(isEmoji(codePoint), `U+${codePoint.toString(16).toUpperCase()}`).toBe(true)
        }
    })

    // The four a pure range misses. Each is emoji-classified and sits outside every block
    // the ranges cover, so omitting them would leave a real glyph unreported.
    it('catches the four emoji that fall outside the blocks', () => {
        for (const codePoint of [0x2139, 0x203c, 0x2049, 0x3030]) {
            expect(isEmoji(codePoint), `U+${codePoint.toString(16).toUpperCase()}`).toBe(true)
        }
    })

    // The criterion that a test must pin, because widening the ranges to close the gap
    // above would red passing suites: both are entity-encoding and sanitizer test data in
    // the sibling repository, where they ARE the fixture and must survive.
    it('does NOT catch the two typographic marks', () => {
        expect(isEmoji(0x2122), 'U+2122 trade mark').toBe(false)
        expect(isEmoji(0x00ae), 'U+00AE registered').toBe(false)
    })

    // Both marks sit BELOW every range (the lowest starts at U+2600), so the assertion
    // above passes on range position alone -- deleting the EXCLUDED check entirely leaves
    // it green. Measured, not assumed. That makes it a regression guard on the ranges and
    // no evidence at all about the exclusion, so the exclusion is pinned separately below.
    it('the two marks are outside every range, which is why the check above is not enough', () => {
        for (const codePoint of [0x2122, 0x00ae]) {
            expect(RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)).toBe(false)
        }
    })

    // What EXCLUDED actually buys: precedence. It exists so that widening a range later --
    // the exact fix someone reaches for on discovering a missed glyph -- cannot silently
    // start failing builds over a typographic mark. Pinned by putting a code point that IS
    // in a range into the set and watching it stop matching.
    it('EXCLUDED wins over a range that covers the same code point', () => {
        const inRange = 0x2705

        expect(isEmoji(inRange)).toBe(true)

        EXCLUDED.add(inRange)

        try {
            expect(isEmoji(inRange)).toBe(false)
        } finally {
            EXCLUDED.delete(inRange)
        }

        expect(isEmoji(inRange)).toBe(true)
    })

    // U+FE0F is invisible, so it survives a naive strip of the character it modifies and
    // then fails a byte comparison for a reason nothing on screen explains.
    it('catches U+FE0F even after a character it would otherwise allow', () => {
        expect(isEmoji(0xfe0f)).toBe(true)
        expect(scanText(`${cp(0x2122)}${cp(0xfe0f)}`).map((hit) => hit.label)).toEqual(['U+FE0F'])
    })
})

describe('scanText', () => {
    it('reports every occurrence, not the first per code point', () => {
        const hits = scanText(`${cp(0x1f41e)} one\nplain\n${cp(0x1f41e)} two`)

        expect(hits).toEqual([
            { label: 'U+1F41E', line: 1 },
            { label: 'U+1F41E', line: 3 },
        ])
    })

    // A surrogate pair must read as one code point. Iterating by index would see two
    // halves, neither of which matches anything.
    it('reads an astral glyph as one code point', () => {
        expect(cp(0x1f680).length).toBe(2)
        expect(scanText(cp(0x1f680))).toEqual([{ label: 'U+1F680', line: 1 }])
    })

    it('is silent on ordinary prose', () => {
        expect(scanText('A line that needs a warning marker needs a clause.')).toEqual([])
    })
})

// The carve-out is a list of exact paths rather than a pattern, deliberately: a pattern
// over `.claude/reference/` or over table syntax would exempt files nobody has read.
describe('the allowed-by-name carve-out', () => {
    it('is empty now that the afk-waves tracking files are gone', () => {
        expect([...ALLOWED]).toEqual([])
    })
})
