// Coverage for the required-checks drift check (#11).
//
// @command  npx vitest run scripts/check-required-checks.test.mjs
//
// The two things that make this check worthless are reading an empty comparison as "no drift" and
// resolving a job name differently from the way GitHub reports it. Both are pinned, and the CLI
// cases spawn the real script because the workflow consumes its output and exit code.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectJobNames, compare, expandName, jobNames, main, requiredContexts, runsOnPullRequest, selfCheck } from './check-required-checks.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'check-required-checks.mjs')

/** An effective-rules response requiring the given contexts, with an unrelated rule beside it. */
const rules = (...contexts) => [
    { type: 'deletion' },
    { type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) } },
]

/** A pull-request workflow whose jobs are `[id, name]` pairs; a null name leaves the job unnamed. */
const workflow = (...jobs) => `on: pull_request\njobs:\n${jobs.map(([id, name]) => `  ${id}:\n${name === null ? '' : `    name: ${name}\n`}    runs-on: ubuntu-latest\n`).join('')}`

const temporaries = []
/** A fresh temporary directory, removed after the test. */
const scratch = () => {
    const directory = mkdtempSync(join(tmpdir(), 'required-checks-'))
    temporaries.push(directory)

    return directory
}

afterEach(() => {
    while (temporaries.length > 0) {
        rmSync(temporaries.pop(), { recursive: true, force: true })
    }
})

describe('runsOnPullRequest', () => {
    it.each([
        ['pull_request', true],
        ['pull_request_target', true],
        [['push', 'pull_request'], true],
        [{ pull_request: { types: ['opened'] } }, true],
        [{ pull_request_target: null }, true],
        ['push', false],
        [['push', 'schedule'], false],
        [{ push: { branches: ['main'] }, workflow_dispatch: null }, false],
        [null, false],
        [undefined, false],
    ])('%j -> %s', (on, expected) => {
        expect(runsOnPullRequest(on)).toBe(expected)
    })
})

describe('expandName', () => {
    const job = { strategy: { matrix: { include: [{ name: 'lowest', php: '8.4' }, { name: 'PHP 8.5', php: '8.5' }] } } }

    it('returns a plain name unchanged', () => {
        expect(expandName('Pint', {})).toEqual(['Pint'])
    })

    it('expands a matrix reference once per include entry', () => {
        expect(expandName('Compatibility (${{ matrix.name }})', job)).toEqual(['Compatibility (lowest)', 'Compatibility (PHP 8.5)'])
    })

    it('expands several references in one name', () => {
        expect(expandName('${{ matrix.name }} on ${{ matrix.php }}', job)).toEqual(['lowest on 8.4', 'PHP 8.5 on 8.5'])
    })

    it('tolerates no spaces inside the braces', () => {
        expect(expandName('x ${{matrix.name}}', job)).toEqual(['x lowest', 'x PHP 8.5'])
    })

    it('refuses an expression when the job has no matrix include', () => {
        expect(() => expandName('X ${{ matrix.name }}', {})).toThrow(/no strategy\.matrix\.include/)
        expect(() => expandName('X ${{ matrix.name }}', { strategy: { matrix: { include: [] } } })).toThrow(/no strategy\.matrix\.include/)
    })

    it('refuses an expression that is not a matrix reference', () => {
        expect(() => expandName('X ${{ github.event_name }}', job)).toThrow(/cannot resolve/)
    })

    it('refuses a reference an include entry does not define', () => {
        expect(() => expandName('X ${{ matrix.missing }}', job)).toThrow(/does not define/)
    })

    it('refuses a reference that resolves to a nested value', () => {
        const nested = { strategy: { matrix: { include: [{ name: { a: 1 } }] } } }
        expect(() => expandName('X ${{ matrix.name }}', nested)).toThrow(/does not define/)
    })
})

describe('jobNames', () => {
    it('uses the name: of a job, and the id when there is none', () => {
        expect(jobNames(workflow(['a', 'Alpha'], ['b', null]))).toEqual(['Alpha', 'b'])
    })

    it('reports nothing for a workflow that does not run on a pull request', () => {
        expect(jobNames('on: push\njobs:\n  a:\n    name: Alpha\n')).toEqual([])
    })

    it('expands a matrix job', () => {
        const source = [
            'on: pull_request',
            'jobs:',
            '  c:',
            '    name: Check (${{ matrix.n }})',
            '    strategy:',
            '      matrix:',
            '        include:',
            '          - n: one',
            '          - n: two',
        ].join('\n')

        expect(jobNames(source)).toEqual(['Check (one)', 'Check (two)'])
    })

    it('rejects a document with no jobs mapping', () => {
        expect(() => jobNames('on: pull_request\n')).toThrow(/no jobs mapping/)
        expect(() => jobNames('')).toThrow(/no jobs mapping/)
        expect(() => jobNames('jobs: nope\non: pull_request\n')).toThrow(/no jobs mapping/)
    })

    it('rejects YAML that does not parse', () => {
        expect(() => jobNames('on: [unclosed\njobs: {')).toThrow()
    })
})

