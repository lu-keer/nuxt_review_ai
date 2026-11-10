import assert from 'node:assert/strict'
import * as diagnosticFs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { contextFromEnvironment, maxReportBytes, readJson, rules, rulesHash, writeJson } from './common.mjs'
import { captureBaseline, collectDiagnostics, diagnosticLimits } from './diagnose-host.mjs'
import { extractEvidence } from './evidence.mjs'
import { finalize } from './finalize-report.mjs'
import { allPages, githubClient } from './github.mjs'
import { prepareSnapshot } from './prepare-run.mjs'
import { marker, publish } from './publish-report.mjs'
import { renderRegion, renderReport, updateBody } from './render-report.mjs'
import { failureReport, noReviewReport, rulePath, scopeOf, validateReport, validateSchema } from './validate-report.mjs'

const trustedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const context = { schemaVersion: 1, repository: 'owner/repo', pr: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
  trustedSha: 'a'.repeat(40), rulesHash: 'c'.repeat(64), runId: '10', runAttempt: '1',
  runUrl: 'https://github.com/owner/repo/actions/runs/10', model: 'gpt-6.1-sol' }
const snapshot = { manifestPath: '/tmp/shared/manifest.json', snapshotId: 'd'.repeat(64), textFileCount: 1, textFiles: ['src/a.js'] }

function fixture() {
  const tasks = rules.map(rule => ({ rule, phase: 'primary', predecessorTaskId: null, rulePath: rulePath(rule), taskId: `id-${rule}`, snapshotId: snapshot.snapshotId,
    modelInherited: true, status: 'completed', output: 'NO_FINDINGS', durationMs: null, reason: null }))
  const raw = { context: structuredClone(context), scope: scopeOf(snapshot), tasks, findings: [], mergedCount: 0, discardedCount: 0, failureReasons: [] }
  const evidence = tasks.map(task => ({ rule: task.rule, taskId: task.taskId, status: 'completed', output: task.output, spawnEventId: 's', terminalEventId: 'w' }))
  return { raw, evidence }
}
function valid() { const { raw, evidence } = fixture(); return validateReport(raw, context, snapshot, evidence) }
function majorFixture() {
  const f = fixture()
  const output = 'Major src/a.js:1 const bad = true; 正常请求发生错误'
  f.raw.tasks[0].output = output
  f.evidence[0].output = output
  f.raw.findings.push({ severity: 'Major', title: '错误结果', file: 'src/a.js', line: 1, code: 'const bad = true;', trigger: '正常请求', impact: '返回错误结果', evidence: '变更直接返回错误值', sourceTaskIds: ['id-standards'] })
  return f
}

