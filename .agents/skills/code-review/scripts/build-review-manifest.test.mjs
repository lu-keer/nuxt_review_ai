import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { indexPatchUnits } from './patch-units.mjs'

const scriptPath = fileURLToPath(
  new URL('./build-review-manifest.mjs', import.meta.url),
)

function git(repository, args) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function write(repository, path, content) {
  const absolutePath = join(repository, path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content)
}

function createRepository(t) {
  const repository = mkdtempSync(join(tmpdir(), 'code-review-fixture-'))
  t.after(() => rmSync(repository, { force: true, recursive: true }))
  git(repository, ['init', '--quiet'])
  git(repository, ['config', 'user.email', 'review@example.com'])
  git(repository, ['config', 'user.name', 'Review Test'])
  write(repository, 'base.txt', 'base\n')
  git(repository, ['add', 'base.txt'])
  git(repository, ['commit', '--quiet', '-m', 'base'])
  return repository
}

function runHelper(t, repository, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repository,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const manifestPath = result.stdout.trim()
  assert.match(manifestPath, /manifest\.json$/)
  assert.equal(result.stdout, `${manifestPath}\n`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  t.after(() => rmSync(manifest.tempDirectory, { force: true, recursive: true }))
  return manifest
}

function layer(manifest, kind) {
  return manifest.layers.find((entry) => entry.kind === kind)
}

test('clean worktree creates an empty manifest', (t) => {
  const repository = createRepository(t)
  const manifest = runHelper(t, repository)

  assert.equal(manifest.mode, 'working-tree')
  assert.equal(manifest.textFileCount, 0)
  assert.equal(manifest.changedLines, 0)
  assert.equal(manifest.sizeEligibleForLightReview, true)
  assert.deepEqual(manifest.standardSources, [])
  assert.deepEqual(manifest.aiRulePaths, [])
})

test('collects staged, unstaged and untracked layers', (t) => {
  const repository = createRepository(t)
  write(repository, 'staged.txt', 'staged\n')
  git(repository, ['add', 'staged.txt'])
  write(repository, 'base.txt', 'base\nunstaged\n')
  write(repository, 'untracked.txt', 'untracked\n')

  const manifest = runHelper(t, repository)

  assert.deepEqual(manifest.textFiles, ['base.txt', 'staged.txt', 'untracked.txt'])
  assert.deepEqual(layer(manifest, 'staged').paths, ['staged.txt'])
  assert.deepEqual(layer(manifest, 'unstaged').paths, ['base.txt'])
  assert.deepEqual(layer(manifest, 'untracked').paths, ['untracked.txt'])
  assert.equal(manifest.changedLines, 3)
})

test('fixed-point mode includes committed and working-tree changes', (t) => {
  const repository = createRepository(t)
  const base = git(repository, ['rev-parse', 'HEAD'])
  write(repository, 'committed.txt', 'committed\n')
  git(repository, ['add', 'committed.txt'])
  git(repository, ['commit', '--quiet', '-m', 'committed'])
  write(repository, 'base.txt', 'base\nworking tree\n')

  const manifest = runHelper(t, repository, ['--base', base])

  assert.equal(manifest.mode, 'fixed-point')
  assert.equal(manifest.baseCommit, base)
  assert.equal(manifest.commits.length, 1)
  assert.deepEqual(layer(manifest, 'committed').paths, ['committed.txt'])
  assert.deepEqual(layer(manifest, 'unstaged').paths, ['base.txt'])
})

test('filters ignored and tracked-but-ignored paths', (t) => {
  const repository = createRepository(t)
  write(repository, 'ignored.txt', 'tracked\n')
  git(repository, ['add', 'ignored.txt'])
  git(repository, ['commit', '--quiet', '-m', 'tracked ignored candidate'])
  write(repository, '.gitignore', 'ignored.txt\nignored-new.txt\n')
  git(repository, ['add', '.gitignore'])
  write(repository, 'ignored.txt', 'changed but ignored\n')
  write(repository, 'ignored-new.txt', 'untracked and ignored\n')

  const manifest = runHelper(t, repository)

  assert.deepEqual(manifest.textFiles, ['.gitignore'])
  assert.deepEqual(manifest.aiRulePaths, [])
  assert.equal(manifest.review_plan_required, true)
  assert.equal(manifest.ruleCatalog.length, 5)
  assert.deepEqual(layer(manifest, 'unstaged').paths, [])
  assert.deepEqual(layer(manifest, 'untracked').paths, [])
})

test('preserves NUL-delimited UTF-8 paths when filtering ignored files', (t) => {
  const repository = createRepository(t)
  const ignoredPath = '忽略 文件.txt'
  const reviewedPath = '保留 文件.txt'
  write(repository, ignoredPath, 'tracked\n')
  git(repository, ['add', ignoredPath])
  git(repository, ['commit', '--quiet', '-m', 'track UTF-8 path'])
  write(repository, '.gitignore', `${ignoredPath}\n`)
  write(repository, ignoredPath, 'ignored modification\n')
  write(repository, reviewedPath, 'review this\n')

  const manifest = runHelper(t, repository)

  assert.deepEqual(manifest.textFiles, ['.gitignore', reviewedPath])
  assert.deepEqual(layer(manifest, 'unstaged').paths, [])
  assert.ok(layer(manifest, 'untracked').paths.includes(reviewedPath))
})

test('excludes documentation from review', (t) => {
  const repository = createRepository(t)
  write(repository, 'docs/guide.md', '# guide\n')
  write(repository, 'readme.md', 'readme\n')
  write(repository, '.docs/note.md', 'note\n')
  write(repository, 'docs/data.json', '{"ok":true}\n')
  write(repository, 'src/App.java', 'class App {}\n')

  const manifest = runHelper(t, repository)

  assert.deepEqual(manifest.textFiles, ['src/App.java'])
  assert.equal(manifest.textFileCount, 1)
})

test('documentation-only changes produce an empty text manifest', (t) => {
  const repository = createRepository(t)
  write(repository, 'docs/技术说明.md', '# doc\n')

  const manifest = runHelper(t, repository)

  assert.equal(manifest.textFileCount, 0)
  assert.deepEqual(manifest.textFiles, [])
})

test('records binary files and preserves special text paths', (t) => {
  const repository = createRepository(t)
  const specialPath = 'space name\nfile.txt'
  write(repository, specialPath, 'text\n')
  writeFileSync(join(repository, 'binary.bin'), Buffer.from([1, 0, 2]))

  const manifest = runHelper(t, repository)

  assert.deepEqual(manifest.textFiles, [specialPath])
  assert.deepEqual(manifest.binaryFiles, ['binary.bin'])
  assert.equal(manifest.textFileCount, 1)
})

test('reviews an untracked symlink without reading its target', (t) => {
  const repository = createRepository(t)
  const externalDirectory = mkdtempSync(join(tmpdir(), 'code-review-secret-'))
  t.after(() => rmSync(externalDirectory, { force: true, recursive: true }))
  const target = join(externalDirectory, 'secret.txt')
  writeFileSync(target, 'must-not-enter-patch\n')
  symlinkSync(target, join(repository, 'external-link'))

  const manifest = runHelper(t, repository)
  const patch = readFileSync(layer(manifest, 'untracked').patchPath, 'utf8')

  assert.deepEqual(manifest.textFiles, ['external-link'])
  assert.doesNotMatch(patch, /must-not-enter-patch/)
  assert.match(patch, /code-review-secret-/)
})

test('untracked snapshots preserve file associations and exact patch bytes', (t) => {
  const repository = createRepository(t)
  const contents = new Map([
    ['empty.txt', ''],
    ['中文 space\n"file.txt', '中文\n'],
    ['no-newline.txt', 'last line'],
    ['marker.txt', 'diff --git fake\n'],
  ])
  for (const [path, content] of contents) write(repository, path, content)
  symlinkSync('no-newline.txt', join(repository, 'link'))
  const manifest = runHelper(t, repository)
  const entry = layer(manifest, 'untracked')
  assert.deepEqual(entry.filePatches.map(block => block.path).sort(), [...contents.keys(), 'link'].sort())
  const patches = entry.filePatches.map(block => {
    const bytes = readFileSync(block.patchPath)
    assert.equal(block.bytes, bytes.length)
    assert.deepEqual(block.paths, [block.path])
    const expected = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', block.path], { cwd: repository })
    assert.equal(expected.status, 1)
    assert.deepEqual(bytes, expected.stdout)
    assert.ok(manifest.patch_units.some(unit => unit.path === block.path))
    return bytes
  })
  assert.deepEqual(Buffer.concat(patches), readFileSync(entry.patchPath))
  assert.deepEqual(manifest.patch_units, indexPatchUnits(manifest.layers))
})

for (const output of ['', 'unexpected patch\n']) {
  test(`rejects invalid untracked output (${output.length} bytes) with file diagnostics`, (t) => {
    const repository = createRepository(t)
    write(repository, 'new.txt', 'new\n')
    const wrapperDirectory = mkdtempSync(join(tmpdir(), 'review-git-wrapper-'))
    t.after(() => rmSync(wrapperDirectory, { recursive: true, force: true }))
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
    assert.ok(realGit)
    const wrapper = join(wrapperDirectory, 'git')
    writeFileSync(wrapper, `#!${process.execPath}
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args.includes('--no-index')) {
  process.stdout.write(${JSON.stringify(output)})
  process.exit(1)
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
    chmodSync(wrapper, 0o700)
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repository, encoding: 'utf8',
      env: { ...process.env, PATH: `${wrapperDirectory}${delimiter}${process.env.PATH}` },
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /untracked.*new\.txt/)
    assert.ok(result.stderr.includes(`patch 字节数 ${Buffer.byteLength(output)}`))
  })
}

test('untracked --no-index left side is /dev/null not os.devNull', (t) => {
  const repository = createRepository(t)
  write(repository, 'new.txt', 'new\n')
  write(repository, 'empty.txt', '')
  const wrapperDirectory = mkdtempSync(join(tmpdir(), 'review-git-wrapper-'))
  t.after(() => rmSync(wrapperDirectory, { recursive: true, force: true }))
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
  assert.ok(realGit)
  const logPath = join(wrapperDirectory, 'no-index-args.log')
  const wrapper = join(wrapperDirectory, 'git')
  writeFileSync(wrapper, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args.includes('diff') && args.includes('--no-index')) {
  const sep = args.indexOf('--')
  const left = sep === -1 ? null : args[sep + 1]
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ left }) + '\\n')
  if (left === 'NUL' || left === 'nul' || /^\\\\\\\\.\\\\nul$/i.test(left ?? '')) {
    process.stderr.write('Windows NUL left side is not portable\\n')
    process.exit(2)
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exit(result.status ?? 1)
`)
  chmodSync(wrapper, 0o700)
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repository, encoding: 'utf8',
    env: { ...process.env, PATH: `${wrapperDirectory}${delimiter}${process.env.PATH}` },
  })
  assert.equal(result.status, 0, result.stderr)
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(lines.length, 2)
  for (const entry of lines) {
    assert.equal(entry.left, '/dev/null')
  }
})

