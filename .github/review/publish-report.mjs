import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextFromEnvironment, isMain, readJson, summary, writeJson } from './common.mjs'
import { allPages, currentPull, githubClient } from './github.mjs'
import { renderRegion, renderReport, updateBody } from './render-report.mjs'

export const marker = '<!-- ai-review:report:v1 -->'

export async function publish(api, report, { initializing = false } = {}) {
  const context = report.context
  let pr = await currentPull(api, context)
  if (!pr) return { status: '已过期', published: false }
  const endpoint = `/repos/${context.repository}`
  let commentUrl = null
  if (!initializing) {
    const comments = await allPages(api, `${endpoint}/issues/${context.pr}/comments`)
    const matches = comments.filter(comment => comment.user?.type === 'Bot' && comment.user.login === 'github-actions[bot]' && comment.body?.startsWith(marker))
    if (matches.length > 1) throw new Error('发现多条机器人报告评论，拒绝猜测更新目标')
    const markdown = renderReport(report)
    const full = `${marker}\n${markdown}`
    const body = full.length <= 60000 ? full : `${marker}\n## 审查报告摘要\n\n- 状态：${report.status}\n- 结论：${report.conclusion}\n- Head：${context.headSha}\n- Findings：${report.findings.length}\n\n[完整报告及 Artifact](${context.runUrl})（保留 30 天）`
    if (!await currentPull(api, context)) return { status: '已过期', published: false }
    const comment = matches[0]
      ? await api('PATCH', `${endpoint}/issues/comments/${matches[0].id}`, { body })
      : await api('POST', `${endpoint}/issues/${context.pr}/comments`, { body })
    const url = new URL(comment.html_url)
    const server = new URL(context.runUrl)
    if (url.origin !== server.origin || !url.pathname.startsWith(`/${context.repository}/pull/${context.pr}`) || !url.hash.startsWith('#issuecomment-')) throw new Error('GitHub 返回的评论链接无效')
    commentUrl = url.href
  }
  // Read the author's latest body immediately before patching it.
  pr = await currentPull(api, context)
  if (!pr) return { status: '已过期', published: false, commentUrl }
  const body = updateBody(pr.body, renderRegion(report, commentUrl))
  if (body.length > 60000) throw new Error('PR 描述过长，无法安全插入报告区域')
  await api('PATCH', `${endpoint}/pulls/${context.pr}`, { body })
  return { status: report.status, published: !initializing, commentUrl }
}

if (isMain(import.meta.url)) {
  try {
    const context = contextFromEnvironment()
    const initializing = process.argv[2] === 'initialize'
    const report = initializing
      ? { context, status: '进行中', conclusion: '待审查' }
      : readJson(join(process.env.REVIEW_OUTPUT, 'report.json'), 4 * 1024 * 1024)
    if (JSON.stringify(report.context) !== JSON.stringify(context)) throw new Error('发布上下文与工作流不符')
    const result = await publish(githubClient(), report, { initializing })
    writeJson(join(process.env.REVIEW_OUTPUT, 'publication.json'), result)
    summary(`AI Review 发布状态：${result.status}；报告链接：${result.commentUrl ?? '暂无'}。`)
    if (initializing && result.status === '已过期') throw new Error('初始化时审查版本已过期，停止审查')
    if (!initializing) writeFileSync(join(process.env.REVIEW_OUTPUT, 'report.md'), renderReport(report))
  } catch (error) {
    console.error(error.message)
    summary(`AI Review 发布失败：${error.message}。本次发布未验收成功。`)
    if (process.env.REVIEW_OUTPUT) writeJson(join(process.env.REVIEW_OUTPUT, 'publication.json'), { status: '发布失败', published: false, reason: error.message })
    process.exitCode = 1
  }
}
