import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function isDocumentationPath(path) {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  return normalized.endsWith('.md') || ['docs', '.docs'].some(dir => normalized === dir || normalized.startsWith(`${dir}/`))
}

export function isTestPath(path) {
  return path.replaceAll('\\', '/').toLowerCase().endsWith('.test.mjs')
}

export function isReviewExcludedPath(path) {
  return isDocumentationPath(path) || isTestPath(path)
}

export function validateDependencyFiles(batch, repositoryRoot) {
  const paths = batch?.dependency_files === undefined ? [] : batch.dependency_files
  if (!Array.isArray(paths) || paths.length > 6 || new Set(paths).size !== paths.length ||
      (batch?.kind !== 'integration' && batch?.dependency_files !== undefined)) {
    throw new Error('dependency_files 仅可用于 integration，最多 6 个唯一文件')
  }
  if (!paths.length) return []
  const root = realpathSync(repositoryRoot)
  const entries = paths.map(path => {
    if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => ['', '.', '..'].includes(part))) {
      throw new Error('dependency_files 必须是仓库内规范相对路径')
    }
    const absolute = realpathSync(resolve(root, path))
    const rel = relative(root, absolute)
    if (!rel || isAbsolute(rel) || rel.split(sep).includes('..') || !statSync(absolute).isFile()) {
      throw new Error(`dependency_files 越界或不是文件：${path}`)
    }
    const canonical = rel.split(sep).join('/')
    if (isReviewExcludedPath(path) || isReviewExcludedPath(canonical)) {
      throw new Error(`dependency_files 不允许文档或测试文件：${path}`)
    }
    return { path, canonical, absolute }
  })
  if (new Set(entries.map(entry => entry.absolute)).size !== entries.length) throw new Error('dependency_files 重复指向同一文件')
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' })
  if (git.error) throw git.error
  if (git.status === 0 && git.stdout.trim() === 'true') {
    const ignored = spawnSync('git', ['check-ignore', '--stdin', '-z', '--no-index'], {
      cwd: root, encoding: 'utf8', input: entries.flatMap(entry => [entry.path, entry.canonical]).join('\0') + '\0',
    })
    if (ignored.error) throw ignored.error
    if (![0, 1].includes(ignored.status)) throw new Error('dependency_files 无法验证 ignored 路径')
    if (ignored.stdout) throw new Error('dependency_files 不允许 ignored 文件')
  } else if (git.status !== 128) throw new Error('dependency_files 无法验证仓库状态')
  return entries
}
