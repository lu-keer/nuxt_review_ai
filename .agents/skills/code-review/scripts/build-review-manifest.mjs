#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverRuleCatalog } from './rule-catalog.mjs'
import { isReviewExcludedPath } from './review-inputs.mjs'
import { indexPatchUnits } from './patch-units.mjs'

const TEXT_FILE_MODE = 0o600
const TEMP_DIR_MODE = 0o700

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function runGit(cwd, args, options = {}) {
  let inputDirectory = null
  let inputFd = null
  let result
  try {
    // Restricted Linux sandboxes can deny shutdown() on Node's stdin socketpair.
    // A regular file also preserves EOF and NUL-delimited input for check-ignore.
    if (options.input !== undefined && options.input !== null) {
      inputDirectory = mkdtempSync(join(tmpdir(), 'code-review-input-'))
      chmodSync(inputDirectory, TEMP_DIR_MODE)
      const inputPath = join(inputDirectory, 'stdin')
      writeFileSync(inputPath, options.input, { mode: TEXT_FILE_MODE, flag: 'wx' })
      inputFd = openSync(inputPath, 'r')
    }
    result = spawnSync('git', args, {
      cwd,
      encoding: options.encoding ?? null,
      stdio: [inputFd ?? 'ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } finally {
    try {
      if (inputFd !== null) closeSync(inputFd)
    } finally {
      if (inputDirectory) rmSync(inputDirectory, { force: true, recursive: true })
    }
  }
  const allowedCodes = options.allowedCodes ?? [0]

  if (result.error) throw result.error
  if (!allowedCodes.includes(result.status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr ?? '').trim()
    throw new Error(stderr || `git ${args[0]} 执行失败（退出码 ${result.status}）`)
  }

  return result.stdout ?? Buffer.alloc(0)
}

function parseArgs(argv) {
  if (argv.length === 0) return { base: null }
  if (argv.length === 2 && argv[0] === '--base' && argv[1]) {
    return { base: argv[1] }
  }
  throw new Error('用法：build-review-manifest.mjs [--base <ref>]')
}

function splitNull(buffer) {
  const values = buffer.toString('utf8').split('\0')
  if (values.at(-1) === '') values.pop()
  return values
}

function unique(values) {
  return [...new Set(values)]
}

function parseNameStatus(buffer) {
  const fields = splitNull(buffer)
  const records = []

  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]
    if (!status) continue
    if (status.startsWith('R') || status.startsWith('C')) {
      records.push({ status, paths: [fields[index++], fields[index++]] })
    } else {
      records.push({ status, paths: [fields[index++]] })
    }
  }

  return records
}

function parseNumstat(buffer) {
  const fields = splitNull(buffer)
  const records = []

  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index]
    const firstTab = header.indexOf('\t')
    const secondTab = header.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue

    const addedRaw = header.slice(0, firstTab)
    const deletedRaw = header.slice(firstTab + 1, secondTab)
    let path = header.slice(secondTab + 1)
    let paths

    if (path === '') {
      const oldPath = fields[++index]
      const newPath = fields[++index]
      paths = [oldPath, newPath]
      path = newPath
    } else {
      paths = [path]
    }

    const binary = addedRaw === '-' || deletedRaw === '-'
    records.push({
      added: binary ? 0 : Number.parseInt(addedRaw, 10),
      binary,
      deleted: binary ? 0 : Number.parseInt(deletedRaw, 10),
      path,
      paths,
    })
  }

  return records
}

function isExcludedPath(path, ignored) {
  return ignored.has(path) || isReviewExcludedPath(path)
}

function ignoredPaths(root, paths) {
  const candidates = unique(paths)
  if (candidates.length === 0) return new Set()

  const output = runGit(
    root,
    ['check-ignore', '--stdin', '-z', '--no-index'],
    {
      allowedCodes: [0, 1],
      input: Buffer.from(`${candidates.join('\0')}\0`),
    },
  )
  return new Set(splitNull(output))
}

function layerArgs(kind, baseCommit) {
  if (kind === 'committed') return [baseCommit + '...HEAD']
  if (kind === 'staged') return ['--cached']
  return []
}

