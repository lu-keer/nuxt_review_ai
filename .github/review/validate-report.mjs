import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { directory, rules } from './common.mjs'

const schema = JSON.parse(readFileSync(join(directory, 'report.schema.json'), 'utf8'))

// This schema deliberately uses only this small, tested subset of JSON Schema.
// Reject unknown schema keywords so a future schema extension cannot fail open.
export function validateSchema(value, definition = schema, path = '$') {
  if (definition.$ref) return validateSchema(value, schema.$defs[definition.$ref.split('/').at(-1)], path)
  const supported = new Set(['$schema', '$defs', 'type', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minimum', 'minLength', 'maxLength'])
  for (const key of Object.keys(definition)) if (!supported.has(key)) throw new Error(`不支持的 schema 关键字：${key}`)
  const types = Array.isArray(definition.type) ? definition.type : [definition.type]
  const validType = types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type)
  if (!validType) throw new Error(`${path} 类型无效`)
  if (definition.enum && !definition.enum.includes(value)) throw new Error(`${path} 枚举无效`)
  if (value === null) return
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of definition.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} 缺失`)
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(definition.properties ?? {}, key)) {
        if (definition.additionalProperties === false) throw new Error(`${path}.${key} 不允许`)
      } else validateSchema(entry, definition.properties[key], `${path}.${key}`)
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (definition.minItems ?? 0) || value.length > (definition.maxItems ?? Infinity)) throw new Error(`${path} 数量无效`)
    value.forEach((entry, index) => validateSchema(entry, definition.items, `${path}[${index}]`))
  }
  if (typeof value === 'string' && (value.length < (definition.minLength ?? 0) || value.length > (definition.maxLength ?? Infinity))) throw new Error(`${path} 长度无效`)
  if (typeof value === 'number' && value < (definition.minimum ?? -Infinity)) throw new Error(`${path} 数值无效`)
}

export const scopeOf = snapshot => ({ snapshotId: snapshot.snapshotId, textFileCount: snapshot.textFileCount, textFiles: snapshot.textFiles })
export const rulePath = rule => rule === 'standards' ? 'references/standards.md' : `references/ai_review_rules/${rule}.md`

export function failureReport(context, snapshot, reason) {
  return {
    context, scope: snapshot ? scopeOf(snapshot) : null,
    tasks: rules.map(rule => ({ rule, phase: 'primary', predecessorTaskId: null, rulePath: rulePath(rule), taskId: null, snapshotId: snapshot?.snapshotId ?? null,
      modelInherited: false, status: 'unknown', output: null, durationMs: null, reason })),
    findings: [], mergedCount: 0, discardedCount: 0, failureReasons: [reason],
    status: '未完成', conclusion: '未通过', evidence: [],
  }
}

export function noReviewReport(context, snapshot) {
  const report = failureReport(context, snapshot, '按受信任 Skill 确认没有可审查文本变更')
  report.tasks.forEach(task => { task.status = 'not_started' })
  return { ...report, status: '无需审查', conclusion: '通过', failureReasons: [] }
}

export function validateReport(raw, context, snapshot, evidence) {
  validateSchema(raw)
  for (const [key, expected] of Object.entries(context)) if (raw.context[key] !== expected) throw new Error(`报告 context.${key} 不匹配`)
  if (!isDeepStrictEqual(raw.scope, scopeOf(snapshot))) throw new Error('报告审查范围不匹配')
  if (!snapshot.textFileCount) {
    if (evidence.length || raw.tasks.some(task => task.taskId) || raw.findings.length) throw new Error('无需审查时出现任务或问题')
    return noReviewReport(context, snapshot)
  }
  const failures = [...raw.failureReasons]
  const seenIds = new Set()
  for (const rule of rules) {
    if (raw.tasks.filter(task => task.rule === rule && task.phase === 'primary').length !== 1) throw new Error(`${rule} 必须有且仅有一个首轮任务`)
  }
  const tasks = raw.tasks.map(entry => {
    const task = { ...entry, durationMs: null }
    const rule = task.rule
    // The pinned host JSONL has no actual worker duration. Do not accept model estimates.
    const host = evidence.find(entry => entry.taskId === task.taskId && entry.rule === rule)
    const independent = task.taskId && !seenIds.has(task.taskId)
    if (task.taskId) seenIds.add(task.taskId)
    const meaningful = typeof host?.output === 'string' && (host.output.trim() === 'NO_FINDINGS'
      || (/\b(Critical|Major|Minor)\b/.test(host.output) && snapshot.textFiles.some(file => host.output.includes(file))))
    const valid = independent && host && host.status === 'completed' && meaningful
      && task.output === host.output && task.status === 'completed' && task.modelInherited
      && task.snapshotId === snapshot.snapshotId && task.rulePath === rulePath(rule)
    if (!valid) {
      task.status = task.status === 'completed' ? 'invalid_output' : task.status
      task.reason = `${rule} 缺少独立身份、匹配的宿主完成证据或有效输出`
      failures.push(task.reason)
    } else {
      task.reason = '真实 worker 耗时不可用；模型继承为本次委派要求，JSONL 未提供独立模型字段'
    }
    return task
  })
  for (const task of tasks) {
    const predecessor = tasks.find(entry => entry.taskId && entry.taskId === task.predecessorTaskId && entry.rule === task.rule && entry.phase === 'primary')
    if (task.phase === 'primary' ? task.predecessorTaskId !== null : !predecessor || predecessor.status !== 'completed') {
      task.status = 'invalid_output'
      failures.push(`${task.rule} 核实任务的前置身份或有效终态不符`)
    }
  }
  if (evidence.some(entry => !tasks.some(task => task.taskId === entry.taskId))) failures.push('宿主存在报告未记录的任务')
  for (const finding of raw.findings) {
    if (!snapshot.textFiles.includes(finding.file) || /[\x00-\x1f]/.test(finding.file)) throw new Error('finding 不在可审查范围')
    for (const id of finding.sourceTaskIds) {
      const host = evidence.find(entry => entry.taskId === id)
      if (!host?.output || host.output.trim() === 'NO_FINDINGS' || !host.output.includes(finding.file) || !host.output.includes(finding.code)) throw new Error('finding 缺少对应宿主输出证据')
    }
  }
  for (const task of tasks) {
    if (task.status !== 'completed' || task.output?.trim() === 'NO_FINDINGS') continue
    if (!raw.findings.some(finding => finding.sourceTaskIds.includes(task.taskId)) && raw.discardedCount === 0 && raw.mergedCount === 0) {
      task.status = 'invalid_output'
      failures.push(`${task.rule} 输出不是 NO_FINDINGS，且没有核实或剔除记录`)
    }
  }
  const completed = failures.length === 0 && tasks.every(task => task.status === 'completed')
  const blocked = raw.findings.some(finding => ['Critical', 'Major'].includes(finding.severity))
  return { ...raw, context, scope: scopeOf(snapshot), tasks, failureReasons: failures,
    status: completed ? '已完成' : '未完成', conclusion: completed && !blocked ? '通过' : '未通过', evidence }
}
