#!/usr/bin/env node
/**
 * Report a closing directive formed ACROSS a line break, which nobody wrote (#2464).
 *
 * A newline is whitespace to GitHub's closing-keyword parser. So a line ending
 * in `closed` followed by a line beginning with `#2241` is read as the literal
 * directive `closed #2241`, and merging the text closes that issue. No author
 * typed a keyword next to a reference: in the one real instance the word was a
 * CELL VALUE in a status column and the reference was the ROW LABEL of the next
 * row, and column alignment put them adjacent.
 *
 *     #2037  write the patch          closed
 *     #2241  file the bug upstream    retitled from "Decide whether to report…"
 *
 * That is `f12ba37e4`, the squash commit for `#2446`, whose body opens `Refs
 * #2241. Deliberately closes nothing`. It closed `#2241` anyway.
 *
 * WHAT TO POINT THIS AT, because the obvious answer is the wrong one. This
 * repository is squash-only, so exactly one commit reaches `main` per pull
 * request and its message is the PULL-REQUEST BODY. Measured on the real
 * instance: `#2446`'s branch carried one substantive commit and its body holds
 * no `#N` row at all, while the pull-request body holds the table. A check
 * scanning `origin/main..HEAD` would therefore have run clean over the only
 * case this exists to catch. The body is the primary input; the range mode is
 * for the author who writes the table into a commit instead.
 *
 * Two checks that CANNOT see this, both of which look like they should:
 *
 *   - grepping the body for `Closes #N` - the pair is not in the source text,
 *     it is created by the join, so the string never appears on any line
 *   - reading `closingIssuesReferences` - EMPTY for `#2446`. The
 *     pull-request-level linkage and the push-time commit scan are separate
 *     code paths, so a pull request can close an issue its own
 *     `closingIssuesReferences` does not list
 *
 * A same-line `Closes #N` is the deliberate form and is never reported: the
 * pattern requires a newline between the keyword and the reference, so ordinary
 * usage cannot match it.
 *
 * Exit 0 when clean, 1 when a cross-line pair is found, 2 when the input cannot
 * be read - an unreadable input is a failure rather than a pass, so a bad path
 * or an empty fetch cannot turn this into a silent no-op.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/**
 * GitHub's closing keywords, all nine of them.
 *
 * `\b` on the left is load-bearing: `disclosed`, `enclosed` and `foreclosed`
 * all end in a keyword and none of them is one.
 */
const KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`

/** `#123`, and the cross-repository `owner/repo#123`. */
const REFERENCE = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+`

/**
 * Keyword, then whitespace CONTAINING AT LEAST ONE NEWLINE, then a reference.
 *
 * Requiring the newline is what separates this from the deliberate form. `\s*`
 * on both sides absorbs trailing spaces, indentation, and blank lines between
 * the two - a blank line is still only whitespace to the parser, so a pair
 * separated by one closes the issue exactly as an adjacent pair does.
 */
const ACROSS_LINES = new RegExp(`\\b${KEYWORD}\\s*\\r?\\n\\s*${REFERENCE}`, 'gi')

/**
 * Find every cross-line closing directive in one piece of text.
 *
 * @param  {string}  text
 * @return {Array<{line: number, keyword: string, reference: string, quoted: string}>}
 */
export function findAcrossLines(text) {
    const findings = []

    for (const match of text.matchAll(ACROSS_LINES)) {
        const before = text.slice(0, match.index)
        const lines = match[0].split(/\r?\n/)

        findings.push({
            line: before.split('\n').length,
            keyword: lines[0].trim(),
            reference: lines[lines.length - 1].trim(),
            quoted: match[0].replace(/\s+/g, ' '),
        })
    }

    return findings
}

/**
 * Read every commit message in a range, newest first.
 *
 * Messages are separated by a NUL rather than a newline: a commit body contains
 * newlines by definition, so any textual separator could appear inside one and
 * split a message in the middle of the very shape being looked for.
 *
 * @param  {string}  range
 * @return {Array<{label: string, text: string}>}
 */
function readRange(range) {
    const log = spawnSync('git', ['log', '--format=%H%x1f%B%x00', range], { encoding: 'utf8' })

    if (log.status !== 0) {
        console.error(`check-closing-keyword-across-lines: git log ${range} failed - ${(log.stderr || '').trim()}`)
        process.exit(2)
    }

    return log.stdout
        .split('\0')
        .filter((entry) => entry.trim() !== '')
        .map((entry) => {
            const [sha, ...rest] = entry.replace(/^\r?\n/, '').split('\x1f')

            return { label: `commit ${sha.slice(0, 9)}`, text: rest.join('\x1f') }
        })
}

/**
 * Reject an input that is empty, or the literal `null`.
 *
 * Both are indistinguishable from a successful read of a clean body, and both
 * fail in the reassuring direction. `gh api … --jq .body` prints `null` when
 * the field is absent and prints nothing when the request failed - so the
 * documented invocation has two ways to hand this script a well-formed pass it
 * has not earned.
 *
 * @param  {string}  text
 * @param  {string}  label
 */
function rejectEmpty(text, label) {
    const trimmed = text.trim()

    if (trimmed === '' || trimmed === 'null') {
        console.error(`check-closing-keyword-across-lines: ${label} is ${trimmed === '' ? 'empty' : 'the literal "null"'}.`)
        console.error('That is indistinguishable from a clean body, so it is a failure rather than a pass.')
        process.exit(2)
    }
}

const argv = process.argv.slice(2)
const sources = []

// Tracked separately from `sources.length`: an explicit `--range` that selects
// no commits must NOT silently fall back to the default range and report on a
// different set of commits than the caller asked about.
let sourceRequested = false

for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]

    if (flag === '--file') {
        const path = argv[i += 1]
        sourceRequested = true
        let text

        try {
            text = readFileSync(path, 'utf8')
        } catch (error) {
            console.error(`check-closing-keyword-across-lines: cannot read ${path} - ${error.message}`)
            process.exit(2)
        }

        rejectEmpty(text, path)
        sources.push({ label: path, text })
    } else if (flag === '--stdin') {
        sourceRequested = true
        let text

        try {
            text = readFileSync(0, 'utf8')
        } catch (error) {
            console.error(`check-closing-keyword-across-lines: cannot read stdin - ${error.message}`)
            process.exit(2)
        }

        rejectEmpty(text, 'stdin')
        sources.push({ label: 'stdin', text })
    } else if (flag === '--commit') {
        sourceRequested = true
        sources.push(...readRange(`${argv[i += 1]}^!`))
    } else if (flag === '--range') {
        sourceRequested = true
        sources.push(...readRange(argv[i += 1]))
    } else if (flag === '--help') {
        console.log('check-closing-keyword-across-lines [--stdin] [--file <path>] [--commit <sha>] [--range <a..b>]')
        console.log('')
        console.log('Point it at the text that will MERGE. This repository squash-merges, so that is')
        console.log('the pull-request body:')
        console.log('')
        console.log('  gh api repos/{owner}/{repo}/pulls/{n} --jq .body |\\')
        console.log('    node scripts/check-closing-keyword-across-lines.mjs --stdin')
        console.log('')
        console.log('Defaults to --range origin/main..HEAD when given nothing.')
        process.exit(0)
    } else {
        console.error(`check-closing-keyword-across-lines: unknown option '${flag}'`)
        console.error('Known: --stdin --file <path> --commit <sha> --range <a..b> --help')
        process.exit(2)
    }
}

if (!sourceRequested) {
    sources.push(...readRange('origin/main..HEAD'))
}

// An explicitly named source that yielded nothing is a failure. A range with no
// commits in it, or a `--commit` naming one that does not exist, answers a
// different question than the caller asked and would otherwise exit 0.
if (sources.length === 0) {
    console.error('check-closing-keyword-across-lines: the source(s) named selected no text to scan.')
    console.error('Reporting that as clean would be a pass this has not earned.')
    process.exit(2)
}

const findings = sources.flatMap((source) =>
    findAcrossLines(source.text).map((finding) => ({ ...finding, source: source.label })))

// Printed BEFORE the findings, so a crash mid-report leaves a visibly truncated
// run rather than one that reads as clean.
console.error(`check-closing-keyword-across-lines: scanned ${sources.length} source(s).`)

if (findings.length === 0) {
    process.exit(0)
}

console.error('')
console.error(`Found ${findings.length} closing directive(s) formed across a line break:`)
console.error('')

for (const finding of findings) {
    console.error(`  ${finding.source}, line ${finding.line}`)
    console.error(`    reads as:  ${finding.quoted}`)
    console.error(`    because "${finding.keyword}" ends a line and "${finding.reference}" begins the next`)
    console.error('')
}

console.error('Merging this text will close those issues, whatever the body says it does.')
console.error('Break the adjacency: reorder the columns so the status cell is not last, or')
console.error('write the cell as something other than a bare keyword ("now closed", "done").')
process.exit(1)