test('keeps a rename as one logical text file', (t) => {
  const repository = createRepository(t)
  git(repository, ['mv', 'base.txt', 'renamed.txt'])

  const manifest = runHelper(t, repository)

  assert.deepEqual(manifest.textFiles, ['renamed.txt'])
  assert.equal(manifest.textFileCount, 1)
  assert.deepEqual(layer(manifest, 'staged').paths, ['base.txt', 'renamed.txt'])
})

test('does not leak the ignored side of a rename', (t) => {
  const repository = createRepository(t)
  write(repository, 'other.txt', 'other\n')
  git(repository, ['add', 'other.txt'])
  write(repository, '.gitignore', 'ignored-name.txt\n')
  git(repository, ['add', '.gitignore'])
  git(repository, ['commit', '--quiet', '-m', 'ignore rename destination'])
  git(repository, ['mv', '-f', 'base.txt', 'ignored-name.txt'])
  git(repository, ['mv', 'other.txt', 'other-renamed.txt'])

  const manifest = runHelper(t, repository)

  assert.deepEqual(manifest.textFiles, ['base.txt', 'other-renamed.txt'])
  assert.equal(manifest.textFileCount, 2)
  assert.deepEqual(
    layer(manifest, 'staged').paths,
    ['other.txt', 'other-renamed.txt', 'base.txt'],
  )
  const patch = readFileSync(layer(manifest, 'staged').patchPath, 'utf8')
  assert.doesNotMatch(patch, /^\+\+\+ b\/ignored-name\.txt$/m)
  assert.match(patch, /^rename from other\.txt$/m)
  assert.match(patch, /^rename to other-renamed\.txt$/m)
})