describe('collectJobNames', () => {
    it('collects names across files and records the file', () => {
        const directory = scratch()
        writeFileSync(join(directory, 'one.yml'), workflow(['a', 'Alpha']))
        writeFileSync(join(directory, 'two.yaml'), workflow(['b', 'Beta']))
        writeFileSync(join(directory, 'notes.txt'), 'ignored')

        expect([...collectJobNames(directory)]).toEqual([['Alpha', 'one.yml'], ['Beta', 'two.yaml']])
    })

    it('refuses a name two files both report', () => {
        const directory = scratch()
        writeFileSync(join(directory, 'one.yml'), workflow(['a', 'Same']))
        writeFileSync(join(directory, 'two.yml'), workflow(['b', 'Same']))

        expect(() => collectJobNames(directory)).toThrow(/"Same" is reported by both one\.yml and two\.yml/)
    })

    it('refuses a name two jobs in one file both report', () => {
        const directory = scratch()
        writeFileSync(join(directory, 'one.yml'), workflow(['a', 'Same'], ['b', 'Same']))

        expect(() => collectJobNames(directory)).toThrow(/"Same" is reported by both one\.yml and one\.yml/)
    })

    it('names the file when a workflow cannot be read', () => {
        const directory = scratch()
        writeFileSync(join(directory, 'bad.yml'), 'on: pull_request\n')

        expect(() => collectJobNames(directory)).toThrow(/^bad\.yml: workflow has no jobs mapping/)
    })

    it('refuses a directory with no pull-request job', () => {
        const directory = scratch()
        writeFileSync(join(directory, 'push.yml'), 'on: push\njobs:\n  a:\n    name: Alpha\n')

        expect(() => collectJobNames(directory)).toThrow(/no job names found/)
    })

    it('refuses an empty directory', () => {
        expect(() => collectJobNames(scratch())).toThrow(/no job names found/)
    })
})

describe('requiredContexts', () => {
    it('reads the contexts of the required_status_checks rule', () => {
        expect(requiredContexts(rules('A', 'B'))).toEqual(['A', 'B'])
    })

    it('unions several rules and removes duplicates', () => {
        expect(requiredContexts([...rules('A', 'B'), ...rules('B', 'C')])).toEqual(['A', 'B', 'C'])
    })

    it('accepts a rule with no checks listed as an empty requirement', () => {
        expect(requiredContexts([{ type: 'required_status_checks', parameters: {} }])).toEqual([])
    })

    it('refuses a response with no required_status_checks rule', () => {
        expect(() => requiredContexts([{ type: 'deletion' }])).toThrow(/no required_status_checks rule/)
        expect(() => requiredContexts([])).toThrow(/no required_status_checks rule/)
    })

    it('refuses a response that is not the endpoint array', () => {
        expect(() => requiredContexts({ message: 'Not Found' })).toThrow(/JSON array/)
        expect(() => requiredContexts(null)).toThrow(/JSON array/)
    })

    it('refuses an entry without a context', () => {
        const broken = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'A' }, {}] } }]
        expect(() => requiredContexts(broken)).toThrow(/no context string/)
        const empty = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: '' }] } }]
        expect(() => requiredContexts(empty)).toThrow(/no context string/)
    })
})

describe('compare', () => {
    it('reports no drift for matching lists in any order', () => {
        expect(compare(['A', 'B'], ['B', 'A'])).toEqual({ blocking: [], unrequired: [] })
    })

    it('reports a required name no job reports as blocking', () => {
        expect(compare(['A', 'Gone'], ['A'])).toEqual({ blocking: ['Gone'], unrequired: [] })
    })

    it('reports a job the ruleset does not require as unrequired', () => {
        expect(compare(['A'], ['A', 'New'])).toEqual({ blocking: [], unrequired: ['New'] })
    })

    it('reports both directions at once, as a rename looks', () => {
        expect(compare(['Old'], ['New'])).toEqual({ blocking: ['Old'], unrequired: ['New'] })
    })

    it('matches names exactly, case and spacing included', () => {
        expect(compare(['Pint'], ['pint']).blocking).toEqual(['Pint'])
        expect(compare(['Pint'], ['Pint ']).blocking).toEqual(['Pint'])
    })
})

describe('selfCheck', () => {
    it('passes on the working instrument', () => {
        expect(selfCheck()).toBeNull()
    })
})

describe('this repository', () => {
    it('resolves the matrix names the ruleset requires', () => {
        const names = [...collectJobNames(join(ROOT, '.github', 'workflows')).keys()]

        expect(names).toContain('Compatibility (lowest statamic/cms)')
        expect(names).toContain('Compatibility (PHP 8.5)')
        expect(names).toContain('Attribution footer')
        expect(names).toContain('Closing keywords')
    })
})

