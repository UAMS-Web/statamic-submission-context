#!/usr/bin/env node
// Fails when the required status checks of `main` and the workflows' job names drift apart (#11).
//
// `main` requires each job's `name:` string through an organization ruleset. Two drifts exist and
// they are not equally harmful:
//
//   - BLOCKING: the ruleset requires a name no job reports (a renamed or deleted job). The old name
//     stays pending forever and blocks every pull request. This is always an error.
//   - UNREQUIRED: a job reports a name the ruleset does not require (a new or renamed job). It reads
//     as a gate and is not one. This is a warning on a pull request, because the ruleset can only
//     be edited around the merge: requiring the name before the job exists blocks every other
//     pull request, so a pull request that adds a job cannot also pass a check that demands it.
//     With `--strict` (a push to `main`, a scheduled run) it is an error.
//
// Order that works: to add a job, merge it, then add its name to the ruleset. To remove one, take
// its name out of the ruleset first, then merge the pull request.
//
// The job names come from every workflow that runs on `pull_request`, with a `${{ matrix.<key> }}`
// in a name expanded from the job's `strategy.matrix.include`. Any other expression is an error
// rather than a guess, because a name this script cannot resolve is a name it cannot compare.
//
// The required contexts come from the repository's effective rules for `main`
// (`GET repos/{owner}/{repo}/rules/branches/main`), saved to a file by the caller. That endpoint
// is readable without a credential on a public repository, so the default workflow token is enough.
//
// THE INSTRUMENT IS CHECKED BEFORE THE ANSWER IS READ. A rules file with no `required_status_checks`
// rule, or a workflow directory with no job, would look exactly like "nothing drifted", so both are
// errors, and a planted fixture must be reported before the real comparison runs.
//
// Usage: node scripts/check-required-checks.mjs [--strict] <rules.json> [workflow-directory]
// Exit:  0 = no drift (warnings allowed), 1 = drift, 2 = the check could not run.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

/** A `${{ ... }}` expression in a job name; group 1 is its trimmed body. */
const EXPRESSION = /\$\{\{\s*(.*?)\s*\}\}/g
/** The one expression form this check resolves: `matrix.<key>`; group 1 is the key. */
const MATRIX_REFERENCE = /^matrix\.([A-Za-z_][\w-]*)$/

/**
 * Whether a workflow's `on:` value includes a pull-request event.
 *
 * @param {unknown} on
 * @returns {boolean}
 */
export function runsOnPullRequest(on) {
    const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : []

    return events.some((event) => event === 'pull_request' || event === 'pull_request_target')
}

/**
 * Expand the `${{ matrix.<key> }}` references in one job name.
 *
 * @param {string} name The job's `name:` as written.
 * @param {unknown} job The parsed job.
 * @returns {string[]} One name per matrix `include` entry, or the name itself when it has no expression.
 * @throws {Error} For an expression other than a matrix reference, or one the matrix cannot resolve.
 */
export function expandName(name, job) {
    // A name with no expression is already the name GitHub reports
    const expressions = [...name.matchAll(EXPRESSION)]
    if (expressions.length === 0) {
        return [name]
    }

    // An expression needs a matrix to resolve against; refuse rather than guess
    const include = job?.strategy?.matrix?.include
    if (!Array.isArray(include) || include.length === 0) {
        throw new Error(`job name "${name}" has an expression but the job has no strategy.matrix.include to resolve it from`)
    }

    // One reported name per include entry, with each reference replaced by that entry's value
    return include.map((entry) =>
        name.replace(EXPRESSION, (_, expression) => {
            const reference = MATRIX_REFERENCE.exec(expression)
            if (reference === null) {
                throw new Error(`job name "${name}" uses \${{ ${expression} }}, which this check cannot resolve; only matrix.<key> is supported`)
            }
            const value = entry?.[reference[1]]
            if (value === undefined || value === null || typeof value === 'object') {
                throw new Error(`job name "${name}" needs matrix.${reference[1]}, which an include entry does not define`)
            }

            return String(value)
        }),
    )
}

/**
 * The check names one workflow reports on a pull request.
 *
 * @param {string} source The workflow's YAML.
 * @returns {string[]} Empty when the workflow does not run on a pull request.
 * @throws {Error} When the YAML does not parse or a name cannot be resolved.
 */
export function jobNames(source) {
    // Parse the YAML and require a jobs mapping
    const workflow = parse(source)
    if (workflow === null || typeof workflow !== 'object' || workflow.jobs === null || typeof workflow.jobs !== 'object') {
        throw new Error('workflow has no jobs mapping')
    }

    // Only workflows that run on a pull request report a check there
    if (!runsOnPullRequest(workflow.on)) {
        return []
    }

    // A job reports its `name:`, or its id when it has none
    return Object.entries(workflow.jobs).flatMap(([id, job]) => {
        const name = typeof job?.name === 'string' ? job.name : id

        return expandName(name, job)
    })
}

/**
 * Read every workflow in a directory and collect the names, with the file each came from.
 *
 * @param {string} directory
 * @returns {Map<string, string>} name to the file that reports it.
 * @throws {Error} For a duplicate name (a required check is one string, so two jobs sharing it
 *         satisfy it together), an unreadable workflow, or no job names at all.
 */
