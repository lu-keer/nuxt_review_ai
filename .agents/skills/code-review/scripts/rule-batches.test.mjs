import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildReviewBatches } from './build-review-batches.mjs'
import { discoverRuleCatalog, skillDirectory } from './rule-catalog.mjs'
import { loadReviewPolicy } from './review-policy.mjs'

const rulePath = name => `references/ai_review_rules/${name}.md`

test('all_rules creates five independent full-patch batches and rejects skipped rules or partial files', t => {
  const f = fixture(t)
  f.plan.all_rules = true
  f.plan.primary = discoverRuleCatalog().map(rule => ({ ...f.batch(rule.path.split('/').at(-1).replace('.md', ''), f.files), rule_path: rule.path }))
  f.plan.skipped_rules = []
  const index = f.run()
  assert.equal(index.primary_count, 5)
  assert.equal(index.max_concurrency, 5)
  for (const batch of index.batches) {
    const child = JSON.parse(readFileSync(batch.manifestPath, 'utf8'))
    assert.deepEqual(child.textFiles, f.files)
    assert.deepEqual(child.aiRulePaths, [batch.rule_path])
  }
  f.plan.primary[0].files = f.files.slice(1)
  assert.throws(f.run, /all_rules/)
  f.plan.primary[0].files = f.files
  const omitted = f.plan.primary.pop()
  f.plan.skipped_rules.push({ path: omitted.rule_path, reason: 'skip' })
  assert.throws(f.run, /all_rules/)
})

test('omitting plan auto-builds all_rules primary for every catalog rule and full textFiles', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'manifest.json'), JSON.stringify(f.parent))
  const index = JSON.parse(readFileSync(buildReviewBatches(join(f.root, 'manifest.json')), 'utf8'))
  const catalog = discoverRuleCatalog()
  assert.equal(index.primary_count, catalog.length)
  assert.equal(index.batches.length, catalog.length)
  assert.deepEqual(index.skipped_rules, [])
  assert.deepEqual(index.batches.map(batch => batch.rule_path), catalog.map(rule => rule.path))
  for (const [i, batch] of index.batches.entries()) {
    const child = JSON.parse(readFileSync(batch.manifestPath, 'utf8'))
    assert.equal(batch.reason, '固定全规则审查')
    assert.equal(batch.purpose, catalog[i].applicability)
    assert.deepEqual(child.textFiles, f.files)
    assert.deepEqual(child.aiRulePaths, [catalog[i].path])
  }
  assert.throws(() => buildReviewBatches(join(f.root, 'manifest.json'), null, join(f.root, 'missing-index.json')), /追加第二轮需要 --plan/)
})

