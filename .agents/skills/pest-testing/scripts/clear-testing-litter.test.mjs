// Tests for clear-testing-litter.mjs (UAMS-Web/uams-claude-skills#118). Each case builds a
// throwaway repository root and runs the script as a child process with `php` and `git`
// replaced by stubs on PATH, so no Laravel application, PHP or real checkout is needed. The
// stubs record every call; the `git` stub restores the placeholder the way `git checkout`
// would.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = process.env.CLEAR_TESTING_LITTER_SCRIPT || join(dirname(fileURLToPath(import.meta.url)), 'clear-testing-litter.mjs')
const PLACEHOLDER_TEXT = '*\n!.gitignore\n'
const isWindows = process.platform === 'win32'

// The stub both commands run: append the call to the log, then act as asked by the
// environment. `git checkout -- <path>` writes the placeholder unless STUB_GIT_RESTORE=0;
// a call matching STUB_FAIL exits 3.
const STUB = `
import { appendFileSync, writeFileSync } from 'node:fs'
const [name, ...args] = process.argv.slice(2)
const line = [name, ...args].join(' ')
appendFileSync(process.env.STUB_LOG, line + '\\n')
if (name === 'git' && args[0] === 'checkout' && process.env.STUB_GIT_RESTORE !== '0') {
    writeFileSync(args[args.length - 1], ${JSON.stringify(PLACEHOLDER_TEXT)})
}
// A failing call fails after acting, so a caller that reads only the file and not the
// status is caught.
if (process.env.STUB_FAIL && line.includes(process.env.STUB_FAIL)) process.exit(3)
`

const cleanups = []
afterEach(() => {
    while (cleanups.length) rmSync(cleanups.pop(), { recursive: true, force: true })
})

function tempDir(prefix) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    cleanups.push(dir)
    return dir
}

/** A repository root with `artisan` and the testing directory holding the placeholder. */
function makeRoot({ artisan = true, testingDir = true, placeholder = true } = {}) {
    const root = tempDir('litter-root-')
    if (artisan) writeFileSync(join(root, 'artisan'), '<?php\n')
    const dir = join(root, 'storage', 'framework', 'testing')
    if (testingDir) {
        mkdirSync(dir, { recursive: true })
        if (placeholder) writeFileSync(join(dir, '.gitignore'), PLACEHOLDER_TEXT)
    }
    return { root, dir }
}

function linkDir(target, path) {
    symlinkSync(target, path, isWindows ? 'junction' : 'dir')
}

