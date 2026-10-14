// Coverage for the upstream watch loader (#2673).
//
// `watch-upstream.yml` builds its `WATCHES` list from one file per row. The loader's
// one job beyond reading them is to refuse to return an empty or partial list: a
// wrong path, a missing directory or a malformed file would otherwise look exactly
// like "nothing to watch", and the scheduled job would succeed while watching
// nothing. The failure cases below are the point, and they spawn the real script
// because the workflow consumes its exit code.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadWatches } from './load-upstream-watches.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOADER = join(ROOT, 'scripts', 'load-upstream-watches.mjs')
const WATCH_DIR = join(ROOT, '.github', 'upstream-watches')
const WORKFLOW = join(ROOT, '.github', 'workflows', 'watch-upstream.yml')

const ROW = { tracker: 1729, repo: 'pestphp/pest-plugin-mutate', kind: 'pr', number: 38 }
const ROW_NAME = '1729-pestphp-pest-plugin-mutate-38.json'

/**
 * Run the loader against a scratch directory holding the given files.
 *
 * @param {Record<string, string>} files File name to raw contents.
 */
function run(files) {
    const scratch = mkdtempSync(join(tmpdir(), 'upstream-watches-'))

    try {
        for (const [name, contents] of Object.entries(files)) {
            writeFileSync(join(scratch, name), contents)
        }

        const result = spawnSync(process.execPath, [LOADER, scratch], { encoding: 'utf8' })

        return { status: result.status, stdout: result.stdout, stderr: result.stderr }
    } finally {
        rmSync(scratch, { recursive: true, force: true })
    }
}

describe('load-upstream-watches', () => {
    it('prints every row as one JSON array, sorted by file name', () => {
        const other = { tracker: 1992, repo: 'pestphp/pest', kind: 'issue', number: 1820, composer: 'pestphp/pest' }
        const { status, stdout } = run({
            '1992-pestphp-pest-1820.json': JSON.stringify(other),
            [ROW_NAME]: JSON.stringify(ROW),
            'README.md': '# not a row',
        })

        expect(status).toBe(0)
        expect(JSON.parse(stdout)).toEqual([ROW, other])
    })

    it('fails on a directory with no row files', () => {
        const { status, stdout, stderr } = run({ 'README.md': '# only notes' })

        expect(status).toBe(1)
        expect(stdout).toBe('')
        expect(stderr).toContain('no row files')
    })

    it('fails on a directory that does not exist', () => {
        const result = spawnSync(process.execPath, [LOADER, join(tmpdir(), 'upstream-watches-missing-2673')], { encoding: 'utf8' })

        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('cannot read')
    })

    it('fails on a file that is not valid JSON, even beside a valid one', () => {
        const { status, stdout, stderr } = run({
            [ROW_NAME]: JSON.stringify(ROW),
            '1992-pestphp-pest-1820.json': '{"tracker": 1992,',
        })

        expect(status).toBe(1)
        expect(stdout).toBe('')
        expect(stderr).toContain('1992-pestphp-pest-1820.json: not valid JSON')
    })

    it.each([
        ['an array', [ROW], 'single JSON object'],
        ['an unknown key', { ...ROW, tracking: 1 }, 'unknown key(s): tracking'],
        ['a string tracker', { ...ROW, tracker: '1729' }, '`tracker`'],
        ['a bare repo name', { ...ROW, repo: 'pest-plugin-mutate' }, '`repo`'],
        ['an unknown kind', { ...ROW, kind: 'discussion' }, '`kind`'],
        ['a missing number', { tracker: 1729, repo: 'pestphp/pest-plugin-mutate', kind: 'pr' }, '`number`'],
        ['a malformed composer name', { ...ROW, composer: 'pest' }, '`composer`'],
        ['a non-boolean released', { ...ROW, released: 'yes' }, '`released` must be `true`'],
        ['released on an issue row', { ...ROW, kind: 'issue', released: true }, '`released` applies only to a `pr` row'],
    ])('fails on a row with %s', (_label, row, message) => {
        const { status, stderr } = run({ [ROW_NAME]: JSON.stringify(row) })

        expect(status).toBe(1)
        expect(stderr).toContain(message)
    })

    it('accepts released on a pull-request row', () => {
        const { status, stdout } = run({ [ROW_NAME]: JSON.stringify({ ...ROW, released: true }) })

        expect(status).toBe(0)
        expect(JSON.parse(stdout)).toEqual([{ ...ROW, released: true }])
    })

    it('fails on a file whose name does not match its row', () => {
        const { status, stderr } = run({ '1729-pestphp-pest-plugin-mutate-39.json': JSON.stringify(ROW) })

        expect(status).toBe(1)
        expect(stderr).toContain(`must be named ${ROW_NAME}`)
    })

    it('loads every row file in the repository without error', () => {
        const { rows, errors } = loadWatches(WATCH_DIR)
        const files = readdirSync(WATCH_DIR).filter((name) => name.endsWith('.json'))

        // An empty directory is valid in this repository: the workflow exits early when there
        // are no rows, and the loader reports exactly one "no rows" error for it.
        if (files.length === 0) {
            expect(rows).toEqual([])
            expect(errors).toHaveLength(1)
            return
        }

        expect(errors).toEqual([])
        expect(rows).toHaveLength(files.length)
    })

    it('is how the workflow builds WATCHES, with no literal list left in it', () => {
        const workflow = readFileSync(WORKFLOW, 'utf8')

        expect(workflow).toContain('WATCHES=$(node scripts/load-upstream-watches.mjs .github/upstream-watches)')
        expect(workflow).not.toMatch(/WATCHES='/)
        expect(workflow).toMatch(/set -euo pipefail/)
    })
})