test('six host-confirmed tasks pass, without inventing duration', () => {
  const { raw, evidence } = fixture()
  raw.tasks[0].durationMs = 1234
  const report = validateReport(raw, context, snapshot, evidence)
  assert.equal(report.status, '已完成')
  assert.equal(report.conclusion, '通过')
  assert.equal(report.tasks[0].durationMs, null)
})
test('context and scope are checked against workflow values', () => {
  const { raw, evidence } = fixture()
  raw.context.headSha = context.baseSha
  assert.throws(() => validateReport(raw, context, snapshot, evidence), /不匹配/)
  raw.context.headSha = context.headSha
  raw.scope.textFiles = ['another.js']
  assert.throws(() => validateReport(raw, context, snapshot, evidence), /范围/)
})
test('scope property ordering does not change its meaning', () => {
  const { raw, evidence } = fixture()
  raw.scope = { textFiles: snapshot.textFiles, snapshotId: snapshot.snapshotId, textFileCount: 1 }
  assert.equal(validateReport(raw, context, snapshot, evidence).status, '已完成')
})
for (const state of ['failed', 'timed_out', 'cancelled', 'not_started', 'unknown', 'invalid_output']) {
  test(`${state} remains incomplete and keeps verified findings`, () => {
    const { raw, evidence } = majorFixture()
    raw.tasks[1].status = state
    const report = validateReport(raw, context, snapshot, evidence)
    assert.equal(report.status, '未完成')
    assert.equal(report.findings.length, 1)
    assert.equal(report.conclusion, '未通过')
  })
}
test('missing or reused identities and model claims cannot replace host evidence', () => {
  for (const mutate of [
    f => { f.raw.tasks[0].taskId = null },
    f => { f.raw.tasks[1].taskId = f.raw.tasks[0].taskId },
    f => { f.evidence.length = 0 },
    f => { f.raw.tasks[0].modelInherited = false },
    f => { f.raw.tasks[0].output = 'PASS' },
    f => { f.evidence[0].status = 'unknown' },
  ]) {
    const f = fixture(); mutate(f)
    assert.equal(validateReport(f.raw, context, snapshot, f.evidence).status, '未完成')
  }
})
test('garbage output cannot pass by claiming discarded candidates', () => {
  const { raw, evidence } = fixture()
  raw.tasks[0].output = evidence[0].output = 'hello'
  raw.discardedCount = 1
  assert.equal(validateReport(raw, context, snapshot, evidence).status, '未完成')
})
test('Major blocks conclusion but not completed state; Minor passes', () => {
  const { raw, evidence } = majorFixture()
  const report = validateReport(raw, context, snapshot, evidence)
  assert.equal(report.status, '已完成')
  assert.equal(report.conclusion, '未通过')
  raw.findings[0].severity = 'Minor'
  assert.equal(validateReport(raw, context, snapshot, evidence).conclusion, '通过')
})
test('out-of-scope findings and fabricated sources are rejected', () => {
  const { raw, evidence } = majorFixture()
  raw.findings[0].file = 'docs/x.md'
  assert.throws(() => validateReport(raw, context, snapshot, evidence), /范围/)
  raw.findings[0].file = 'src/a.js'
  raw.findings[0].sourceTaskIds = ['invented']
  assert.throws(() => validateReport(raw, context, snapshot, evidence), /宿主输出/)
})
test('primary tasks cannot be omitted or duplicated', () => {
  const { raw, evidence } = fixture()
  raw.tasks.pop()
  assert.throws(() => validateReport(raw, context, snapshot, evidence), /首轮任务/)
})
test('verification task cannot erase a failed predecessor', () => {
  const { raw, evidence } = fixture()
  raw.tasks[0].status = 'failed'
  raw.tasks.push({ ...raw.tasks[0], phase: 'verification', predecessorTaskId: raw.tasks[0].taskId, taskId: 'verify-id', status: 'completed' })
  evidence.push({ ...evidence[0], taskId: 'verify-id' })
  const report = validateReport(raw, context, snapshot, evidence)
  assert.equal(report.status, '未完成')
  assert.equal(report.tasks.at(-1).status, 'invalid_output')
})
test('schema rejects missing fields, unexpected keys and bad types', () => {
  for (const mutate of [raw => { delete raw.tasks }, raw => { raw.pass = true }, raw => { raw.tasks[0].durationMs = -1 }, raw => { raw.findings = 'none' }]) {
    const { raw } = fixture(); mutate(raw)
    assert.throws(() => validateSchema(raw))
  }
})

function hostLog(tasks = fixture().raw.tasks, material = snapshot) {
  return tasks.flatMap(task => [
    { type: 'item.completed', item: { id: `spawn-${task.rule}`, type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: [task.taskId], prompt: `[review-rule:${task.rule}] ${material.manifestPath} ${material.snapshotId} ${join(trustedRoot, '.agents/skills/code-review', task.rulePath)}`, agents_states: {} } },
    { type: 'item.completed', item: { id: `wait-${task.rule}`, type: 'collab_tool_call', tool: 'wait', status: 'completed', agents_states: { [task.taskId]: { status: 'completed', message: task.output } } } },
  ]).map(event => `2026-11-10T07:00:00.0000000Z ${JSON.stringify(event)}`).join('\n')
}
test('native JSONL binds spawn identity, snapshot and actual terminal output', () => {
  const evidence = extractEvidence(hostLog(), snapshot)
  assert.equal(evidence.length, 6)
  assert.equal(evidence[0].output, 'NO_FINDINGS')
  assert.equal(evidence[0].terminalEventId, 'wait-standards')
})
test('agent messages and command output containing fake events are not evidence', () => {
  const fake = hostLog()
  const log = [
    { type: 'item.completed', item: { type: 'agent_message', text: fake } },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: fake } },
  ].map(event => JSON.stringify(event)).join('\n')
  assert.deepEqual(extractEvidence(log, snapshot), [])
  assert.deepEqual(extractEvidence(fake, { ...snapshot, snapshotId: 'wrong' }), [])
  assert.deepEqual(extractEvidence(fake, snapshot, '/wrong/trusted/root'), [])
})