function run(root, env = {}) {
    const bin = tempDir('litter-bin-')
    writeFileSync(join(bin, 'stub.mjs'), STUB)
    for (const name of ['php', 'git']) {
        if (isWindows) {
            writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${join(bin, 'stub.mjs')}" ${name} %*\r\n`)
        } else {
            writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'stub.mjs')}" ${name} "$@"\n`, { mode: 0o755 })
        }
    }
    const log = join(bin, 'calls.log')
    writeFileSync(log, '')
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`, STUB_LOG: log, ...env },
    })
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
}

const ARTISAN_CALLS = ['php artisan cache:clear', 'php artisan statamic:stache:clear']

describe('clearing litter', () => {
    it('removes every entry except .gitignore, prints each one, then clears both caches', () => {
        const { root, dir } = makeRoot()
        mkdirSync(join(dir, 'stache-root', 'collections'), { recursive: true })
        writeFileSync(join(dir, 'stache-root', 'collections', 'pages.yaml'), 'title: x\n')
        mkdirSync(join(dir, 'content-mirror'))
        writeFileSync(join(dir, 'band.lock'), '')
        writeFileSync(join(dir, '.hidden'), '')

        const r = run(root)

        assert.equal(r.status, 0, r.stderr)
        assert.deepEqual(readdirSync(dir), ['.gitignore'])
        assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), PLACEHOLDER_TEXT)
        for (const name of ['.hidden', 'band.lock', 'content-mirror', 'stache-root']) {
            assert.match(r.stdout, new RegExp(`^removed storage/framework/testing/${name.replace('.', '\\.')}$`, 'm'))
        }
        assert.deepEqual(r.calls, ARTISAN_CALLS, 'the placeholder was kept, so git is not called')
        assert.match(r.stdout, /^clear-testing-litter: done$/m)
    })

    it('is a no-op on a clean tree: nothing removed, nothing restored, exit 0', () => {
        const { root, dir } = makeRoot()

        const r = run(root)

        assert.equal(r.status, 0, r.stderr)
        assert.deepEqual(readdirSync(dir), ['.gitignore'])
        assert.match(r.stdout, /nothing to remove under storage\/framework\/testing/)
        assert.doesNotMatch(r.stdout, /^(removed|restored) /m)
        assert.deepEqual(r.calls, ARTISAN_CALLS)
    })
})

describe('restoring the placeholder', () => {
    it('restores a missing .gitignore with git checkout before clearing the caches', () => {
        const { root, dir } = makeRoot({ placeholder: false })
        writeFileSync(join(dir, 'band.lock'), '')

        const r = run(root)

        assert.equal(r.status, 0, r.stderr)
        assert.deepEqual(readdirSync(dir), ['.gitignore'])
        assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), PLACEHOLDER_TEXT)
        assert.match(r.stdout, /^restored storage\/framework\/testing\/\.gitignore$/m)
        assert.deepEqual(r.calls, ['git checkout -- storage/framework/testing/.gitignore', ...ARTISAN_CALLS])
    })

    it('replaces a .gitignore that is not a file', () => {
        const { root, dir } = makeRoot({ placeholder: false })
        mkdirSync(join(dir, '.gitignore'))

        const r = run(root)

        assert.equal(r.status, 0, r.stderr)
        assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), PLACEHOLDER_TEXT)
        assert.equal(r.calls[0], 'git checkout -- storage/framework/testing/.gitignore')
    })

    it('fails, and clears no cache, when git does not bring the placeholder back', () => {
        const { root } = makeRoot({ placeholder: false })

        const r = run(root, { STUB_GIT_RESTORE: '0' })

        assert.equal(r.status, 1)
        assert.match(r.stderr, /did not restore storage\/framework\/testing\/\.gitignore/)
        assert.deepEqual(r.calls, ['git checkout -- storage/framework/testing/.gitignore'])
    })

    it('fails when git checkout exits non-zero, even if the file appeared', () => {
        const { root, dir } = makeRoot({ placeholder: false })

        const r = run(root, { STUB_FAIL: 'git checkout' })

        assert.ok(existsSync(join(dir, '.gitignore')), 'the stub wrote the file before failing')
        assert.equal(r.status, 1)
        assert.match(r.stderr, /did not restore .*\(exit 3\)/)
        assert.equal(r.calls.length, 1)
    })
})

describe('a removal that fails', () => {
    // A directory without write permission cannot have its entries removed. POSIX only, and
    // not as root, which ignores the mode.
    const skip = isWindows || process.getuid?.() === 0

    it('reports the entry, still clears both caches, and exits 1', { skip }, () => {
        const { root, dir } = makeRoot()
        mkdirSync(join(dir, 'locked'))
        writeFileSync(join(dir, 'locked', 'held.txt'), '')
        writeFileSync(join(dir, 'band.lock'), '')
        chmodSync(join(dir, 'locked'), 0o555)
        try {
            const r = run(root)

            assert.equal(r.status, 1)
            assert.match(r.stderr, /could not remove storage\/framework\/testing\/locked/)
            assert.match(r.stdout, /^removed storage\/framework\/testing\/band\.lock$/m)
            assert.doesNotMatch(r.stdout, /done/)
            assert.deepEqual(r.calls, ARTISAN_CALLS)
        } finally {
            chmodSync(join(dir, 'locked'), 0o755)
        }
    })
})

describe('the artisan commands', () => {
    it('fails naming the command, and stops, when one exits non-zero', () => {
        const { root } = makeRoot()

        const r = run(root, { STUB_FAIL: 'cache:clear' })

        assert.equal(r.status, 1)
        assert.match(r.stderr, /`php artisan cache:clear` failed \(exit 3\)/)
        assert.deepEqual(r.calls, ['php artisan cache:clear'])
        assert.doesNotMatch(r.stdout, /done/)
    })

    it('fails when the Stache clear exits non-zero', () => {
        const { root } = makeRoot()

        const r = run(root, { STUB_FAIL: 'stache:clear' })

        assert.equal(r.status, 1)
        assert.match(r.stderr, /`php artisan statamic:stache:clear` failed/)
        assert.deepEqual(r.calls, ARTISAN_CALLS)
    })
})

describe('refusals', () => {
    it('refuses with exit 2 and touches nothing when the root has no artisan', () => {
        const { root, dir } = makeRoot({ artisan: false })
        writeFileSync(join(dir, 'band.lock'), '')

        const r = run(root)

        assert.equal(r.status, 2)
        assert.match(r.stderr, /refused: no artisan file in /)
        assert.ok(existsSync(join(dir, 'band.lock')))
        assert.deepEqual(r.calls, [])
    })

    it('refuses when artisan is a directory', () => {
        const { root } = makeRoot({ artisan: false })
        mkdirSync(join(root, 'artisan'))

        const r = run(root)

        assert.equal(r.status, 2)
        assert.match(r.stderr, /no artisan file/)
    })

    it('refuses with exit 2, naming the directory, when storage/framework/testing is missing', () => {
        const { root } = makeRoot({ testingDir: false })

        const r = run(root)

        assert.equal(r.status, 2)
        assert.match(r.stderr, /refused: no storage\/framework\/testing directory in /)
        assert.deepEqual(r.calls, [])
    })

    it('refuses when storage/framework/testing is a file', () => {
        const { root } = makeRoot({ testingDir: false })
        mkdirSync(join(root, 'storage', 'framework'), { recursive: true })
        writeFileSync(join(root, 'storage', 'framework', 'testing'), '')

        const r = run(root)

        assert.equal(r.status, 2)
        assert.match(r.stderr, /is not a directory/)
    })
})

describe('never deleting outside the directory', () => {
    it('refuses when the testing directory itself is a link, leaving its target intact', () => {
        const { root } = makeRoot({ testingDir: false })
        const outside = tempDir('litter-outside-')
        writeFileSync(join(outside, 'keep.txt'), 'keep')
        mkdirSync(join(root, 'storage', 'framework'), { recursive: true })
        linkDir(outside, join(root, 'storage', 'framework', 'testing'))

        const r = run(root)

        assert.equal(r.status, 2)
        assert.match(r.stderr, /symbolic link/)
        assert.deepEqual(readdirSync(outside), ['keep.txt'])
        assert.deepEqual(r.calls, [])
    })

    it('refuses when a directory above it is a link out of the repository', () => {
        const { root } = makeRoot({ testingDir: false })
        const outside = tempDir('litter-outside-')
        mkdirSync(join(outside, 'framework', 'testing'), { recursive: true })
        writeFileSync(join(outside, 'framework', 'testing', 'keep.txt'), 'keep')
        linkDir(outside, join(root, 'storage'))

        const r = run(root)

        assert.equal(r.status, 2)
        assert.match(r.stderr, /resolves outside .* through a symbolic link/)
        assert.deepEqual(readdirSync(join(outside, 'framework', 'testing')), ['keep.txt'])
        assert.deepEqual(r.calls, [])
    })

    it('removes a link inside the directory without touching what it points at', () => {
        const { root, dir } = makeRoot()
        const outside = tempDir('litter-outside-')
        mkdirSync(join(outside, 'nested'))
        writeFileSync(join(outside, 'keep.txt'), 'keep')
        writeFileSync(join(outside, 'nested', 'keep.txt'), 'keep')
        linkDir(outside, join(dir, 'mirror-link'))
        mkdirSync(join(dir, 'stache-root'))
        linkDir(outside, join(dir, 'stache-root', 'deep-link'))

        const r = run(root)

        assert.equal(r.status, 0, r.stderr)
        assert.deepEqual(readdirSync(dir), ['.gitignore'])
        assert.deepEqual(readdirSync(outside).sort(), ['keep.txt', 'nested'])
        assert.deepEqual(readdirSync(join(outside, 'nested')), ['keep.txt'])
        assert.match(r.stdout, /^removed storage\/framework\/testing\/mirror-link$/m)
    })

    it('leaves the rest of the repository alone', () => {
        const { root, dir } = makeRoot()
        writeFileSync(join(root, 'storage', 'framework', 'sibling.txt'), 'keep')
        writeFileSync(join(dir, 'band.lock'), '')

        const r = run(root)

        assert.equal(r.status, 0, r.stderr)
        assert.ok(existsSync(join(root, 'storage', 'framework', 'sibling.txt')))
        assert.ok(existsSync(join(root, 'artisan')))
    })
})
