export const safe = value => String(value ?? '不可用').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '&#64;')
  .replaceAll('|', '&#124;').replace(/([\\`*_[\]{}()#!~])/g, '\\$1').replace(/\r?\n/g, '<br>')

export function renderReport(report) {
  const { context, tasks } = report
  function table(selected) {
    return ['| 规则 | 任务身份 | 状态 | 真实耗时 | 规则路径 |', '| --- | --- | --- | --- | --- |',
      ...selected.map(task => `| ${safe(task.rule)} | ${safe(task.taskId)} | ${safe(task.status)} | ${task.durationMs === null ? '不可用' : `${task.durationMs} ms`} | ${safe(task.rulePath)} |`)].join('\n')
  }
  const findings = report.findings.map((finding, index) => {
    const url = `${context.runUrl.split('/actions/runs/')[0]}/blob/${context.headSha}/${finding.file.split('/').map(encodeURIComponent).join('/')}#L${finding.line}`
    return `### ${index + 1}. ${safe(finding.severity)}：${safe(finding.title)}\n\n[${safe(finding.file)}:${finding.line}](${url})\n\n- 触发条件：${safe(finding.trigger)}\n- 影响：${safe(finding.impact)}\n- 代码：${safe(finding.code)}\n- 证据：${safe(finding.evidence)}`
  })
  return `## Standards\n\n${table(tasks.filter(task => task.rule === 'standards'))}\n\n## AI Review Rules\n\n${table(tasks.filter(task => task.rule !== 'standards'))}\n\n## Summary\n\n- 状态：${report.status}\n- 审查结论：${report.conclusion}（观察模式，未启用 Required Check）\n- 仓库 / PR：${safe(context.repository)} #${context.pr}\n- Base：${context.baseSha}\n- Head：${context.headSha}\n- 受信任提交：${context.trustedSha}\n- 规则版本：${context.rulesHash}\n- 模型配置：${safe(context.model)}；要求所有 worker 继承，宿主未提供独立模型字段\n- 快照：${report.scope?.snapshotId ?? '不可用'}；文本文件：${report.scope?.textFileCount ?? '不可用'}\n- Findings：${report.findings.length}；最高等级：${['Critical', 'Major', 'Minor'].find(level => report.findings.some(finding => finding.severity === level)) ?? '无'}\n- 合并：${report.mergedCount}；剔除：${report.discardedCount}\n- Worker 实际耗时及独立墙钟等待：宿主未提供时记不可用，不估算\n- [执行记录与完整报告 Artifact](${context.runUrl})（保留 30 天）\n${report.failureReasons.map(reason => `- 未完成原因：${safe(reason)}\n`).join('')}\n${findings.length ? findings.join('\n\n') : report.status === '未完成' ? '审查未完成，不能据此认定未发现问题。' : '未发现已核实问题。'}\n`
}

export function renderRegion(report, commentUrl = null) {
  const complete = report.status === '已完成'
  const passed = report.conclusion === '通过' && ['已完成', '无需审查'].includes(report.status)
  return `<!-- ai-review:start -->\n- 审查状态：${report.status}\n- 审查结论：${report.conclusion}\n- 审查版本：${report.context.headSha}\n- 规则版本：${report.context.rulesHash}\n- 审查报告：${commentUrl ? `[机器人报告](${commentUrl})` : '待生成'}\n- 执行记录：[GitHub Actions](${report.context.runUrl})\n\n- [${commentUrl ? 'x' : ' '}] 当前提交的审查报告已发布\n- [${complete ? 'x' : ' '}] Standards 与五条 AI 规则全部完成\n- [${passed ? 'x' : ' '}] 无阻塞合并的问题\n<!-- ai-review:end -->`
}

export function updateBody(body, region) {
  body ??= ''
  const starts = [...body.matchAll(/<!-- ai-review:start -->/g)]
  const ends = [...body.matchAll(/<!-- ai-review:end -->/g)]
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0].index > ends[0].index) throw new Error('PR 机器人标记重复或不完整，请先修复标记')
    return body.slice(0, starts[0].index) + region + body.slice(ends[0].index + ends[0][0].length)
  }
  const heading = /^## 测试与验证\s*\r?$/m.exec(body)
  if (heading) {
    const offset = heading.index + heading[0].length
    return `${body.slice(0, offset)}\n\n${region}${body.slice(offset)}`
  }
  return `${body}${body ? '\n\n' : ''}## 测试与验证\n\n${region}\n`
}