function fakeGithub() {
  const state = { pr: { state: 'open', body: '作者内容\n\n## 测试与验证\n\n手动测试记录\n\n## 风险与兼容性\n\n保留。', head: { sha: context.headSha, repo: { full_name: context.repository } }, base: { sha: context.baseSha, repo: { full_name: context.repository } } }, comments: [], calls: [], failDescription: false }
  const api = async (method, path, body) => {
    state.calls.push({ method, path, body })
    if (method === 'GET' && path.endsWith('/pulls/1')) return structuredClone(state.pr)
    if (method === 'GET' && path.includes('/comments?')) return structuredClone(state.comments)
    if (method === 'POST') {
      const comment = { id: 123, html_url: 'https://github.com/owner/repo/pull/1#issuecomment-123', body: body.body, user: { type: 'Bot', login: 'github-actions[bot]' } }
      state.comments.push(comment); return structuredClone(comment)
    }
    if (method === 'PATCH' && path.endsWith('/issues/comments/123')) { Object.assign(state.comments.find(item => item.id === 123), body); return structuredClone(state.comments.find(item => item.id === 123)) }
    if (method === 'PATCH' && path.endsWith('/pulls/1')) {
      if (state.failDescription) throw new Error('HTTP 403')
      state.pr.body = body.body; return structuredClone(state.pr)
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  return { state, api }
}

test('publishing updates one bot comment and preserves author sections', async () => {
  const { state, api } = fakeGithub()
  await publish(api, valid())
  assert.equal(state.comments.length, 1)
  assert.match(state.pr.body, /作者内容/)
  assert.match(state.pr.body, /手动测试记录/)
  assert.match(state.pr.body, /风险与兼容性\n\n保留/)
  assert.match(state.pr.body, /\[机器人报告\]\(https:\/\/github.com\/owner\/repo\/pull\/1#issuecomment-123\)/)
  assert.equal((state.pr.body.match(/\[x\]/g) ?? []).length, 3)
  state.pr.body += '\n作者后来补充的记录。'
  await publish(api, valid())
  assert.equal(state.comments.length, 1)
  assert.match(state.pr.body, /作者后来补充/)
})
test('initialization immediately clears previous checks without claiming a report', async () => {
  const { state, api } = fakeGithub()
  await publish(api, valid())
  await publish(api, { context, status: '进行中', conclusion: '待审查' }, { initializing: true })
  assert.match(state.pr.body, /审查状态：进行中/)
  assert.equal((state.pr.body.match(/\[ \]/g) ?? []).length, 3)
  assert.match(state.pr.body, /审查报告：待生成/)
})
test('old head, old base and closed PR cannot be written', async () => {
  for (const mutate of [state => { state.pr.head.sha = 'e'.repeat(40) }, state => { state.pr.base.sha = 'e'.repeat(40) }, state => { state.pr.state = 'closed' }]) {
    const { state, api } = fakeGithub(); mutate(state)
    assert.equal((await publish(api, valid())).status, '已过期')
    assert.equal(state.calls.filter(call => call.method !== 'GET').length, 0)
  }
})
test('head changes between comment and description: description is not overwritten', async () => {
  const { state, api } = fakeGithub()
  const wrapped = async (...args) => {
    const result = await api(...args)
    if (args[0] === 'POST') state.pr.head.sha = 'e'.repeat(40)
    return result
  }
  assert.equal((await publish(wrapped, valid())).status, '已过期')
  assert.doesNotMatch(state.pr.body, /ai-review:start/)
})
test('description failure is explicit and retry reuses the published comment', async () => {
  const { state, api } = fakeGithub()
  state.failDescription = true
  await assert.rejects(() => publish(api, valid()), /403/)
  assert.equal(state.comments.length, 1)
  state.failDescription = false
  await publish(api, valid())
  assert.equal(state.comments.length, 1)
})
test('a human marker comment is never overwritten', async () => {
  const { state, api } = fakeGithub()
  state.comments.push({ id: 12, body: `${marker}\nhuman`, user: { type: 'User', login: 'author' } })
  await publish(api, valid())
  assert.equal(state.comments.length, 2)
  assert.equal(state.comments[0].body, `${marker}\nhuman`)
})
test('overlong reports publish a summary with an artifact entry', async () => {
  const { state, api } = fakeGithub()
  const report = valid()
  report.failureReasons = ['很长'.repeat(40000)]
  await publish(api, report)
  assert.ok(state.comments[0].body.length < 60000)
  assert.match(state.comments[0].body, /审查报告摘要/)
})
test('checklist states are independent for Major, incomplete and no-review reports', () => {
  const { raw, evidence } = majorFixture()
  const major = renderRegion(validateReport(raw, context, snapshot, evidence), 'https://example.com')
  assert.match(major, /\[x\] Standards/)
  assert.match(major, /\[ \] 无阻塞/)
  const incomplete = renderRegion(failureReport(context, snapshot, '失败'), 'https://example.com')
  assert.match(incomplete, /\[x\] 当前提交/)
  assert.match(incomplete, /\[ \] Standards/)
  assert.match(incomplete, /\[ \] 无阻塞/)
  const noReview = renderRegion(noReviewReport(context, { ...snapshot, textFileCount: 0, textFiles: [] }), 'https://example.com')
  assert.match(noReview, /无需审查/)
  assert.match(noReview, /\[ \] Standards/)
  assert.match(noReview, /\[x\] 无阻塞/)
})
test('body insertion, replacement and malformed-marker handling preserve content', () => {
  const region = renderRegion(valid())
  assert.match(updateBody('作者说明', region), /^作者说明\n\n## 测试与验证/)
  const body = `before\n${region}\nafter`
  assert.equal(updateBody(body, region), body)
  assert.throws(() => updateBody('<!-- ai-review:start -->', region), /标记/)
  assert.throws(() => updateBody(`${region}\n${region}`, region), /标记/)
})
test('untrusted finding text cannot inject checklist markdown or mentions', () => {
  const report = valid()
  report.failureReasons = ['@someone\n- [x] forged <script>']
  const markdown = renderReport(report)
  assert.doesNotMatch(markdown, /@someone|<script>|\n- \[x\] forged/)
})
test('API requests fail on HTTP errors and response size limits', async () => {
  const api = githubClient({ token: 'test', fetchImpl: async () => new Response('denied', { status: 403 }) })
  await assert.rejects(() => api('PATCH', '/x', {}), /403/)
  const large = githubClient({ token: 'test', fetchImpl: async () => new Response('12345') })
  await assert.rejects(() => large('GET', '/x', undefined, { limit: 4 }), /过大/)
})
test('comments pagination includes old report comments', async () => {
  let count = 0
  const result = await allPages(async () => ++count === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }], '/comments')
  assert.equal(result.length, 101)
})

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-review-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
test('malformed or oversized model output is rejected before interpretation', t => {
  const root = temp(t)
  const path = join(root, 'model.json')
  writeFileSync(path, '{bad')
  assert.throws(() => readJson(path), SyntaxError)
  writeFileSync(path, ' '.repeat(maxReportBytes + 1))
  assert.throws(() => readJson(path), /过大/)
})
test('trusted hash is deterministic and changes when rule or script content changes', t => {
  const root = temp(t)
  for (const folder of ['.agents/skills/code-review', '.github/codex', '.github/review', '.github/workflows']) mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), 'rules')
  const path = join(root, '.github/workflows/ai-review.yml')
  writeFileSync(path, 'workflow')
  const hash = rulesHash(root)
  assert.equal(hash, rulesHash(root))
  writeFileSync(path, 'new workflow')
  assert.notEqual(hash, rulesHash(root))
})
test('runtime context rejects invalid SHA and PR values', () => {
  const env = { REVIEW_REPOSITORY: context.repository, REVIEW_BASE_SHA: context.baseSha, REVIEW_HEAD_SHA: context.headSha,
    REVIEW_TRUSTED_SHA: context.trustedSha, REVIEW_TRUSTED_ROOT: trustedRoot, REVIEW_PR_NUMBER: '1', GITHUB_RUN_ID: '10', GITHUB_RUN_ATTEMPT: '1' }
  assert.equal(contextFromEnvironment(env).headSha, context.headSha)
  assert.throws(() => contextFromEnvironment({ ...env, REVIEW_PR_NUMBER: 'bad' }), /编号/)
  assert.throws(() => contextFromEnvironment({ ...env, REVIEW_HEAD_SHA: 'bad' }), /SHA/)
})

function repository(t, docsOnly = false) {
  const root = temp(t)
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'a.js'), 'export const value = 1\n')
  git('add', '.'); git('commit', '--quiet', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(join(root, docsOnly ? 'README.md' : 'a.js'), docsOnly ? '# docs\n' : 'export const value = 2\n')
  git('add', '.'); git('commit', '--quiet', '-m', 'change')
  return { root, context: { ...context, baseSha, trustedSha: baseSha, headSha: git('rev-parse', 'HEAD') } }
}
test('snapshot digest is independent of temporary paths and workspace remains clean', t => {
  const repo = repository(t)
  const first = prepareSnapshot(repo.root, trustedRoot, repo.context)
  const second = prepareSnapshot(repo.root, trustedRoot, repo.context)
  t.after(() => { rmSync(first.tempDirectory, { recursive: true, force: true }); rmSync(second.tempDirectory, { recursive: true, force: true }) })
  assert.equal(first.snapshot.snapshotId, second.snapshot.snapshotId)
  assert.notEqual(first.snapshot.manifestPath, second.snapshot.manifestPath)
  assert.deepEqual(first.snapshot.textFiles, ['a.js'])
})
test('finalizer emits incomplete report for missing output instead of claiming success', async t => {
  const repo = repository(t)
  const output = temp(t)
  const api = async () => ({ jobs: [{ id: 20, name: 'Review', conclusion: 'failure', steps: [{ name: 'Verify reviewed workspace unchanged', conclusion: 'success' }] }] })
  const report = await finalize({ api, context: repo.context, sourceRoot: repo.root, trustedRoot, input: join(output, 'missing'), output })
  assert.equal(report.status, '未完成')
  assert.match(readFileSync(join(output, 'report.md'), 'utf8'), /未完成/)
})
test('finalizer independently confirms documentation-only scope without model output', async t => {
  const repo = repository(t, true)
  const output = temp(t)
  const api = async () => ({ jobs: [{ id: 20, name: 'Review', conclusion: 'success', steps: [{ name: 'Verify reviewed workspace unchanged', conclusion: 'success' }] }] })
  const report = await finalize({ api, context: repo.context, sourceRoot: repo.root, trustedRoot, input: join(output, 'missing'), output })
  assert.equal(report.status, '无需审查')
  assert.equal(report.tasks.every(task => task.status === 'not_started'), true)
})