function collectTrackedLayer(root, kind, baseCommit, tempDirectory) {
  const scopeArgs = layerArgs(kind, baseCommit)
  const nameOutput = runGit(root, [
    '--literal-pathspecs',
    'diff',
    '--name-status',
    '-z',
    '-M',
    '-C',
    ...scopeArgs,
  ])
  const nameRecords = parseNameStatus(nameOutput)
  const ignored = ignoredPaths(root, nameRecords.flatMap((record) => record.paths))
  const keptRecords = nameRecords.filter(
    (record) => !record.paths.every((path) => isExcludedPath(path, ignored)),
  )
  const partialRenameRecords = keptRecords.filter(
    (record) =>
      record.paths.length === 2 &&
      record.paths.some((path) => isExcludedPath(path, ignored)),
  )
  const completeRecords = keptRecords.filter(
    (record) => !partialRenameRecords.includes(record),
  )
  const sections = [
    {
      detectRenames: true,
      paths: unique(completeRecords.flatMap((record) => record.paths)),
    },
    {
      detectRenames: false,
      paths: unique(partialRenameRecords.flatMap((record) =>
      record.paths.filter((path) => !isExcludedPath(path, ignored)),
      )),
    },
  ].filter((section) => section.paths.length > 0)
  const patchPath = join(tempDirectory, `${kind}.patch`)

  if (sections.length === 0) {
    writeFileSync(patchPath, '', { mode: TEXT_FILE_MODE })
    return {
      addedLines: 0,
      binaryFiles: [],
      deletedLines: 0,
      kind,
      patchPath,
      paths: [],
      textFiles: [],
      textRecords: [],
    }
  }

  const numstat = []
  const patches = []
  for (const section of sections) {
    const diffOptions = [
      '--literal-pathspecs',
      'diff',
      '--no-ext-diff',
      '--no-color',
      section.detectRenames ? '-M' : '--no-renames',
      ...(section.detectRenames ? ['-C'] : []),
      ...scopeArgs,
    ]
    const sectionNumstat = parseNumstat(runGit(root, [
      ...diffOptions,
      '--numstat',
      '-z',
      '--',
      ...section.paths,
    ]))
    numstat.push(...sectionNumstat)
    const sectionTextPaths = unique(
      sectionNumstat
        .filter((record) => !record.binary)
        .flatMap((record) => record.paths),
    )
    if (sectionTextPaths.length > 0) {
      patches.push(runGit(root, [...diffOptions, '--', ...sectionTextPaths]))
    }
  }
  const textRecords = numstat.filter((record) => !record.binary)
  const binaryRecords = numstat.filter((record) => record.binary)
  const textPaths = unique(textRecords.flatMap((record) => record.paths))

  writeFileSync(patchPath, Buffer.concat(patches), { mode: TEXT_FILE_MODE })
  return {
    addedLines: textRecords.reduce((sum, record) => sum + record.added, 0),
    binaryFiles: binaryRecords.map((record) => record.path),
    deletedLines: textRecords.reduce((sum, record) => sum + record.deleted, 0),
    kind,
    patchPath,
    paths: textPaths,
    textFiles: textRecords.map((record) => record.path),
    textRecords,
  }
}

const UNTRACKED_DIFF_BASE = '/dev/null'

function collectUntrackedLayer(root, tempDirectory) {
  const listed = splitNull(
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  )
  const ignored = ignoredPaths(root, listed)
  const candidates = listed.filter((path) => !isExcludedPath(path, ignored))
  const patchPath = join(tempDirectory, 'untracked.patch')
  const patches = []
  const filePatches = []
  const textFiles = []
  const textRecords = []
  const binaryFiles = []
  let addedLines = 0

  for (const path of candidates) {
    const absolutePath = resolve(root, path)
    const fileStat = lstatSync(absolutePath)
    if (!fileStat.isFile() && !fileStat.isSymbolicLink()) continue
    const contentBuffer = fileStat.isSymbolicLink()
      ? Buffer.from(readlinkSync(absolutePath))
      : readFileSync(absolutePath)
    const sample = contentBuffer.subarray(0, 8_000)
    if (sample.includes(0)) {
      binaryFiles.push(path)
      continue
    }

    const patch = runGit(
      root,
      [
        '--literal-pathspecs',
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-color',
        '--',
        UNTRACKED_DIFF_BASE,
        path,
      ],
      { allowedCodes: [0, 1] },
    )
    if (!patch.length || !patch.subarray(0, 11).equals(Buffer.from('diff --git '))) {
      throw new Error(`无效的 untracked patch：文件 ${JSON.stringify(path)}，patch 字节数 ${patch.length}（为空或缺少 diff --git 头）`)
    }
    patches.push(patch)
    textFiles.push(path)
    const content = contentBuffer.toString('utf8')
    const fileAddedLines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
    addedLines += fileAddedLines
    const record = { added: fileAddedLines, deleted: 0, path, paths: [path] }
    textRecords.push(record)
    const filePatchPath = join(tempDirectory, `untracked-file-${filePatches.length}.patch`)
    writeFileSync(filePatchPath, patch, { mode: TEXT_FILE_MODE })
    filePatches.push({ ...record, patchPath: filePatchPath, bytes: patch.length,
      addedLines: fileAddedLines, deletedLines: 0 })
  }

  writeFileSync(patchPath, Buffer.concat(patches), { mode: TEXT_FILE_MODE })
  return {
    addedLines,
    binaryFiles,
    deletedLines: 0,
    kind: 'untracked',
    filePatches,
    patchPath,
    paths: textFiles,
    textFiles,
    textRecords,
  }
}