export function collectJobNames(directory) {
    // Read the workflow files in a stable order
    const names = new Map()
    const files = readdirSync(directory).filter((file) => /\.ya?ml$/.test(file)).sort()

    for (const file of files) {
        // Name the file in any parse or resolution error
        let found
        try {
            found = jobNames(readFileSync(join(directory, file), 'utf8'))
        } catch (error) {
            throw new Error(`${file}: ${error.message}`, { cause: error })
        }

        // Refuse a name already reported by another job
        for (const name of found) {
            if (names.has(name)) {
                throw new Error(`the check name "${name}" is reported by both ${names.get(name)} and ${file}; a required check is one string`)
            }
            names.set(name, file)
        }
    }

    // An empty result is an unreadable directory, not a clean one
    if (names.size === 0) {
        throw new Error(`no job names found under ${directory}; a directory with no pull-request job is not a clean result`)
    }

    return names
}

/**
 * The contexts the effective rules require.
 *
 * @param {unknown} rules The parsed response of `GET repos/{o}/{r}/rules/branches/{branch}`.
 * @returns {string[]} Unique, in first-seen order.
 * @throws {Error} When there is no `required_status_checks` rule to read.
 */
export function requiredContexts(rules) {
    if (!Array.isArray(rules)) {
        throw new Error('the rules file must hold the JSON array the effective-rules endpoint returns')
    }

    // Take every required_status_checks rule; several rulesets can each contribute one
    const checkRules = rules.filter((rule) => rule?.type === 'required_status_checks')
    if (checkRules.length === 0) {
        throw new Error('no required_status_checks rule in the rules file; that would read as "nothing is required"')
    }

    // Collect the contexts and refuse a malformed entry
    const contexts = checkRules.flatMap((rule) => (rule.parameters?.required_status_checks ?? []).map((check) => check?.context))
    if (contexts.some((context) => typeof context !== 'string' || context === '')) {
        throw new Error('a required_status_checks entry has no context string')
    }

    return [...new Set(contexts)]
}

/**
 * Compare the two lists.
 *
 * @param {string[]} required Contexts the ruleset requires.
 * @param {Iterable<string>} reported Names the workflows report.
 * @returns {{blocking: string[], unrequired: string[]}}
 */
export function compare(required, reported) {
    // Index both lists for exact, case-sensitive membership tests
    const reportedSet = new Set(reported)
    const requiredSet = new Set(required)

    return {
        blocking: required.filter((name) => !reportedSet.has(name)),
        unrequired: [...reportedSet].filter((name) => !requiredSet.has(name)),
    }
}

/**
 * Plant a drift in a known fixture and require it to be seen, and a matching pair to pass.
 *
 * @returns {string|null} A description of what failed, or null when the instrument works.
 */
export function selfCheck() {
    // A fixture covering a plain name, a matrix name and a job with no name
    const workflow = [
        'on: pull_request',
        'jobs:',
        '  a:',
        '    name: Alpha',
        '  b:',
        '    name: Beta (${{ matrix.n }})',
        '    strategy:',
        '      matrix:',
        '        include:',
        '          - n: one',
        '          - n: two',
        '  c:',
        '    runs-on: x',
    ].join('\n')

    // The extraction must return each expected name
    const names = jobNames(workflow)
    if (names.join('|') !== 'Alpha|Beta (one)|Beta (two)|c') {
        return `extraction returned "${names.join('|')}"`
    }

    // A matching pair must report no drift
    const matching = compare(['Alpha', 'Beta (one)', 'Beta (two)', 'c'], names)
    if (matching.blocking.length + matching.unrequired.length !== 0) {
        return 'a matching pair was reported as drift'
    }

    // A planted drift must be reported in both directions
    const drifted = compare(['Alpha', 'Gone'], names)
    if (drifted.blocking.join('|') !== 'Gone' || drifted.unrequired.join('|') !== 'Beta (one)|Beta (two)|c') {
        return 'a planted drift was not reported in both directions'
    }

    return null
}

/**
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} The exit code.
 */
export function main(argv) {
    // Parse the arguments
    const strict = argv.includes('--strict')
    const [rulesPath, directory = '.github/workflows'] = argv.filter((arg) => arg !== '--strict')

    if (rulesPath === undefined) {
        console.error('usage: check-required-checks.mjs [--strict] <rules.json> [workflow-directory]')

        return 2
    }

    // Prove the instrument can see a planted drift before reading its answer
    const broken = selfCheck()
    if (broken !== null) {
        console.error(`required-checks check: SELF-CHECK FAILED - it cannot see what it is looking for: ${broken}`)

        return 2
    }

    // Read the two lists; either failing is "could not run", never "no drift"
    let required
    let reported
    try {
        required = requiredContexts(JSON.parse(readFileSync(rulesPath, 'utf8')))
        reported = collectJobNames(directory)
    } catch (error) {
        console.error(`required-checks check: could not run: ${error.message}`)

        return 2
    }

    // Compare, then report each drift as an annotation
    const { blocking, unrequired } = compare(required, reported.keys())

    for (const name of blocking) {
        console.log(`::error::The ruleset requires "${name}" and no workflow job reports it. It stays pending and blocks every pull request. Remove it from the ruleset, or restore the job.`)
    }
    for (const name of unrequired) {
        const level = strict ? 'error' : 'warning'
        console.log(`::${level}::${reported.get(name)} reports "${name}" and the ruleset does not require it, so it is not a gate. Add it to the ruleset.`)
    }

    // A blocking drift always fails; an unrequired one fails only under --strict
    if (blocking.length === 0 && (unrequired.length === 0 || !strict)) {
        console.log(`required-checks check: ${required.length} required, ${reported.size} reported, ${unrequired.length} unrequired (self-check passed).`)

        return 0
    }

    return 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main(process.argv.slice(2))
}