test('finalizer validates the complete structured-report pipeline using simulated host events', async t => {
  const repo = repository(t)
  const output = temp(t)
  const input = temp(t)
  const prepared = prepareSnapshot(repo.root, trustedRoot, repo.context)
  t.after(() => rmSync(prepared.tempDirectory, { recursive: true, force: true }))
  const { raw } = fixture()
  raw.context = repo.context
  raw.scope = scopeOf(prepared.snapshot)
  raw.tasks.forEach(task => { task.snapshotId = prepared.snapshot.snapshotId })
  writeJson(join(input, 'snapshot.json'), prepared.snapshot)
  writeJson(join(input, 'model-report.json'), raw)
  const log = hostLog(raw.tasks, prepared.snapshot)
  const api = async (_method, path) => path.endsWith('/logs') ? log : {
    jobs: [{ id: 20, name: 'Review', conclusion: 'success', steps: [
      { name: 'Verify reviewed workspace unchanged', conclusion: 'success' },
      { name: 'Run project review skill', conclusion: 'success' },
    ] }],
  }
  const report = await finalize({ api, context: repo.context, sourceRoot: repo.root, trustedRoot, input, output })
  assert.equal(report.status, '已完成')
  assert.equal(report.evidence.length, 6)
  assert.equal(readJson(join(output, 'report.json')).conclusion, '通过')
  assert.match(readFileSync(join(output, 'report.md'), 'utf8'), /AI Review Rules/)
})

