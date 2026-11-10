import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { contextFromEnvironment, isMain, readJson, summary, writeJson } from './common.mjs'

export const diagnosticLimits = { files: 20, bytesPerFile: 20 * 1024 * 1024, inventoryEntries: 10000 }
const terminalStates = new Set(['completed', 'errored', 'failed', 'interrupted', 'cancelled', 'shutdown', 'not_found'])
const taskTools = /^(?:(?:collaboration|functions)\.)?(?:spawn_agent|wait|wait_agent|close_agent|list_agents|send_message|interrupt_agent)$/
const identifier = value => typeof value === 'string' && (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) || /^\/root(?:\/[a-z0-9_-]+)+$/i.test(value))
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : 'other'
const identity = context => Object.fromEntries(['repository', 'pr', 'runId', 'runAttempt', 'baseSha', 'headSha', 'trustedSha', 'rulesHash'].map(key => [key, context[key]]))
const issue = (issues, code) => { if (!issues.includes(code)) issues.push(code) }
const count = (counts, name) => { name = token(name); counts[name] = (counts[name] ?? 0) + 1 }
const errorCode = error => /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : 'READ_ERROR'

// Enumerate names only, never read a config/auth file or follow a symlink.
function inventory(root, io) {
  const files = []
  const issues = []
  let entries = 0
  let missing = false
  function visit(path, relative = '', depth = 0) {
    if (++entries > diagnosticLimits.inventoryEntries || depth > 32) { issue(issues, 'inventory_limit'); return }
    const stat = io.lstatSync(path)
    if (stat.isSymbolicLink()) { issue(issues, 'symlink_skipped'); return }
    if (stat.isDirectory()) {
      for (const entry of io.readdirSync(path).sort()) {
        if (entries >= diagnosticLimits.inventoryEntries) { issue(issues, 'inventory_limit'); break }
        visit(join(path, entry), relative ? `${relative}/${entry}` : entry, depth + 1)
      }
    } else if (stat.isFile() && relative.endsWith('.jsonl')) files.push(relative)
  }
  try { visit(root) } catch (error) {
    if (error.code === 'ENOENT' && entries === 1) missing = true
    else issue(issues, `inventory_${errorCode(error)}`)
  }
  return { files: files.sort(), issues, missing }
}

export function captureBaseline({ context, sourceRoot, codexHome, io = fs }) {
  const sessionsRoot = join(resolve(codexHome), 'sessions')
  const scan = inventory(sessionsRoot, io)
  return { version: 1, context: identity(context), sourceRoot: resolve(sourceRoot), sessionsRoot,
    files: scan.files, issues: scan.issues, sessionsInitiallyMissing: scan.missing }
}

function readRecords(path, io) {
  const fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = io.fstatSync(fd)
    if (!stat.isFile()) throw new Error('Not a regular session file')
    const truncated = stat.size > diagnosticLimits.bytesPerFile
    const buffer = Buffer.alloc(Math.min(stat.size, diagnosticLimits.bytesPerFile))
    let offset = 0
    while (offset < buffer.length) {
      const bytes = io.readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (!bytes) break
      offset += bytes
    }
    const lines = buffer.subarray(0, offset).toString('utf8').split('\n')
    if (truncated) lines.pop() // Never interpret a partial line at the read boundary.
    const records = []
    let malformed = offset !== buffer.length
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (!record || Array.isArray(record) || typeof record !== 'object' || typeof record.type !== 'string') malformed = true
        else records.push(record)
      } catch { malformed = true }
    }
    return { records, truncated, malformed }
  } finally { io.closeSync(fd) }
}