test('discovers only applicable tracked standards', (t) => {
  const repository = createRepository(t)
  const externalDirectory = mkdtempSync(join(tmpdir(), 'code-review-rules-'))
  t.after(() => rmSync(externalDirectory, { force: true, recursive: true }))
  const externalRules = join(externalDirectory, 'AGENTS.md')
  writeFileSync(externalRules, 'external rules must not load\n')
  write(repository, 'AGENTS.md', 'root rules\n')
  write(repository, 'src/AGENTS.md', 'src rules\n')
  write(repository, 'ignored/AGENTS.md', 'ignored tracked rules\n')
  write(repository, 'other/CONTRIBUTING.md', 'other rules\n')
  mkdirSync(join(repository, 'linked'), { recursive: true })
  symlinkSync(externalRules, join(repository, 'linked/AGENTS.md'))
  git(repository, [
    'add',
    'AGENTS.md',
    'src/AGENTS.md',
    'ignored/AGENTS.md',
    'linked/AGENTS.md',
    'other/CONTRIBUTING.md',
  ])
  git(repository, ['commit', '--quiet', '-m', 'standards'])
  write(repository, '.gitignore', 'ignored/AGENTS.md\n')
  git(repository, ['add', '.gitignore'])
  write(repository, 'src/changed.txt', 'changed\n')
  write(repository, 'ignored/changed.txt', 'ignored subtree change\n')
  write(repository, 'linked/changed.txt', 'linked subtree change\n')

  const manifest = runHelper(t, repository)

  assert.deepEqual(manifest.standardSources, ['AGENTS.md', 'src/AGENTS.md'])
})