function diagnosticFixture(t) {
  const root = temp(t)
  const options = { context, sourceRoot: join(root, 'source'), codexHome: join(root, 'codex') }
  const sessions = join(options.codexHome, 'sessions')
  const sessionId = '00000000-0000-0000-0000-000000000001'
  function add(name, records = [], cwd = options.sourceRoot) {
    mkdirSync(sessions, { recursive: true })
    const path = join(sessions, `${name}.jsonl`)
    writeFileSync(path, [{ type: 'session_meta', payload: { id: sessionId, cwd } }, ...records].map(record => JSON.stringify(record)).join('\n') + '\n')
    return path
  }
  return { options, sessions, sessionId, add }
}

test('diagnostic baseline captures names only, including an initially absent sessions directory', t => {
  const f = diagnosticFixture(t)
  const empty = captureBaseline(f.options)
  assert.equal(empty.sessionsInitiallyMissing, true)
  assert.deepEqual(empty.issues, [])
  f.add('old', [{ type: 'response_item', payload: { text: 'DO_NOT_COLLECT' } }])
  const baseline = captureBaseline(f.options)
  assert.deepEqual(baseline.files, ['old.jsonl'])
  assert.doesNotMatch(JSON.stringify(baseline), /DO_NOT_COLLECT/)
  assert.equal(baseline.context.runId, context.runId)
})