// Only typed protocol records are inspected. Text, arguments and returned bodies
// are never copied into diagnostics or recursively interpreted as fake events.
function analyze(records, sessionId) {
  const result = { sessionId, eventTypes: Object.create(null), toolNames: Object.create(null), recordFields: Object.create(null),
    taskIds: [], taskToolCalls: 0, delegationReturns: 0, terminalRecords: 0, unrecognizedTaskEvents: 0 }
  const calls = new Map()
  const ids = new Set()
  function addId(value) { if (identifier(value)) ids.add(value) }
  function status(value, path) {
    const state = typeof value === 'string' ? value : value && typeof value === 'object' ? Object.keys(value)[0] : null
    if (terminalStates.has(state)) { result.terminalRecords++; count(result.recordFields, path) }
  }
  function fields(payload, prefix) {
    for (const key of ['agent_id', 'task_id', 'task_name', 'thread_id', 'new_thread_id', 'receiver_thread_id']) {
      if (identifier(payload[key])) { addId(payload[key]); count(result.recordFields, `${prefix}.${key}`) }
    }
    status(payload.status, `${prefix}.status`)
    const stateField = payload.statuses ? 'statuses' : 'agents_states'
    for (const [id, state] of Object.entries(payload[stateField] ?? {})) {
      if (identifier(id)) { addId(id); count(result.recordFields, `${prefix}.${stateField}.task_id`) }
      status(state?.status ?? state, `${prefix}.${stateField}.status`)
    }
  }
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    count(result.eventTypes, record.type)
    const payload = record.payload
    if (!payload || typeof payload !== 'object') continue
    if (['event_msg', 'response_item'].includes(record.type)) count(result.eventTypes, `${token(record.type)}.${token(payload.type)}`)
    if (record.type === 'event_msg' && ['collab_agent_spawn_end', 'collab_waiting_end', 'collab_close_end'].includes(payload.type)) {
      if (payload.type === 'collab_agent_spawn_end') result.delegationReturns++
      fields(payload, `event_msg.${payload.type}`)
    } else if (record.type === 'event_msg' && typeof payload.type === 'string' && payload.type.startsWith('collab_')) {
      // Begin/interaction events alone are not an observed return/terminal outlet.
      if (!['collab_agent_spawn_begin', 'collab_waiting_begin', 'collab_close_begin', 'collab_agent_interaction_begin', 'collab_agent_interaction_end'].includes(payload.type)) result.unrecognizedTaskEvents++
    }
    if (record.type !== 'response_item') continue
    if (['function_call', 'custom_tool_call'].includes(payload.type)) {
      count(result.toolNames, payload.name)
      if (taskTools.test(payload.name) && typeof payload.call_id === 'string') {
        calls.set(payload.call_id, payload.name)
        result.taskToolCalls++
      }
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(payload.type) && calls.has(payload.call_id)) {
      const tool = calls.get(payload.call_id)
      if (tool.endsWith('spawn_agent')) result.delegationReturns++
      let output = payload.output
      if (typeof output === 'string') { try { output = JSON.parse(output) } catch { output = null } }
      if (output && typeof output === 'object' && !Array.isArray(output)) fields(output, `${payload.type}.output`)
    }
  }
  result.taskIds = [...ids].sort()
  return result
}