test('removed rules are outside the catalog and no rules need be selected', t => {
  const f = fixture(t)
  const catalog = discoverRuleCatalog()
  assert.ok(catalog.some(rule => rule.path === rulePath('architect')))
  assert.ok(catalog.every(rule => !rule.required && rule.path !== rulePath('reviewer')))
  f.plan.primary = []
  f.plan.skipped_rules = catalog.map(rule => ({ path: rule.path, reason: '本次变更不涉及该规则检查机制' }))
  const index = f.run()
  assert.equal(index.primary_count, 0)
  assert.deepEqual(index.batches, [])
})
function fixture(t, { large = false, rename = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'review-rule-batches-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = ['FinanceReqVO.java', 'Mapper.xml', 'FinanceServiceImplTest.java', 'SubscriptionServiceImpl.java', 'SubscriptionServiceImplTest.java']
  const layers = ['staged', 'unstaged'].map(kind => {
    const filePatches = files.map((path, i) => {
      const content = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${large && i === 3 ? 'x'.repeat(48550) : '中文 ' + kind}\n`
      const patchPath = join(root, `${kind}-${i}.patch`)
      writeFileSync(patchPath, content)
      return { path, paths: rename && i === 0 ? ['old.java', path] : [path], patchPath, bytes: Buffer.byteLength(content), addedLines: 1, deletedLines: 1 }
    })
    const patchPath = join(root, `${kind}.patch`)
    writeFileSync(patchPath, Buffer.concat(filePatches.map(block => readFileSync(block.patchPath))))
    return { kind, patchPath, filePatches }
  })
  const parent = { repositoryRoot: root, tempDirectory: root, textFiles: files, layers, review_plan_required: true }
  const manifestPath = join(root, 'manifest.json'), planPath = join(root, 'plan.json')
  const batch = (name, selectedFiles) => ({ id: name, rule_path: rulePath(name), reason: '适用本次实际变更', purpose: `检查 ${name}`, files: selectedFiles })
  const plan = { primary: [batch('architect', files), batch('runtime_performance', [files[1], files[3]]), batch('product_contract', [files[0], files[3]])],
    integration: [], skipped_rules: discoverRuleCatalog().filter(rule => !['architect', 'runtime_performance', 'product_contract'].some(name => rule.path === rulePath(name))).map(rule => ({ path: rule.path, reason: '没有相关行为变化' })) }
  const run = () => { writeFileSync(manifestPath, JSON.stringify(parent)); writeFileSync(planPath, JSON.stringify(plan)); return JSON.parse(readFileSync(buildReviewBatches(manifestPath, planPath), 'utf8')) }
  return { root, files, parent, plan, batch, run }
}

test('five files produce three rule agents; overlapping files are allowed and each agent gets only its own rule', t => {
  const f = fixture(t)
  const index = f.run()
  assert.equal(index.schema_version, 4)
  assert.equal(index.primary_count, 3)
  assert.equal(index.batches.length, 3)
  assert.equal(index.max_concurrency, 3)
  assert.equal(index.review_timeout_ms, 600000)
  assert.equal(index.run_timeout_ms, 1800000)
  assert.deepEqual(index.skipped_rules, f.plan.skipped_rules)
  assert.ok(!('target_patch_bytes' in index))
  for (const [i, batch] of index.batches.entries()) {
    const child = JSON.parse(readFileSync(batch.manifestPath, 'utf8'))
    assert.equal(child.review_batch.schema_version, 4)
    assert.equal(child.review_batch.review_type, f.plan.primary[i].id)
    assert.ok(!('business_type' in child.review_batch))
    assert.ok(!('family' in child.review_batch))
    assert.ok(!('patch_units' in child))
    assert.deepEqual(child.aiRulePaths, [f.plan.primary[i].rule_path])
    assert.deepEqual(child.textFiles, f.plan.primary[i].files)
    assert.equal(child.addedLines, child.textFiles.length * 2)
    assert.equal(child.deletedLines, child.textFiles.length * 2)
    const policy = loadReviewPolicy(batch.manifestPath, skillDirectory, f.root)
    assert.deepEqual(policy.materials.filter(item => item.label.startsWith('AI rule:')).map(item => item.label), [`AI rule: ${child.review_batch.review_type}.md`])
    for (const [j, layer] of child.layers.entries()) {
      const expected = f.parent.layers[j].filePatches.filter(block => child.textFiles.includes(block.path))
      assert.deepEqual(readFileSync(layer.patchPath), Buffer.concat(expected.map(block => readFileSync(block.patchPath))))
    }
  }
  assert.deepEqual(JSON.parse(readFileSync(index.batches[0].manifestPath, 'utf8')).textFiles, f.files)
})

test('47KiB patches stay whole without oversize explanations or extra agents', t => {
  const f = fixture(t, { large: true })
  const index = f.run()
  assert.equal(index.batches.length, 3)
  assert.ok(index.batches[0].patch_bytes > 48550)
  const child = JSON.parse(readFileSync(index.batches[0].manifestPath, 'utf8'))
  assert.deepEqual(readFileSync(child.layers[0].patchPath), readFileSync(f.parent.layers[0].patchPath))
})

for (const [name, change, expected] of [
  ['duplicate rule', f => f.plan.primary.push({ ...f.plan.primary[1], id: 'other' }), /每个规则恰好一次/],
  ['unknown rule', f => f.plan.primary[1].rule_path = 'references/ai_review_rules/unknown.md', /每个规则恰好一次/],
  ['missing skipped explanation', f => f.plan.skipped_rules[0].reason = '', /完整说明/],
  ['missing selected explanation', f => delete f.plan.primary[1].reason, /完整说明/],
  ['missing selection', f => f.plan.skipped_rules.pop(), /完整说明/],
  ['duplicate file within rule', f => f.plan.primary[1].files.push(f.plan.primary[1].files[0]), /文件无效或重复/],
  ['unknown file', f => f.plan.primary[1].files.push('outside.java'), /文件无效或重复/],
  ['hunk selection', f => f.plan.primary[1].patch_units = ['staged:0:1:h0'], /hunk/],
  ['business grouping', f => f.plan.primary[1].business_type = 'finance', /rule_path/],
  ['multiple rules', f => f.plan.primary[1].rules = [], /多规则/],
  ['duplicate id', f => f.plan.primary[1].id = 'architect', /编号无效或重复/],
]) test(`rule plan rejects ${name} before writing child materials`, t => {
  const f = fixture(t); change(f)
  assert.throws(f.run, expected)
  assert.ok(!readdirSync(f.root).some(path => path.startsWith('batches-')))
})

test('rule selection retains rename endpoints and requires closure across other changed layers', t => {
  const f = fixture(t, { rename: true })
  const child = JSON.parse(readFileSync(f.run().batches[2].manifestPath, 'utf8'))
  assert.ok(child.layers[0].paths.includes('old.java'))
  // A rename linking two independently changed canonical paths needs both.
  f.parent.layers[0].filePatches[0].paths = [f.files[1], f.files[0]]
  assert.throws(f.run, /重命名关联文件/)
})

test('integration is optional, single-rule, and depends on its rule primary with extra cross-rule evidence allowed', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'dependency.java'), 'dependency content')
  f.plan.integration.push({ ...f.batch('runtime_performance', [f.files[3]]), id: 'performance-check', dependsOn: ['runtime_performance', 'architect'], risk_focus: '核实查询次数', dependency_files: ['dependency.java'] })
  const index = f.run()
  assert.equal(index.primary_count, 3)
  assert.equal(index.batches.length, 4)
  const candidate = index.batches[3]
  assert.equal(candidate.optional, true)
  const policy = loadReviewPolicy(candidate.manifestPath, skillDirectory, f.root)
  assert.deepEqual(policy.ruleNames, ['runtime_performance.md'])
  assert.equal(policy.materials.at(-1).content, 'dependency content')
  f.plan.integration[0].dependsOn = ['architect']
  assert.throws(f.run, /该规则首轮/)
  f.plan.integration[0].dependsOn = ['runtime_performance']
  f.plan.integration[0].files = [f.files[0]]
  assert.throws(f.run, /已审文件/)
  f.plan.integration[0].files = [f.files[3]]
  delete f.plan.integration[0].risk_focus
  assert.throws(f.run, /risk_focus/)
})

test('oversized material refuses planning without truncation, splitting, or creating outputs', t => {
  const f = fixture(t)
  const block = f.parent.layers[0].filePatches[3]
  const content = 'x'.repeat(1024 * 1024)
  writeFileSync(block.patchPath, content); block.bytes = content.length
  writeFileSync(f.parent.layers[0].patchPath, Buffer.concat(f.parent.layers[0].filePatches.map(item => readFileSync(item.patchPath))))
  assert.throws(f.run, /超过输入限制/)
  assert.equal(readFileSync(block.patchPath, 'utf8').length, content.length)
  assert.ok(!readdirSync(f.root).some(path => path.startsWith('batches-')))
})

test('appending integration preserves run identity and primary materials, rejecting changed or repeated batches', t => {
  const f = fixture(t)
  const initial = f.run()
  const indexPath = join(f.root, 'previous-index.json')
  const manifestPath = join(f.root, 'manifest.json')
  const planPath = join(f.root, 'append-plan.json')
  writeFileSync(indexPath, JSON.stringify(initial))
  f.plan.integration = [{ ...f.batch('runtime_performance', [f.files[3]]), id: 'performance-check', dependsOn: ['runtime_performance'], risk_focus: '核实查询次数' }]
  const append = () => {
    writeFileSync(planPath, JSON.stringify(f.plan))
    return JSON.parse(readFileSync(buildReviewBatches(manifestPath, planPath, indexPath), 'utf8'))
  }
  const next = append()
  assert.equal(next.run_id, initial.run_id)
  assert.deepEqual(next.batches.slice(0, initial.batches.length), initial.batches)
  const added = next.batches.at(-1)
  const policy = loadReviewPolicy(added.manifestPath, skillDirectory, f.root)
  assert.equal(policy.reviewBatch.run_id, initial.run_id)
  assert.deepEqual(policy.reviewBatch.depends_on, ['runtime_performance'])
  f.plan.primary[0].purpose = 'changed'
  assert.throws(append, /不能改变首轮/)
  f.plan.primary[0].purpose = initial.batches[0].purpose
  writeFileSync(indexPath, JSON.stringify(next))
  assert.throws(append, /新的唯一批次 ID/)
  f.plan.integration[0].id = 'performance-check-2'
  const last = append()
  assert.equal(last.run_id, initial.run_id)
  assert.deepEqual(last.batches.slice(0, next.batches.length), next.batches)
  const wrongParent = { ...last, parentManifestPath: join(f.root, 'other.json') }
  writeFileSync(indexPath, JSON.stringify(wrongParent))
  assert.throws(append, /父 manifest 不匹配/)
})