test('native rollout metadata exposes candidate delegation, identities and terminal fields only', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  f.add('new', [
    { type: 'event_msg', payload: { type: 'collab_agent_spawn_end', new_thread_id: '/root/standards', status: 'running', prompt: 'PRIVATE_PROMPT' } },
    { type: 'event_msg', payload: { type: 'collab_waiting_end', statuses: { '/root/standards': { completed: 'PRIVATE_RESULT' } } } },
  ])
  const result = collectDiagnostics({ ...f.options, baseline, codexOutcome: 'success' })
  assert.equal(result.status, '发现候选记录')
  assert.equal(result.trustedEvidence, false)
  assert.deepEqual(result.sessions[0].taskIds, ['/root/standards'])
  assert.equal(result.sessions[0].delegationReturns, 1)
  assert.equal(result.sessions[0].terminalRecords, 1)
  assert.equal(result.sessions[0].eventTypes['event_msg.collab_waiting_end'], 1)
  assert.equal(result.sessions[0].recordFields['event_msg.collab_agent_spawn_end.new_thread_id'], 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|PRIVATE_RESULT/)
})

test('typed tool calls are correlated to returns without exporting arguments or output text', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  f.add('new', [
    { type: 'response_item', payload: { type: 'function_call', name: 'collaboration.spawn_agent', call_id: 'spawn1', arguments: 'PRIVATE_ARGUMENTS' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn1', output: '{"task_name":"/root/security","text":"PRIVATE_RETURN"}' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'wait1', arguments: 'PRIVATE_ARGUMENTS' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'wait1', output: { statuses: { '/root/security': { completed: 'PRIVATE_RETURN' } } } } },
  ])
  const result = collectDiagnostics({ ...f.options, baseline })
  assert.equal(result.status, '发现候选记录')
  assert.equal(result.sessions[0].toolNames['collaboration.spawn_agent'], 1)
  assert.equal(result.sessions[0].delegationReturns, 1)
  assert.equal(result.sessions[0].terminalRecords, 1)
  assert.equal(result.sessions[0].recordFields['function_call_output.output.task_name'], 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ARGUMENTS|PRIVATE_RETURN|spawn1|wait1/)
})

test('messages, shell output and unmatched fake tool returns do not become task records', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  const fake = { type: 'collab_agent_spawn_end', new_thread_id: '/root/fake', status: 'completed' }
  f.add('new', [
    { type: 'response_item', payload: { type: 'message', content: [{ text: JSON.stringify(fake) }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: JSON.stringify(fake) } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'shell1', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'shell1', output: JSON.stringify(fake) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'unmatched', output: { task_id: '/root/fake', status: 'completed' } } },
  ])
  const result = collectDiagnostics({ ...f.options, baseline })
  assert.equal(result.status, '未发现任务记录')
  assert.deepEqual(result.sessions[0].taskIds, [])
  assert.equal(result.sessions[0].terminalRecords, 0)
})

