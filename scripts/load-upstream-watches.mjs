#!/usr/bin/env node
/**
 * Build `watch-upstream.yml`'s `WATCHES` array from one file per row (UAMS-Web/uams-statamic#2673).
 *
 * Every row used to live in one single-line JSON string inside the workflow, so any
 * two pull requests that each added a row edited the same line and conflicted. A
 * resolution that kept one side silently dropped the other side's rows, and a
 * dropped row fails quietly: nothing ever fires for an upstream nobody is watching.
 * With one file per row, adding a row never touches another one.
 *
 * Each file in `.github/upstream-watches/` holds exactly the object a row held
 * before: `tracker`, `repo`, `kind` (`issue` | `pr`), `number`, and optionally
 * `composer`, and `released` on a pull-request row (UAMS-Web/uams-statamic#2727). It is named `<tracker>-<owner>-<repo>-<number>.json`, so the name is
 * unique and says what it watches.
 *
 * IT FAILS RATHER THAN RETURN AN EMPTY LIST. A wrong path, a checkout that did not
 * include the directory, or a glob that matched nothing all look exactly like
 * "nothing to watch" from the loop's side, and the job would then succeed while
 * watching nothing. So no row files is an error, and so is any file that does not
 * parse, has the wrong shape, or does not match its own name. When the last row is
 * retired, disable the workflow instead.
 *
 * Usage:  node scripts/load-upstream-watches.mjs [directory]   (default: .github/upstream-watches)
 * Output: the rows as one compact JSON array on stdout, sorted by file name.
 * Exit:   0 = rows loaded, 1 = no rows or an invalid row file.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ALLOWED_KEYS = new Set(['tracker', 'repo', 'kind', 'number', 'composer', 'released'])

/**
 * Explain what is wrong with one parsed row, or return null when it is valid.
 *
 * @param {unknown} row The parsed file contents.
 * @param {string} name The file's name, which must match the row.
 * @returns {string|null}
 */
export function rowProblem(row, name) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return 'must hold a single JSON object'
    }

    const unknown = Object.keys(row).filter((key) => !ALLOWED_KEYS.has(key))
    if (unknown.length > 0) {
        return `has unknown key(s): ${unknown.join(', ')}`
    }

    if (!Number.isInteger(row.tracker) || row.tracker < 1) {
        return '`tracker` must be a positive issue number'
    }

    if (typeof row.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(row.repo)) {
        return '`repo` must be `owner/name`'
    }

    if (row.kind !== 'issue' && row.kind !== 'pr') {
        return '`kind` must be `issue` or `pr`'
    }

    if (!Number.isInteger(row.number) || row.number < 1) {
        return '`number` must be a positive issue or pull request number'
    }

    if ('composer' in row && (typeof row.composer !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(row.composer))) {
        return '`composer` must be a `vendor/package` name'
    }

    if ('released' in row && row.released !== true) {
        return '`released` must be `true`, or be left out'
    }

    if ('released' in row && row.kind !== 'pr') {
        return '`released` applies only to a `pr` row, since only a pull request has a merge commit'
    }

    const expected = `${row.tracker}-${row.repo.replace('/', '-')}-${row.number}.json`
    if (name !== expected) {
        return `must be named ${expected}`
    }

    return null
}

/**
 * Read and validate every row file in a directory.
 *
 * @param {string} directory The directory holding the row files.
 * @returns {{rows: object[], errors: string[]}}
 */
export function loadWatches(directory) {
    let names

    try {
        names = readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
    } catch (error) {
        return { rows: [], errors: [`cannot read ${directory}: ${error.message}`] }
    }

    if (names.length === 0) {
        return { rows: [], errors: [`no row files (*.json) in ${directory}`] }
    }

    const rows = []
    const errors = []

    for (const name of names) {
        let row

        try {
            row = JSON.parse(readFileSync(join(directory, name), 'utf8'))
        } catch (error) {
            errors.push(`${name}: not valid JSON (${error.message})`)
            continue
        }

        const problem = rowProblem(row, name)
        if (problem !== null) {
            errors.push(`${name}: ${problem}`)
            continue
        }

        rows.push(row)
    }

    return { rows, errors }
}

// Run only when invoked as a script, so the tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const directory = process.argv[2] ?? '.github/upstream-watches'
    const { rows, errors } = loadWatches(directory)

    if (errors.length > 0) {
        for (const error of errors) {
            process.stderr.write(`::error::upstream watch ${error}\n`)
        }
        process.exit(1)
    }

    process.stdout.write(`${JSON.stringify(rows)}\n`)
}
