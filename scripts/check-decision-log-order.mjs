#!/usr/bin/env node
/**
 * Assert that `docs/DECISIONS.md` is in oldest-first order (UAMS-Web/uams-statamic#2236).
 *
 * The log states its own convention in its opening lines and nothing enforced
 * it, so six entries had drifted out of order by the time anyone looked. The
 * order was reversed rather than policed - appending is the natural way to add
 * an entry, so the convention was changed to match it - and this asserts that
 * the natural action is also the correct one.
 *
 * On failure it names the two ADJACENT entries that break the order. A
 * 2,200-line log gives a reader no other way to find them, and "the file is
 * unsorted" is not an actionable message.
 *
 * It also asserts the ENTRY SEPARATOR: one blank line before every entry heading
 * (UAMS-Web/uams-statamic#2463). `docs/DECISIONS.md merge=union` resolves the log's tail without a
 * conflict by appending ours-then-theirs, and the append drops the blank line at
 * the seam. That is cosmetic - both this checker and its siblings match the
 * heading per line, so a welded entry is still parsed - but it accumulates: eight
 * instances stood on `main` when this was written, up from six the same morning,
 * and the two newest were produced by union-resolved merges that day.
 *
 * It FAILS rather than warns, and the eight were fixed in the same change that
 * added it. Advisory was the alternative and was rejected on that rate: a warning
 * over a set that grew by two in one morning is a number nobody ever drives to
 * zero. Fixing them was cheap and safe to do at that moment - the repair inserts
 * blank lines and deletes nothing, and exactly one open pull request touched the
 * log, so the collision window was one branch wide. A later reader choosing
 * differently should check that window first; it is the thing that made this
 * choice available rather than a property of the check.
 *
 * Fenced blocks are skipped. The log documents its own entry shape inside a
 * ```markdown fence, and a template is not an entry.
 *
 * Exit 0 when ordered and separated, 1 when not, 2 when the file cannot be read
 * or holds no entries - an unreadable log is a failure rather than a pass, so a
 * rename cannot turn this check into a silent no-op.
 *
 * Bare, it reads `docs/DECISIONS.md` under the working directory, which is how
 * CI and `scripts/local-ci.mjs` run it. `--file <path>` (or `--file=<path>`)
 * reads that path instead, so a revision other than the checkout can be checked
 * from an extracted copy (UAMS-Web/uams-statamic#2910). Any other argument exits 2: an argument the
 * script ignored would read as a report on the file it named. Every outcome
 * names the file read, for the same reason.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HEADING = /^## (\d{4}-\d{2}-\d{2})(.*)$/
const DEFAULT_LOG = 'docs/DECISIONS.md'

/**
 * Refuse the invocation, with the exit reserved for "cannot answer".
 *
 * @param  {string}  reason  What was wrong with the arguments.
 */
function refuse(reason) {
    console.error(`check-decision-log-order: ${reason}`)
    console.error(`Usage: node scripts/check-decision-log-order.mjs [--file <path>]  (default ${DEFAULT_LOG})`)
    process.exit(2)
}

// The path to read, as given; null until `--file` names one.
let named = null
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    let value

    if (arg === '--file') {
        i += 1
        value = args[i]
    } else if (arg.startsWith('--file=')) {
        value = arg.slice('--file='.length)
    } else {
        refuse(`unrecognized argument "${arg}"`)
    }

    if (value === undefined || value === '') {
        refuse('--file needs a path')
    }
    if (named !== null) {
        refuse('--file given more than once')
    }
    named = value
}

// The file read, and the name the messages give it: the default by the
// repository-relative path the gate runs it against, a named file resolved, so
// a report cannot pass for one about a different copy.
const LOG = resolve(process.cwd(), named ?? DEFAULT_LOG)
const LABEL = named === null ? DEFAULT_LOG : LOG

let source
try {
    source = readFileSync(LOG, 'utf8')
} catch (error) {
    console.error(`check-decision-log-order: cannot read ${LOG} - ${error.message}`)
    process.exit(2)
}

const entries = []
const lines = source.split(/\r?\n/)
let inFence = false
lines.forEach((line, index) => {
    // A fence toggle is only ever a fence toggle; an entry heading cannot also
    // open one, so testing this first costs nothing and keeps the two disjoint.
    if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return
    }
    if (inFence) {
        return
    }
    const match = HEADING.exec(line)
    if (match) {
        entries.push({
            line: index + 1,
            date: match[1],
            title: match[2].trim(),
            // The line above, kept so the separator check can report what is
            // actually there rather than only that something is.
            previous: index > 0 ? lines[index - 1] : null,
        })
    }
})

if (entries.length === 0) {
    console.error(`check-decision-log-order: no "## YYYY-MM-DD" entries found in ${LOG}`)
    console.error('An empty result here means the heading shape changed, not that the log is ordered.')
    process.exit(2)
}

// A separator violation is reported separately from an ordering break: they have
// different remedies, and folding them into one message makes the ordering one -
// the correctness-bearing half - less actionable.
const welded = entries.filter((entry) => entry.previous !== null && entry.previous.trim() !== '')

if (welded.length > 0) {
    console.error(`check-decision-log-order: ${LABEL}: ${welded.length} entry heading${welded.length === 1 ? ' is' : 's are'} not preceded by a blank line.`)
    console.error('')
    for (const entry of welded) {
        console.error(`  line ${entry.line}  ${entry.date}  ${entry.title.slice(0, 66)}`)
        console.error(`    preceded directly by: ${entry.previous.trim().slice(0, 72)}`)
    }
    console.error('')
    console.error('Insert one blank line above each heading listed. This is the separator a')
    console.error('`merge=union` append drops at the seam; it does not affect ordering, and no')
    console.error('other check sees it because every reader matches the heading per line.')
    process.exit(1)
}

// Adjacent comparison rather than a sort: the pair that breaks the order is the
// actionable output, and a sort would only report that the whole differs.
const violations = []
for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].date < entries[i - 1].date) {
        violations.push([entries[i - 1], entries[i]])
    }
}

if (violations.length > 0) {
    console.error(`check-decision-log-order: ${LABEL} is not in oldest-first order (${violations.length} break${violations.length === 1 ? '' : 's'}).`)
    console.error('')
    for (const [before, after] of violations) {
        console.error(`  line ${after.line}  ${after.date}  is OLDER than`)
        console.error(`  line ${before.line}  ${before.date}  which precedes it`)
        console.error(`    ${after.title.slice(0, 88)}`)
        console.error('')
    }
    console.error('A new entry is APPENDED to the end of the file. Move the entries above into date order.')
    process.exit(1)
}

console.log(`check-decision-log-order: ${LABEL}: ${entries.length} entries, oldest-first and separated, ${entries[0].date} to ${entries[entries.length - 1].date}.`)
process.exit(0)