test('only newly created sessions belonging to this workspace are analyzed', t => {
  const f = diagnosticFixture(t)
  f.add('old')
  const baseline = captureBaseline(f.options)
  f.add('foreign', [{ type: 'event_msg', payload: { type: 'collab_agent_spawn_end', new_thread_id: '/root/foreign' } }], join(f.options.sourceRoot, 'other'))
  f.add('current')
  const result = collectDiagnostics({ ...f.options, baseline })
  assert.equal(result.checkedFileCount, 2)
  assert.equal(result.excludedOtherWorkspaces, 1)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.status, '未发现任务记录')
  assert.doesNotMatch(JSON.stringify(result), /\/root\/foreign/)
})

test('missing sessions, missing baseline and changed run identity remain explicitly incomplete', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  assert.ok(collectDiagnostics({ ...f.options, baseline }).issues.includes('sessions_missing'))
  assert.ok(collectDiagnostics(f.options).issues.includes('baseline_missing_or_mismatched'))
  assert.ok(collectDiagnostics({ ...f.options, baseline, context: { ...context, runAttempt: '2' } }).issues.includes('baseline_missing_or_mismatched'))
})

test('unreadable sessions and corrupt JSONL never imply missing host evidence', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  const path = f.add('corrupt')
  diagnosticFs.appendFileSync(path, '{bad JSON\n')
  const corrupt = collectDiagnostics({ ...f.options, baseline })
  assert.equal(corrupt.status, '诊断未完成')
  assert.ok(corrupt.issues.includes('malformed_or_incomplete_jsonl'))
  const denied = collectDiagnostics({ ...f.options, baseline, io: { ...diagnosticFs, readdirSync() { throw Object.assign(new Error('PRIVATE_ERROR'), { code: 'EACCES' }) } } })
  assert.equal(denied.status, '诊断未完成')
  assert.ok(denied.issues.includes('inventory_EACCES'))
  assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_ERROR/)
})

test('new session count is bounded at twenty and truncation is explicit', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  for (let index = 0; index < 21; index++) f.add(`session-${index}`)
  const result = collectDiagnostics({ ...f.options, baseline })
  assert.equal(result.newFileCount, 21)
  assert.equal(result.checkedFileCount, 20)
  assert.equal(result.status, '诊断未完成')
  assert.ok(result.issues.includes('new_file_limit'))
})

test('file reads stop at twenty MiB and do not silently accept partial records', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  const path = f.add('large')
  diagnosticFs.appendFileSync(path, ' '.repeat(diagnosticLimits.bytesPerFile))
  let readBytes = 0
  const io = { ...diagnosticFs, readSync(...args) { const bytes = diagnosticFs.readSync(...args); readBytes += bytes; return bytes } }
  const result = collectDiagnostics({ ...f.options, baseline, io })
  assert.equal(readBytes, diagnosticLimits.bytesPerFile)
  assert.equal(result.status, '诊断未完成')
  assert.ok(result.issues.includes('file_size_limit'))
})

test('unassociated metadata and task calls with no return remain incomplete', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  const path = f.add('bad-metadata')
  writeFileSync(path, '{"type":"session_meta","payload":{}}\n')
  assert.ok(collectDiagnostics({ ...f.options, baseline }).issues.includes('session_metadata_missing_or_invalid'))
  f.add('bad-metadata', [{ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'missing' } }])
  const result = collectDiagnostics({ ...f.options, baseline })
  assert.equal(result.status, '诊断未完成')
  assert.ok(result.issues.includes('task_return_records_missing'))
})