export function collectDiagnostics({ baseline, context, sourceRoot, codexHome, codexOutcome = 'unknown', io = fs }) {
  const result = { version: 1, context: identity(context), sourceRoot: resolve(sourceRoot),
    codexOutcome: ['success', 'failure', 'cancelled', 'skipped'].includes(codexOutcome) ? codexOutcome : 'unknown',
    status: '诊断未完成', trustedEvidence: false, sessionsRoot: join(resolve(codexHome), 'sessions'),
    newFileCount: 0, checkedFileCount: 0, excludedOtherWorkspaces: 0, sessions: [], issues: [] }
  if (!baseline || JSON.stringify(baseline.context) !== JSON.stringify(result.context)
    || baseline.sourceRoot !== result.sourceRoot || baseline.sessionsRoot !== result.sessionsRoot
    || !Array.isArray(baseline.files) || !Array.isArray(baseline.issues)) {
    issue(result.issues, 'baseline_missing_or_mismatched'); return result
  }
  if (baseline.issues.length) { issue(result.issues, 'baseline_inventory_incomplete'); return result }
  const scan = inventory(result.sessionsRoot, io)
  result.issues.push(...scan.issues)
  if (scan.missing) { issue(result.issues, 'sessions_missing'); return result }
  const previous = new Set(baseline.files)
  const added = scan.files.filter(path => !previous.has(path))
  result.newFileCount = added.length
  if (added.length > diagnosticLimits.files) issue(result.issues, 'new_file_limit')
  if (!added.length) issue(result.issues, 'no_new_session_files')
  for (const relative of added.slice(0, diagnosticLimits.files)) {
    result.checkedFileCount++
    try {
      const { records, truncated, malformed } = readRecords(join(result.sessionsRoot, relative), io)
      if (truncated) issue(result.issues, 'file_size_limit')
      if (malformed) issue(result.issues, 'malformed_or_incomplete_jsonl')
      const metadata = records.filter(record => record?.type === 'session_meta')
      if (metadata.length !== 1 || typeof metadata[0].payload?.cwd !== 'string' || !identifier(metadata[0].payload?.id)) {
        issue(result.issues, 'session_metadata_missing_or_invalid'); continue
      }
      if (resolve(metadata[0].payload.cwd) !== result.sourceRoot) { result.excludedOtherWorkspaces++; continue }
      result.sessions.push(analyze(records, metadata[0].payload.id))
    } catch (error) { issue(result.issues, `session_${errorCode(error)}`) }
  }
  if (!result.sessions.length) issue(result.issues, 'no_associated_sessions')
  if (result.sessions.some(session => session.unrecognizedTaskEvents)) issue(result.issues, 'unrecognized_task_events')
  if (result.issues.length) return result
  const found = result.sessions.some(session => session.delegationReturns || session.taskIds.length || session.terminalRecords)
  if (!found && result.sessions.some(session => session.taskToolCalls)) { issue(result.issues, 'task_return_records_missing'); return result }
  result.status = found ? '发现候选记录' : '未发现任务记录'
  return result
}

if (isMain(import.meta.url)) {
  try {
    const output = process.env.REVIEW_OUTPUT
    fs.mkdirSync(output, { recursive: true })
    const options = { context: contextFromEnvironment(), sourceRoot: process.env.REVIEW_SOURCE_ROOT,
      codexHome: process.env.CODEX_HOME || join(homedir(), '.codex') }
    if (process.argv[2] === 'before') writeJson(join(output, 'diagnostic-baseline.json'), captureBaseline(options))
    else if (process.argv[2] === 'after') {
      let baseline = null
      try { baseline = readJson(join(output, 'diagnostic-baseline.json'), 4 * 1024 * 1024) } catch { /* Explicit incomplete result below. */ }
      const diagnostics = collectDiagnostics({ ...options, baseline, codexOutcome: process.env.REVIEW_CODEX_OUTCOME })
      writeJson(join(output, 'diagnostics.json'), diagnostics)
      summary(`### 宿主证据出口诊断\n\n- 结果：${diagnostics.status}\n- Codex 步骤：${diagnostics.codexOutcome}\n- 新会话文件：${diagnostics.newFileCount}；检查：${diagnostics.checkedFileCount}；关联会话：${diagnostics.sessions.length}\n- 原因：${diagnostics.issues.join(', ') || '无'}\n- 仅作出口诊断，不作为可信证据，不改变审查结论。详情见原始 Artifact 的 diagnostics.json。`)
    } else throw new Error('Expected before or after')
  } catch (error) {
    // Never print exception messages, which may contain file contents or paths.
    console.error(`宿主出口诊断失败：${errorCode(error)}`)
    summary(`宿主证据出口：诊断未完成（${errorCode(error)}）；现有报告发布继续执行。`)
    process.exitCode = 1
  }
}
