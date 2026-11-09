#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { discoverRuleCatalog, skillDirectory } from './rule-catalog.mjs'
import { indexPatchUnits } from './patch-units.mjs'
import { validateDependencyFiles } from './review-inputs.mjs'
import { collectReviewMaterials } from './review-policy.mjs'

const REVIEW_TIMEOUT_MS = 600000
const REVIEW_RUN_TIMEOUT_MS = 1800000
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const ALL_RULES_REASON = '固定全规则审查'

export function buildAllRulesPlan(textFiles) {
  if (!Array.isArray(textFiles) || !textFiles.length) throw new Error('manifest 缺少文件快照')
  const catalog = discoverRuleCatalog()
  return {
    schema_version: 4,
    all_rules: true,
    skipped_rules: [],
    integration: [],
    primary: catalog.map(rule => ({
      id: basename(rule.path, '.md'),
      rule_path: rule.path,
      reason: ALL_RULES_REASON,
      purpose: rule.applicability,
      files: [...textFiles],
    })),
  }
}

export function buildReviewBatches(manifestPath, planPath = null, previousIndexPath = null) {
  const parent = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!planPath && previousIndexPath) throw new Error('追加第二轮需要 --plan')
  const plan = planPath ? JSON.parse(readFileSync(planPath, 'utf8')) : buildAllRulesPlan(parent.textFiles)
  if (plan.schema_version !== undefined && plan.schema_version !== 4) throw new Error('不支持的计划 schema_version')
  if (!parent.review_plan_required || !Array.isArray(parent.textFiles) || !Array.isArray(parent.layers) || !parent.layers.every(layer => Array.isArray(layer.filePatches))) throw new Error('manifest 缺少文件快照')
  if (!Array.isArray(plan.primary) || !Array.isArray(plan.integration) || !Array.isArray(plan.skipped_rules)) throw new Error('计划需要 primary、integration 和根级 skipped_rules 数组')
  const files = new Set(parent.textFiles)
  const blocks = parent.layers.flatMap(layer => layer.filePatches)
  if (files.size !== parent.textFiles.length || !files.size || new Set(blocks.map(block => block.path)).size !== files.size || [...files].some(file => !blocks.some(block => block.path === file))) throw new Error('patch 快照未覆盖全部文件')
  const canonical = new Map()
  for (const block of blocks) for (const path of block.paths ?? []) {
    if (!files.has(path)) {
      if (canonical.has(path) && canonical.get(path) !== block.path) throw new Error('重命名路径映射不明确')
      canonical.set(path, block.path)
    }
  }
  const logicalPath = path => files.has(path) ? path : canonical.get(path)
  for (const block of blocks) {
    if (!Array.isArray(block.paths) || !block.paths.length || block.paths.some(path => !files.has(logicalPath(path)))) throw new Error('patch 文件映射无效')
    if (readFileSync(block.patchPath).length !== block.bytes) throw new Error('patch 快照字节数不一致')
  }
  for (const layer of parent.layers) {
    if (!Buffer.concat(layer.filePatches.map(block => readFileSync(block.patchPath))).equals(readFileSync(layer.patchPath))) throw new Error('完整 layer patch 与文件块不一致')
  }
  if (parent.patch_units != null && JSON.stringify(parent.patch_units) !== JSON.stringify(indexPatchUnits(parent.layers))) throw new Error('patch_units 索引与快照不一致')

  const catalog = discoverRuleCatalog()
  const known = new Set(catalog.map(rule => rule.path))
  const choices = [...plan.primary.map(batch => ({ path: batch?.rule_path, reason: batch?.reason })), ...plan.skipped_rules]
  if (choices.length !== known.size || new Set(choices.map(rule => rule?.path)).size !== known.size || choices.some(rule => !known.has(rule?.path) || !nonempty(rule.reason))) throw new Error('选中与跳过规则必须完整说明，每个规则恰好一次')
  if (plan.all_rules != null && typeof plan.all_rules !== 'boolean') throw new Error('all_rules 必须为布尔值')
  if (plan.all_rules === true && (plan.skipped_rules.length || plan.primary.length !== known.size || plan.primary.some(batch => !Array.isArray(batch.files) || batch.files.length !== files.size || [...files].some(file => !batch.files.includes(file))))) throw new Error('all_rules 计划必须运行全部规则并覆盖全部可审查文件')
  const primaryByRule = new Map(plan.primary.map(batch => [batch.rule_path, batch]))
  const all = [...plan.primary.map(batch => ({ ...batch, kind: 'primary' })), ...plan.integration.map(batch => ({ ...batch, kind: 'integration' }))]
  const ids = new Set()
  for (const batch of all) {
    if (!validId(batch.id) || ids.has(batch.id)) throw new Error('批次编号无效或重复')
    ids.add(batch.id)
    if (!known.has(batch.rule_path) || !nonempty(batch.reason) || !nonempty(batch.purpose)) throw new Error('规则路径、用途或选择理由无效')
    if (['business_type', 'family', 'review_type', 'rules', 'skipped_rules', 'patch_units', 'oversize_reason'].some(key => key in batch)) throw new Error('新计划只按 rule_path 分组，不接受业务、多规则或 hunk 选择')
    if (!Array.isArray(batch.files) || !batch.files.length || new Set(batch.files).size !== batch.files.length || batch.files.some(file => !files.has(file))) throw new Error('批次文件无效或重复')
    const selected = new Set(batch.files)
    if (blocks.some(block => block.paths.some(path => selected.has(logicalPath(path))) && block.paths.some(path => !selected.has(logicalPath(path))))) throw new Error('重命名关联文件必须完整选择')
    const dependencies = batch.dependsOn ?? []
    if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length || dependencies.some(dep => !plan.primary.some(primary => primary.id === dep)) || (batch.kind === 'primary' && dependencies.length)) throw new Error('批次依赖无效')
    if (batch.kind === 'integration') {
      const primary = primaryByRule.get(batch.rule_path)
      if (!primary || !dependencies.includes(primary.id) || batch.files.some(file => !primary.files.includes(file))) throw new Error('第二轮必须依赖该规则首轮批次，并只选择其已审文件')
      if (!nonempty(batch.risk_focus)) throw new Error('第二轮需要具体 risk_focus')
    }
  }

  // Preflight every prompt before creating child materials; never truncate input.
  const prepared = all.map(batch => {
    const selected = new Set(batch.files)
    const layers = parent.layers.map(layer => {
      const filePatches = layer.filePatches.filter(block => block.paths.some(path => selected.has(logicalPath(path))))
      return { ...layer, filePatches, paths: [...new Set(filePatches.flatMap(block => block.paths))],
        addedLines: filePatches.reduce((sum, block) => sum + block.addedLines, 0),
        deletedLines: filePatches.reduce((sum, block) => sum + block.deletedLines, 0) }
    })
    const dependencies = validateDependencyFiles(batch, parent.repositoryRoot)
    const patches = layers.map(layer => ({ label: `patch: ${layer.kind}.patch`, content: Buffer.concat(layer.filePatches.map(block => readFileSync(block.patchPath))).toString('utf8') }))
    collectReviewMaterials({ layers: [] }, [resolve(skillDirectory, batch.rule_path)], dependencies, patches)
    return { batch, layers, patchBytes: layers.flatMap(layer => layer.filePatches).reduce((sum, block) => sum + block.bytes, 0) }
  })
  const previous = previousIndexPath ? JSON.parse(readFileSync(previousIndexPath, 'utf8')) : null
  if (previous) {
    if (previous.schema_version !== 4 || !validId(previous.run_id) || previous.parentManifestPath !== resolve(manifestPath) ||
        previous.tempDirectory !== parent.tempDirectory || !Array.isArray(previous.batches)) throw new Error('追加索引与父 manifest 不匹配')
    const primaries = previous.batches.filter(batch => batch.kind === 'primary')
    if (primaries.length !== plan.primary.length) throw new Error('追加第二轮不能改变首轮计划')
    for (const { batch, layers } of prepared.filter(item => item.batch.kind === 'primary')) {
      const prior = primaries.find(item => item.batch_id === batch.id)
      if (!prior) throw new Error('追加第二轮不能改变首轮计划')
      const child = JSON.parse(readFileSync(prior.manifestPath, 'utf8'))
      const expected = { rule_path: batch.rule_path, reason: batch.reason, purpose: batch.purpose, files: batch.files }
      if (child.review_batch?.run_id !== previous.run_id || child.review_batch?.batch_id !== batch.id ||
          Object.keys(expected).some(key => JSON.stringify(child.review_batch[key]) !== JSON.stringify(expected[key])) ||
          child.layers.length !== layers.length || layers.some((layer, i) => layer.kind !== child.layers[i].kind ||
            !Buffer.concat(layer.filePatches.map(block => readFileSync(block.patchPath))).equals(readFileSync(child.layers[i].patchPath)))) {
        throw new Error('追加第二轮不能改变首轮计划或快照')
      }
    }
    if (!plan.integration.length || plan.integration.some(batch => previous.batches.some(prior => prior.batch_id === batch.id))) {
      throw new Error('追加第二轮需要新的唯一批次 ID')
    }
  }
  const runId = previous?.run_id ?? randomUUID()
  const directory = join(parent.tempDirectory, `batches-${randomUUID()}`)
  mkdirSync(directory, { mode: 0o700 })
  const batches = prepared.filter(({ batch }) => !previous || batch.kind === 'integration').map(({ batch, layers, patchBytes }) => {
    for (const layer of layers) {
      layer.patchPath = join(directory, `${batch.id}-${layer.kind}.patch`)
      writeFileSync(layer.patchPath, Buffer.concat(layer.filePatches.map(block => readFileSync(block.patchPath))), { mode: 0o600 })
    }
    const reviewBatch = { schema_version: 4, run_id: runId, batch_id: batch.id, kind: batch.kind,
      rule_path: batch.rule_path, review_type: basename(batch.rule_path, '.md'), reason: batch.reason,
      purpose: batch.purpose, files: batch.files, depends_on: batch.dependsOn ?? [], risk_focus: batch.kind === 'integration' ? batch.risk_focus : null,
      ...(batch.kind === 'integration' ? { dependency_files: batch.dependency_files ?? [] } : {}) }
    const addedLines = layers.reduce((sum, layer) => sum + layer.addedLines, 0)
    const deletedLines = layers.reduce((sum, layer) => sum + layer.deletedLines, 0)
    const child = { ...parent, review_plan_required: false, review_batch: reviewBatch,
      aiRulePaths: [batch.rule_path], ruleSelection: { selected: [{ path: batch.rule_path, reason: batch.reason }] },
      textFiles: batch.files, textFileCount: batch.files.length, binaryFiles: [], addedLines, deletedLines,
      changedLines: addedLines + deletedLines, sizeEligibleForLightReview: batch.files.length <= 2 && addedLines + deletedLines <= 50, layers }
    delete child.patch_units
    const childPath = join(directory, `${batch.id}.json`)
    writeFileSync(childPath, JSON.stringify(child, null, 2) + '\n', { mode: 0o600 })
    return { ...reviewBatch, optional: batch.kind === 'integration', activation: batch.kind === 'integration' ? 'confirmed_risk_by_main' : 'required', manifestPath: childPath, patch_bytes: patchBytes }
  })
  const indexPath = join(directory, 'index.json')
  writeFileSync(indexPath, JSON.stringify({ schema_version: 4, run_id: runId, parentManifestPath: resolve(manifestPath),
    tempDirectory: parent.tempDirectory, max_concurrency: plan.primary.length, review_timeout_ms: REVIEW_TIMEOUT_MS, run_timeout_ms: REVIEW_RUN_TIMEOUT_MS,
    worker_tool_limit: 0, integration_dependency_inline_limit: 6, primary_count: plan.primary.length,
    skipped_rules: plan.skipped_rules, batches: [...(previous?.batches ?? []), ...batches] }, null, 2) + '\n', { mode: 0o600 })
  return indexPath
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    let manifestPath = null, planPath = null, indexPath = null
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1]
      if (!value) throw new Error('用法：build-review-batches.mjs --manifest <path> [--plan <path>] [--index <已有索引path>]')
      if (flag === '--manifest') manifestPath = value
      else if (flag === '--plan') planPath = value
      else if (flag === '--index') indexPath = value
      else throw new Error('用法：build-review-batches.mjs --manifest <path> [--plan <path>] [--index <已有索引path>]')
    }
    if (!manifestPath || (indexPath && !planPath)) throw new Error('用法：build-review-batches.mjs --manifest <path> [--plan <path>] [--index <已有索引path>]')
    process.stdout.write(`${buildReviewBatches(manifestPath, planPath, indexPath)}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
