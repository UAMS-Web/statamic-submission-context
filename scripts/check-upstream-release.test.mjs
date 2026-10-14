// Coverage for the upstream release check (#2727).
//
// `watch-upstream.yml` asks this script whether the newest release on a merged pull request's
// base-branch line contains its merge commit. The two ways it can answer wrongly are reading a
// tag from another line (a `12.x` tag never contains a `13.x` fix) and reading a failed check as
// "not released yet". Both are pinned here, and the CLI cases spawn the real script with stub
// `git` and `gh` on PATH because the workflow consumes its output and exit code.

import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkRelease, newestTagOnLine, parseLsRemote, releaseLine, tagContains } from './check-upstream-release.mjs'

const SCRIPT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'scripts', 'check-upstream-release.mjs')

// laravel/framework shipped v12.69.3 and v13.34.0 the same day, so both lines carry a recent tag
const LARAVEL_TAGS = ['v12.69.2', 'v12.69.3', 'v13.33.0', 'v13.34.0', 'v13.35.0-beta.1', 'v11.9.9']

describe('releaseLine', () => {
    it.each([
        ['13.x', { major: 13, minor: null }],
        ['6.x', { major: 6, minor: null }],
        ['5.1.x', { major: 5, minor: 1 }],
        ['v2.x', { major: 2, minor: null }],
    ])('reads %s as a release line', (baseRef, line) => {
        expect(releaseLine(baseRef)).toEqual(line)
    })

    it.each(['main', 'master', 'develop', '13.0', 'feature/13.x'])('reads %s as no line', (baseRef) => {
        expect(releaseLine(baseRef)).toBeNull()
    })
})

describe('newestTagOnLine', () => {
    it('takes the newest tag on the base line, not a newer-looking tag from another line', () => {
        expect(newestTagOnLine(LARAVEL_TAGS, { major: 13, minor: null })).toBe('v13.34.0')
        expect(newestTagOnLine(LARAVEL_TAGS, { major: 12, minor: null })).toBe('v12.69.3')
    })

    it('skips a pre-release, which never retires a patch', () => {
        expect(newestTagOnLine(['v13.34.0', 'v13.35.0-beta.1', 'v13.35.0-RC1'], { major: 13, minor: null })).toBe('v13.34.0')
    })

    it('compares numerically, so 13.10.0 is newer than 13.9.0', () => {
        expect(newestTagOnLine(['13.9.0', '13.10.0', '13.2.0'], { major: 13, minor: null })).toBe('13.10.0')
    })

    it('narrows a minor line to its minor', () => {
        expect(newestTagOnLine(['v5.1.4', 'v5.2.0', 'v5.1.10'], { major: 5, minor: 1 })).toBe('v5.1.10')
    })

    it('takes every stable tag when the base names no line', () => {
        expect(newestTagOnLine(LARAVEL_TAGS, null)).toBe('v13.34.0')
    })

    it('returns null when the line has no stable tag yet', () => {
        expect(newestTagOnLine(LARAVEL_TAGS, { major: 14, minor: null })).toBeNull()
    })
})

describe('tagContains', () => {
    it.each([
        ['behind', true],
        ['identical', true],
        ['ahead', false],
        ['diverged', false],
    ])('reads %s as %s', (status, contained) => {
        expect(tagContains(status)).toBe(contained)
    })

    it('throws on a status it does not know, rather than guessing', () => {
        expect(() => tagContains('')).toThrow('unexpected compare status')
    })
})

describe('parseLsRemote', () => {
    it('reads tag names from ls-remote output', () => {
        const output = 'aaa\trefs/tags/v13.34.0\nbbb\trefs/tags/v12.69.3\n\n'

        expect(parseLsRemote(output)).toEqual(['v13.34.0', 'v12.69.3'])
    })
})

describe('checkRelease', () => {
    /**
     * A runner that answers ls-remote from a tag list and compare from a status, recording calls.
     *
     * @param {string[]} tags Tag names.
     * @param {string} status The compare status to return.
     */
    function fakeRunner(tags, status) {
        const calls = []
        const run = (command, args) => {
            calls.push([command, ...args].join(' '))

            return command === 'git' ? tags.map((tag) => `sha\trefs/tags/${tag}`).join('\n') : `${status}\n`
        }

        return { calls, run }
    }

    it('compares the merge against the newest tag on the base line', () => {
        const { calls, run } = fakeRunner(LARAVEL_TAGS, 'behind')

        expect(checkRelease('laravel/framework', '13.x', '6070a6d7e9', run))
            .toEqual({ line: '13.x', tag: 'v13.34.0', status: 'behind', released: true })
        expect(calls[1]).toBe('gh api repos/laravel/framework/compare/v13.34.0...6070a6d7e9 --jq .status')
    })

    it('reports not released while the newest tag on the line lacks the merge', () => {
        const { run } = fakeRunner(LARAVEL_TAGS, 'ahead')

        expect(checkRelease('laravel/framework', '13.x', '6070a6d7e9', run).released).toBe(false)
    })

    it('makes no compare call when the line has no tag yet', () => {
        const { calls, run } = fakeRunner(LARAVEL_TAGS, 'behind')

        expect(checkRelease('laravel/framework', '14.x', '6070a6d7e9', run))
            .toEqual({ line: '14.x', tag: null, status: null, released: false })
        expect(calls).toHaveLength(1)
    })
})

describe('the script', () => {
    /**
     * Run the real script with stub `git` and `gh` on PATH.
     *
     * @param {string[]} args The script's arguments.
     * @param {{tags?: string, status?: string, ghExit?: number}} stubs What the stubs answer.
     */
    function runScript(args, { tags = '', status = 'behind', ghExit = 0 } = {}) {
        const bin = mkdtempSync(join(tmpdir(), 'upstream-release-'))

        try {
            writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s' '${tags}'\n`)
            writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho '${status}'\nexit ${ghExit}\n`)
            chmodSync(join(bin, 'git'), 0o755)
            chmodSync(join(bin, 'gh'), 0o755)

            return spawnSync(process.execPath, [SCRIPT, ...args], {
                encoding: 'utf8',
                env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
            })
        } finally {
            rmSync(bin, { recursive: true, force: true })
        }
    }

    const tags = 'a\trefs/tags/v12.69.3\nb\trefs/tags/v13.34.0\n'

    it.skipIf(process.platform === 'win32')('prints the answer as one JSON object', () => {
        const result = runScript(['laravel/framework', '13.x', '6070a6d7e9'], { tags, status: 'behind' })

        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({ line: '13.x', tag: 'v13.34.0', status: 'behind', released: true })
    })

    it.skipIf(process.platform === 'win32')('fails when the compare call fails, rather than reporting not released', () => {
        const result = runScript(['laravel/framework', '13.x', '6070a6d7e9'], { tags, ghExit: 1 })

        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('release check for laravel/framework failed')
    })

    it('refuses malformed arguments', () => {
        const result = spawnSync(process.execPath, [SCRIPT, 'framework', '13.x', 'not-a-sha'], { encoding: 'utf8' })

        expect(result.status).toBe(1)
        expect(result.stderr).toContain('usage:')
    })
})
