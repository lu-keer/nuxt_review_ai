import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextFromEnvironment, isMain, readJson, summary, writeJson } from './common.mjs'
import { extractEvidence } from './evidence.mjs'
import { allPages, githubClient } from './github.mjs'
import { prepareSnapshot } from './prepare-run.mjs'
import { renderReport } from './render-report.mjs'
import { failureReport, noReviewReport, validateReport } from './validate-report.mjs'

export async function finalize({ api, context, sourceRoot, trustedRoot, input, output }) {
  mkdirSync(output, { recursive: true })
  let snapshot = null
  let tempDirectory
  let report
  try {
    // Rebuild scope in a clean publisher checkout, never from model assertions.
    const prepared = prepareSnapshot(sourceRoot, trustedRoot, context)
    snapshot = prepared.snapshot
    tempDirectory = prepared.tempDirectory
    const jobs = await allPages(api, `/repos/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs`)
    const matching = jobs.filter(job => job.name === 'Review')
    if (matching.length !== 1) throw new Error('无法唯一确定本次 Review job')
    const job = matching[0]
    const integrity = job.steps?.find(step => step.name === 'Verify reviewed workspace unchanged')
    if (integrity?.conclusion !== 'success') throw new Error('缺少工作区未修改的成功校验')
    if (!snapshot.textFileCount) {
      if (job.conclusion !== 'success') throw new Error('无需审查路径的工作流未成功结束')
      report = noReviewReport(context, snapshot)
    } else {
      const original = readJson(join(input, 'snapshot.json'))
      if (original.snapshotId !== snapshot.snapshotId) throw new Error('审查与发布阶段的快照摘要不一致')
      const log = await api('GET', `/repos/${context.repository}/actions/jobs/${job.id}/logs`, undefined, { text: true })
      const evidence = extractEvidence(log, { ...snapshot, manifestPath: original.manifestPath }, trustedRoot)
      writeJson(join(output, 'host-evidence.json'), evidence)
      const raw = readJson(join(input, 'model-report.json'))
      report = validateReport(raw, context, snapshot, evidence)
      if (job.conclusion !== 'success' || job.steps?.find(step => step.name === 'Run project review skill')?.conclusion !== 'success') {
        report.status = '未完成'
        report.conclusion = '未通过'
        report.failureReasons.push(`Review job 或 Codex Action 未成功：${job.conclusion}`)
      }
    }
  } catch (error) {
    report = failureReport(context, snapshot, error.message)
  } finally {
    // This publisher-owned snapshot has never been given to workers.
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true })
  }
  writeJson(join(output, 'report.json'), report)
  writeFileSync(join(output, 'report.md'), renderReport(report))
  summary(renderReport(report))
  return report
}

if (isMain(import.meta.url)) {
  try {
    await finalize({ api: githubClient(), context: contextFromEnvironment(), sourceRoot: process.env.REVIEW_SOURCE_ROOT,
      trustedRoot: process.env.REVIEW_TRUSTED_ROOT, input: process.env.REVIEW_INPUT, output: process.env.REVIEW_OUTPUT })
  } catch (error) { console.error(error.message); summary(`AI Review 汇总失败：${error.message}`); process.exitCode = 1 }
}