test('unknown collaboration event shapes require follow-up rather than claiming no records', t => {
  const f = diagnosticFixture(t)
  const baseline = captureBaseline(f.options)
  f.add('new', [{ type: 'event_msg', payload: { type: 'collab_future_result', body: 'PRIVATE_RETURN' } }])
  const result = collectDiagnostics({ ...f.options, baseline })
  assert.equal(result.status, '诊断未完成')
  assert.ok(result.issues.includes('unrecognized_task_events'))
  assert.equal(result.sessions[0].eventTypes['event_msg.collab_future_result'], 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RETURN/)
})

test('diagnostics never read authentication/config files or follow session symlinks', t => {
  const f = diagnosticFixture(t)
  mkdirSync(f.sessions, { recursive: true })
  writeFileSync(join(f.options.codexHome, 'auth.json'), 'PRIVATE_AUTH')
  writeFileSync(join(f.options.codexHome, 'config.toml'), 'PRIVATE_CONFIG')
  const baseline = captureBaseline(f.options)
  const path = f.add('link')
  let opened = false
  const io = { ...diagnosticFs,
    lstatSync(file) { return file === path ? { isSymbolicLink: () => true } : diagnosticFs.lstatSync(file) },
    openSync() { opened = true; throw new Error('Should not read symlink') },
  }
  const result = collectDiagnostics({ ...f.options, baseline, io })
  assert.equal(opened, false)
  assert.ok(result.issues.includes('symlink_skipped'))
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AUTH|PRIVATE_CONFIG/)
})

test('diagnostic CLI saves redacted JSON and Summary without changing review results', t => {
  const f = diagnosticFixture(t)
  const output = temp(t)
  const summaryFile = join(output, 'summary.md')
  const env = { ...process.env, CODEX_HOME: f.options.codexHome, REVIEW_SOURCE_ROOT: f.options.sourceRoot,
    REVIEW_OUTPUT: output, REVIEW_TRUSTED_ROOT: trustedRoot, REVIEW_REPOSITORY: context.repository,
    REVIEW_BASE_SHA: context.baseSha, REVIEW_HEAD_SHA: context.headSha, REVIEW_TRUSTED_SHA: context.trustedSha,
    REVIEW_PR_NUMBER: '1', GITHUB_RUN_ID: context.runId, GITHUB_RUN_ATTEMPT: '1', GITHUB_STEP_SUMMARY: summaryFile,
    REVIEW_CODEX_OUTCOME: 'failure', DIAGNOSTIC_PRIVATE_ENV: 'PRIVATE_ENV' }
  const run = mode => spawnSync(process.execPath, [join(trustedRoot, '.github/review/diagnose-host.mjs'), mode], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(run('before').status, 0)
  f.add('new')
  const report = failureReport(context, snapshot, 'missing evidence')
  writeJson(join(output, 'report.json'), report)
  assert.equal(run('after').status, 0)
  const result = readJson(join(output, 'diagnostics.json'))
  assert.equal(result.codexOutcome, 'failure')
  assert.equal(result.status, '未发现任务记录')
  assert.deepEqual(readJson(join(output, 'report.json')), report)
  assert.match(readFileSync(summaryFile, 'utf8'), /不改变审查结论/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ENV/)
  writeFileSync(join(output, 'diagnostic-baseline.json'), 'bad json')
  assert.equal(run('after').status, 0)
  assert.equal(readJson(join(output, 'diagnostics.json')).status, '诊断未完成')
})

test('workflow keeps diagnostics nonblocking and preserves its existing report publisher', () => {
  const workflow = readFileSync(join(trustedRoot, '.github/workflows/ai-review.yml'), 'utf8')
  assert.match(workflow, /name: Diagnose host evidence outlet\r?\n\s+if: always\(\)\r?\n\s+continue-on-error: true/)
  assert.match(workflow, /name: Record host session baseline[\s\S]*?continue-on-error: true/)
  assert.match(workflow, /path: \$\{\{ env.REVIEW_OUTPUT \}\}\/\*\.json/)
  assert.match(workflow, /name: Publish robot comment and PR description/)
})