function snapshotFilePatches(layer, tempDirectory) {
  const patch = readFileSync(layer.patchPath)
  const starts = []
  const marker = Buffer.from('diff --git ')
  let position = 0
  while (position < patch.length) {
    if (patch.subarray(position, position + marker.length).equals(marker)) starts.push(position)
    const newline = patch.indexOf(10, position)
    if (newline === -1) break
    position = newline + 1
  }
  if (starts.length !== layer.textRecords.length || (patch.length && starts[0] !== 0)) {
    throw new Error(`无法可靠关联 ${layer.kind} 文件与 patch 块：预期文件数 ${layer.textRecords.length}，实际块数 ${starts.length}，patch 字节数 ${patch.length}`)
  }
  return layer.textRecords.map((record, index) => {
    const block = patch.subarray(starts[index], starts[index + 1] ?? patch.length)
    const patchPath = join(tempDirectory, `${layer.kind}-file-${index}.patch`)
    writeFileSync(patchPath, block, { mode: TEXT_FILE_MODE })
    return { ...record, patchPath, bytes: block.length,
      addedLines: record.added,
      deletedLines: record.deleted }
  })
}

function findStandardSources(root, changedFiles) {
  const tracked = splitNull(runGit(root, ['ls-files', '-z']))
  const standardNames = new Set([
    'AGENTS.md',
    'CODING_STANDARDS.md',
    'CONTRIBUTING.md',
  ])
  const candidates = tracked.filter((path) => standardNames.has(basename(path)))
  const ignored = ignoredPaths(root, candidates)
  return candidates
    .filter((standardPath) => !ignored.has(standardPath))
    .filter((standardPath) => {
      try {
        return lstatSync(resolve(root, standardPath)).isFile()
      } catch {
        return false
      }
    })
    .filter((standardPath) => {
      const directory =
        dirname(standardPath) === '.' ? '' : `${dirname(standardPath)}/`
      return changedFiles.some(
        (path) => path === standardPath || path.startsWith(directory),
      )
    })
    .sort()
}

function writeManifest(root, base, baseCommit, tempDirectory) {
  const layers = []
  if (baseCommit) {
    layers.push(collectTrackedLayer(root, 'committed', baseCommit, tempDirectory))
  }
  layers.push(collectTrackedLayer(root, 'staged', baseCommit, tempDirectory))
  layers.push(collectTrackedLayer(root, 'unstaged', baseCommit, tempDirectory))
  layers.push(collectUntrackedLayer(root, tempDirectory))

  const textFiles = unique(layers.flatMap((layer) => layer.textFiles)).sort()
  const binaryFiles = unique(layers.flatMap((layer) => layer.binaryFiles)).sort()
  const addedLines = layers.reduce((sum, layer) => sum + layer.addedLines, 0)
  const deletedLines = layers.reduce((sum, layer) => sum + layer.deletedLines, 0)
  const changedLines = addedLines + deletedLines
  const commits = baseCommit
    ? runGit(root, ['log', `${baseCommit}..HEAD`, '--oneline'], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
    : []
  const manifestPath = join(tempDirectory, 'manifest.json')
  const manifest = {
    version: 1,
    repositoryRoot: root,
    tempDirectory,
    mode: baseCommit ? 'fixed-point' : 'working-tree',
    base,
    baseCommit,
    commits,
    textFiles,
    textFileCount: textFiles.length,
    binaryFiles,
    addedLines,
    deletedLines,
    changedLines,
    sizeEligibleForLightReview: textFiles.length <= 2 && changedLines <= 50,
    standardSources: findStandardSources(root, textFiles),
    aiRulePaths: [],
    review_plan_required: true,
    ruleCatalog: discoverRuleCatalog(),
    layers: layers.map((layer) => ({
      kind: layer.kind,
      filePatches: layer.filePatches ?? snapshotFilePatches(layer, tempDirectory),
      patchPath: layer.patchPath,
      paths: layer.paths,
      addedLines: layer.addedLines,
      deletedLines: layer.deletedLines,
    })),
  }

  manifest.patch_units = indexPatchUnits(manifest.layers)

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: TEXT_FILE_MODE,
  })
  return manifestPath
}

let tempDirectory = null

try {
  const { base } = parseArgs(process.argv.slice(2))
  const root = runGit(process.cwd(), ['rev-parse', '--path-format=absolute', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()
  let baseCommit = null
  if (base) {
    baseCommit = runGit(
      root,
      ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
      { encoding: 'utf8' },
    ).trim()
  }

  tempDirectory = mkdtempSync(join(tmpdir(), 'code-review-'))
  chmodSync(tempDirectory, TEMP_DIR_MODE)
  const manifestPath = writeManifest(root, base, baseCommit, tempDirectory)
  process.stdout.write(`${manifestPath}\n`)
} catch (error) {
  if (tempDirectory) rmSync(tempDirectory, { force: true, recursive: true })
  fail(error instanceof Error ? error.message : String(error))
}