test('computes the exact light-review size boundaries', (t) => {
  const repository = createRepository(t)
  const lines = (count) =>
    Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
  write(repository, 'first.txt', lines(25))
  write(repository, 'second.txt', lines(25))

  const eligible = runHelper(t, repository)
  assert.equal(eligible.textFileCount, 2)
  assert.equal(eligible.changedLines, 50)
  assert.equal(eligible.sizeEligibleForLightReview, true)

  write(repository, 'third.txt', 'line 51\n')
  const ineligible = runHelper(t, repository)
  assert.equal(ineligible.textFileCount, 3)
  assert.equal(ineligible.changedLines, 51)
  assert.equal(ineligible.sizeEligibleForLightReview, false)
})

test('defers semantic rule selection until batch planning', (t) => {
  const repository = createRepository(t)
  write(repository, '.cursor/mcp.json', '{}\n')

  const manifest = runHelper(t, repository)
  assert.deepEqual(manifest.aiRulePaths, [])
  assert.equal(manifest.review_plan_required, true)
  assert.equal(manifest.ruleCatalog.length, 5)
})

test('rejects invalid refs without writing a manifest path', (t) => {
  const repository = createRepository(t)
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--base', 'missing-review-ref'],
    { cwd: repository, encoding: 'utf8' },
  )

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /missing-review-ref|Needed a single revision/)
})

 test('per-file snapshots preserve exact layer patches across staged and unstaged changes', (t) => {
  const repository = createRepository(t)
  write(repository, 'base.txt', 'base\nstaged\n')
  git(repository, ['add', 'base.txt'])
  write(repository, 'base.txt', 'base\nstaged\n中文\n')
  const manifest = runHelper(t, repository)
  for (const entry of manifest.layers) {
    const blocks = entry.filePatches.map(block => {
      const bytes = readFileSync(block.patchPath)
      assert.equal(bytes.length, block.bytes)
      return bytes
    })
    assert.deepEqual(Buffer.concat(blocks), readFileSync(entry.patchPath))
  }
  assert.deepEqual(manifest.patch_units, indexPatchUnits(manifest.layers))
  assert.ok(manifest.patch_units.some(unit => unit.kind === 'hunk'))
  assert.deepEqual(layer(manifest, 'staged').filePatches[0].paths, ['base.txt'])
  assert.deepEqual(layer(manifest, 'unstaged').filePatches[0].paths, ['base.txt'])
})