describe('main', () => {
    /** Run `main` with the console captured; returns the exit code and the lines it printed. */
    const quiet = (callback) => {
        const logs = []
        const originalLog = console.log
        const originalError = console.error
        console.log = (...args) => logs.push(args.join(' '))
        console.error = (...args) => logs.push(args.join(' '))
        try {
            return { code: callback(), logs }
        } finally {
            console.log = originalLog
            console.error = originalError
        }
    }

    /** A rules file and a workflow directory on disk; returns their paths. */
    const fixture = (requiredList, ...jobs) => {
        const directory = scratch()
        mkdirSync(join(directory, 'workflows'))
        writeFileSync(join(directory, 'workflows', 'ci.yml'), workflow(...jobs))
        writeFileSync(join(directory, 'rules.json'), JSON.stringify(rules(...requiredList)))

        return { rulesPath: join(directory, 'rules.json'), workflows: join(directory, 'workflows') }
    }

    it('exits 0 and counts the lists when they match', () => {
        const { rulesPath, workflows } = fixture(['Alpha'], ['a', 'Alpha'])
        const { code, logs } = quiet(() => main([rulesPath, workflows]))

        expect(code).toBe(0)
        expect(logs.join('\n')).toMatch(/1 required, 1 reported, 0 unrequired \(self-check passed\)/)
    })

    it('exits 1 for a required name no job reports', () => {
        const { rulesPath, workflows } = fixture(['Alpha', 'Gone'], ['a', 'Alpha'])
        const { code, logs } = quiet(() => main([rulesPath, workflows]))

        expect(code).toBe(1)
        expect(logs.join('\n')).toMatch(/::error::The ruleset requires "Gone"/)
    })

    it('warns but exits 0 for an unrequired job on a pull request', () => {
        const { rulesPath, workflows } = fixture(['Alpha'], ['a', 'Alpha'], ['b', 'New'])
        const { code, logs } = quiet(() => main([rulesPath, workflows]))

        expect(code).toBe(0)
        expect(logs.join('\n')).toMatch(/::warning::ci\.yml reports "New"/)
    })

    it('fails an unrequired job under --strict', () => {
        const { rulesPath, workflows } = fixture(['Alpha'], ['a', 'Alpha'], ['b', 'New'])
        const { code, logs } = quiet(() => main(['--strict', rulesPath, workflows]))

        expect(code).toBe(1)
        expect(logs.join('\n')).toMatch(/::error::ci\.yml reports "New"/)
    })

    it('accepts --strict after the paths', () => {
        const { rulesPath, workflows } = fixture(['Alpha'], ['a', 'Alpha'])

        expect(quiet(() => main([rulesPath, workflows, '--strict'])).code).toBe(0)
    })

    it('exits 2 without a rules file argument', () => {
        const { code, logs } = quiet(() => main([]))

        expect(code).toBe(2)
        expect(logs.join('\n')).toMatch(/usage:/)
    })

    it('exits 2 when the rules file is missing, empty of rules, or not JSON', () => {
        const { workflows } = fixture(['Alpha'], ['a', 'Alpha'])
        const directory = scratch()
        writeFileSync(join(directory, 'none.json'), '[]')
        writeFileSync(join(directory, 'bad.json'), 'not json')

        expect(quiet(() => main([join(directory, 'missing.json'), workflows])).code).toBe(2)
        expect(quiet(() => main([join(directory, 'none.json'), workflows])).code).toBe(2)
        expect(quiet(() => main([join(directory, 'bad.json'), workflows])).code).toBe(2)
    })

    it('exits 2 when the workflow directory yields no jobs', () => {
        const { rulesPath } = fixture(['Alpha'], ['a', 'Alpha'])

        expect(quiet(() => main([rulesPath, scratch()])).code).toBe(2)
    })
})

describe('the command line', () => {
    it('runs the real script and exits 0 against a matching pair', () => {
        const directory = scratch()
        mkdirSync(join(directory, 'workflows'))
        writeFileSync(join(directory, 'workflows', 'ci.yml'), workflow(['a', 'Alpha']))
        writeFileSync(join(directory, 'rules.json'), JSON.stringify(rules('Alpha')))

        const result = spawnSync(process.execPath, [SCRIPT, join(directory, 'rules.json'), join(directory, 'workflows')], { encoding: 'utf8' })

        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/self-check passed/)
    })

    it('exits 1 on a blocking drift', () => {
        const directory = scratch()
        mkdirSync(join(directory, 'workflows'))
        writeFileSync(join(directory, 'workflows', 'ci.yml'), workflow(['a', 'Alpha']))
        writeFileSync(join(directory, 'rules.json'), JSON.stringify(rules('Alpha', 'Gone')))

        const result = spawnSync(process.execPath, [SCRIPT, join(directory, 'rules.json'), join(directory, 'workflows')], { encoding: 'utf8' })

        expect(result.status).toBe(1)
    })

    it('exits 2 with a usage line when given nothing', () => {
        const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })

        expect(result.status).toBe(2)
        expect(result.stderr).toMatch(/usage:/)
    })
})
