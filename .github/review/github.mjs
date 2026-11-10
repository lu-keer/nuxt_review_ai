export function githubClient({ token = process.env.GH_TOKEN, api = process.env.GITHUB_API_URL ?? 'https://api.github.com', fetchImpl = fetch } = {}) {
  if (!token) throw new Error('缺少 GitHub Token')
  return async (method, path, body, { text = false, limit = 20 * 1024 * 1024 } = {}) => {
    const response = await fetchImpl(`${api}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`GitHub ${method} ${path} 失败：HTTP ${response.status}`)
    // Enforce a streamed limit rather than trusting Content-Length.
    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      length += chunk.length
      if (length > limit) throw new Error('GitHub 响应过大')
      chunks.push(chunk)
    }
    const data = Buffer.concat(chunks).toString('utf8')
    return text ? data : data ? JSON.parse(data) : null
  }
}

export async function allPages(api, path) {
  const values = []
  for (let page = 1; page <= 100; page++) {
    const data = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    const entries = Array.isArray(data) ? data : data.jobs
    if (!Array.isArray(entries)) throw new Error('GitHub 分页结果无效')
    values.push(...entries)
    if (entries.length < 100) return values
  }
  throw new Error('GitHub 分页超过安全上限')
}

export async function currentPull(api, context) {
  const pr = await api('GET', `/repos/${context.repository}/pulls/${context.pr}`)
  if (pr.state !== 'open' || pr.head?.repo?.full_name !== context.repository || pr.base?.repo?.full_name !== context.repository
    || pr.head.sha !== context.headSha || pr.base.sha !== context.baseSha || pr.base.sha !== context.trustedSha) return null
  return pr
}
