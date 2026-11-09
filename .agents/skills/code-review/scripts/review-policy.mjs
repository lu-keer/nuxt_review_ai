import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { validateDependencyFiles } from './review-inputs.mjs'

export class PolicyError extends Error {
  name = 'PolicyError'
}

const MATERIALS_MAX_CHARS = 1024 * 1024

function readMaterial(path, label) {
  if (!existsSync(path) || !lstatSync(path).isFile()) return null
  const content = readFileSync(path, 'utf8')
  if (!content.trim()) return null
  return { label, content }
}

export function collectReviewMaterials(manifest, allowFiles, dependencies, patches = []) {
  const materials = []
  let total = 0
  const add = (item) => {
    if (!item) return
    total += item.content.length
    if (total > MATERIALS_MAX_CHARS) throw new PolicyError('审查材料超过输入限制，不能截断或省略')
    materials.push(item)
  }
  for (const file of allowFiles) {
    const material = readMaterial(file, `AI rule: ${basename(file)}`)
    if (!material) throw new PolicyError(`规则材料缺失或为空：${file}`)
    add(material)
  }
  const layers = Array.isArray(manifest.layers) ? manifest.layers : []
  for (const layer of layers) {
    if (!layer || typeof layer.patchPath !== 'string' || !layer.patchPath.trim()) continue
    const name = typeof layer.kind === 'string' && layer.kind.trim()
      ? `${layer.kind.trim()}.patch`
      : basename(layer.patchPath)
    if (!existsSync(layer.patchPath) || !lstatSync(layer.patchPath).isFile()) throw new PolicyError('patch 材料缺失')
    add(readMaterial(layer.patchPath, `patch: ${name}`))
  }
  for (const patch of patches) add(patch)
  for (const entry of dependencies) {
    const content = readFileSync(entry.absolute, 'utf8')
    add({ label: `dependency: ${entry.path}`, content })
  }
  return materials
}

export function loadReviewPolicy(manifestPath, skillDir, jobDir) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    throw new PolicyError('review_manifest 必须是非空字符串')
  }
  if (!isAbsolute(manifestPath)) throw new PolicyError(`review_manifest 必须是绝对路径：${manifestPath}`)
  const path = resolve(manifestPath)
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new PolicyError(`review_manifest 不是已存在的文件：${path}`)
  }
  if (typeof skillDir !== 'string' || !isAbsolute(skillDir)) {
    throw new PolicyError('skillDir 必须是绝对路径')
  }
  if (typeof jobDir !== 'string' || !isAbsolute(jobDir)) {
    throw new PolicyError('jobDir 必须是绝对路径')
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new PolicyError(`review_manifest 无法解析：${error.message}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PolicyError('review_manifest 必须是 JSON 对象')
  }
  if (manifest.review_plan_required === true) throw new PolicyError('此 manifest 需要批次规划，不能直接启动 worker')
  const reviewBatch = validateReviewBatch(manifest, skillDir)
  if (typeof manifest.repositoryRoot !== 'string' || !isAbsolute(manifest.repositoryRoot)) {
    throw new PolicyError('manifest.repositoryRoot 必须是绝对路径')
  }
  if (typeof manifest.tempDirectory !== 'string' || !isAbsolute(manifest.tempDirectory)) {
    throw new PolicyError('manifest.tempDirectory 必须是绝对路径')
  }
  if (!Array.isArray(manifest.aiRulePaths) || manifest.aiRulePaths.some((item) => typeof item !== 'string')) {
    throw new PolicyError('manifest.aiRulePaths 必须是字符串数组')
  }
  const allowFiles = []
  for (const relative of manifest.aiRulePaths) {
    if (!relative.trim() || isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      throw new PolicyError(`aiRulePaths 无效：${relative}`)
    }
    allowFiles.push(resolve(skillDir, relative))
  }
  let materials
  try {
    const dependencies = validateDependencyFiles(reviewBatch, manifest.repositoryRoot)
    materials = collectReviewMaterials(manifest, allowFiles, dependencies)
  }
  catch (error) { throw new PolicyError(error.message) }
  return {
    reviewBatch,
    ruleNames: manifest.aiRulePaths.map((path) => basename(path)),
    repositoryRoot: resolve(manifest.repositoryRoot),
    tempDirectory: resolve(manifest.tempDirectory),
    allowFiles,
    materials,
  }
}

function validateReviewBatch(manifest, skillDir) {
  const batch = manifest.review_batch
  if (batch == null) return null
  const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  const file = (value) => typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !/[\\:\x00-\x1f]/.test(value) && !value.split('/').some((part) => part === '..' || part === '.' || part === '')
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) || batch.schema_version !== 4 || !id(batch.run_id) || !id(batch.batch_id) || !['primary', 'integration'].includes(batch.kind) ||
      typeof batch.purpose !== 'string' || !batch.purpose.trim() || !Array.isArray(batch.files) || batch.files.length === 0 || batch.files.some((value) => !file(value)) || new Set(batch.files).size !== batch.files.length ||
      !Array.isArray(batch.depends_on) || batch.depends_on.some((value) => !id(value) || value === batch.batch_id) || new Set(batch.depends_on).size !== batch.depends_on.length ||
      (batch.kind === 'primary' ? batch.depends_on.length !== 0 : batch.depends_on.length === 0)) {
    throw new PolicyError('manifest.review_batch 元数据无效')
  }
  if (manifest.textFiles != null && (!Array.isArray(manifest.textFiles) || manifest.textFiles.length !== batch.files.length || batch.files.some((path) => !manifest.textFiles.includes(path)))) {
    throw new PolicyError('批次文件与 manifest.textFiles 不一致')
  }
  const prefix = 'references/ai_review_rules/'
  const rulesDir = resolve(skillDir, prefix)
  const discovered = new Set(readdirSync(rulesDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => prefix + entry.name))
  if (typeof batch.reason !== 'string' || !batch.reason.trim() || !discovered.has(batch.rule_path) || batch.review_type !== basename(batch.rule_path, '.md') ||
      !Array.isArray(manifest.aiRulePaths) || manifest.aiRulePaths.length !== 1 || manifest.aiRulePaths[0] !== batch.rule_path ||
      ['business_type', 'family', 'patch_units'].some(key => key in batch)) {
    throw new PolicyError('v4 批次必须对应单个已发现规则，review_type 与 rule_path 一致，不能声明业务或 hunk 分组')
  }
  if (batch.kind === 'integration' && (typeof batch.risk_focus !== 'string' || !batch.risk_focus.trim())) throw new PolicyError('整合批次需要 risk_focus')
  return structuredClone(batch)
}
