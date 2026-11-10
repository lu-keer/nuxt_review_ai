import { createHash } from 'node:crypto'
import { appendFileSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const directory = dirname(fileURLToPath(import.meta.url))
export const rules = ['standards', 'architect', 'devops', 'product_contract', 'runtime_performance', 'security']
export const maxReportBytes = 1024 * 1024
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const isMain = url => process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href
export const readJson = (path, limit = maxReportBytes) => {
  if (lstatSync(path).size > limit) throw new Error(`文件过大：${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}
export const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
export function summary(message) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
}

// Hash both names and bytes, in a locale-independent order. Reject symlinks.
export function rulesHash(root) {
  const paths = []
  function visit(relative) {
    const path = join(root, relative)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`受信任材料不能是符号链接：${relative}`)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(`${relative}/${entry}`)
    } else if (stat.isFile()) paths.push(relative)
    else throw new Error(`不支持的受信任材料：${relative}`)
  }
  for (const path of ['AGENTS.md', '.agents/skills/code-review', '.github/codex', '.github/review', '.github/workflows/ai-review.yml']) visit(path)
  const hash = createHash('sha256')
  for (const path of paths.sort()) {
    const bytes = readFileSync(join(root, path))
    hash.update(`${path}\0${bytes.length}\0`).update(bytes)
  }
  return hash.digest('hex')
}

export function contextFromEnvironment(env = process.env) {
  const { REVIEW_REPOSITORY: repository, REVIEW_BASE_SHA: baseSha, REVIEW_HEAD_SHA: headSha,
    REVIEW_TRUSTED_SHA: trustedSha, REVIEW_TRUSTED_ROOT: trustedRoot } = env
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('仓库身份无效')
  for (const sha of [baseSha, headSha, trustedSha]) if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('审查 SHA 无效')
  const pr = Number(env.REVIEW_PR_NUMBER)
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('PR 编号无效')
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) if (!/^\d+$/.test(env[key] ?? '')) throw new Error(`${key} 无效`)
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com'
  if (new URL(server).protocol !== 'https:') throw new Error('GitHub 服务地址无效')
  return {
    schemaVersion: 1, repository, pr, baseSha, headSha, trustedSha,
    rulesHash: rulesHash(trustedRoot), runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    runUrl: `${server}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
    model: 'gpt-6.1-sol',
  }
}
