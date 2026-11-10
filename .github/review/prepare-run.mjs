import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { contextFromEnvironment, isMain, readJson, sha256, writeJson } from './common.mjs'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} 失败`)
  return result.stdout.trim()
}

export function checkIntegrity(root, context) {
  if (git(root, ['rev-parse', 'HEAD']) !== context.headSha) throw new Error('工作区 HEAD 与审查版本不符')
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('审查工作区发生修改')
}

export function prepareSnapshot(root, trustedRoot, context) {
  checkIntegrity(root, context)
  const helper = join(trustedRoot, '.agents/skills/code-review/scripts/build-review-manifest.mjs')
  const result = spawnSync(process.execPath, [helper, '--base', context.baseSha], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error(`快照失败：${helper}\ncwd=${root}\n${result.error?.message ?? result.stderr}`)
  const manifestPath = result.stdout.trim()
  const manifest = readJson(manifestPath, 32 * 1024 * 1024)
  if (realpathSync.native(manifest.repositoryRoot) !== realpathSync.native(root) || manifest.baseCommit !== context.baseSha) {
    rmSync(manifest.tempDirectory, { recursive: true, force: true })
    throw new Error(`快照仓库或 base 不匹配：${JSON.stringify({ actualRoot: realpathSync(manifest.repositoryRoot), expectedRoot: realpathSync(root), actualBase: manifest.baseCommit, expectedBase: context.baseSha })}`)
  }
  const snapshotId = sha256(JSON.stringify({
    base: context.baseSha, head: context.headSha, textFiles: manifest.textFiles,
    patches: manifest.layers.map(layer => [layer.kind, sha256(readFileSync(layer.patchPath))]),
  }))
  const snapshot = { manifestPath, snapshotId, textFileCount: manifest.textFileCount, textFiles: manifest.textFiles }
  return { snapshot, tempDirectory: manifest.tempDirectory }
}

if (isMain(import.meta.url)) {
  try {
    const output = process.env.REVIEW_OUTPUT
    mkdirSync(output, { recursive: true })
    const context = contextFromEnvironment()
    if (process.argv[2] === 'integrity') checkIntegrity(process.env.REVIEW_SOURCE_ROOT, context)
    else {
      writeJson(join(output, 'context.json'), context)
      if (process.argv[2] === 'snapshot') {
        const { snapshot, tempDirectory } = prepareSnapshot(process.env.REVIEW_SOURCE_ROOT, process.env.REVIEW_TRUSTED_ROOT, context)
        writeJson(join(output, 'snapshot.json'), snapshot)
        if (process.env.GITHUB_OUTPUT) {
          const { appendFileSync } = await import('node:fs')
          appendFileSync(process.env.GITHUB_OUTPUT, `text-count=${snapshot.textFileCount}\n`)
        }
        if (!snapshot.textFileCount) rmSync(tempDirectory, { recursive: true, force: true })
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
