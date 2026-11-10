import { rules } from './common.mjs'
import { join } from 'node:path'
import { rulePath } from './validate-report.mjs'

// Consume only native host events, never agent_message text, shell output or a
// model-authored evidence file. Unsupported host transports fail closed.
export function extractEvidence(log, snapshot, trustedRoot) {
  const spawns = new Map()
  const terminal = new Map()
  for (const line of log.split('\n')) {
    // GitHub job log records start with an ISO timestamp; raw JSONL is also accepted.
    const raw = line.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim()
    if (!raw.startsWith('{')) continue
    let event
    try { event = JSON.parse(raw) } catch { continue }
    const item = event.item
    if (event.type !== 'item.completed' || item?.type !== 'collab_tool_call' || item.status !== 'completed') continue
    if (item.tool === 'spawn_agent' && item.receiver_thread_ids?.length === 1) {
      const id = item.receiver_thread_ids[0]
      const prompt = item.prompt ?? ''
      const matching = rules.filter(rule => prompt.includes(`[review-rule:${rule}]`))
      if (matching.length !== 1 || !prompt.includes(snapshot.manifestPath) || !prompt.includes(snapshot.snapshotId)) continue
      if (trustedRoot && !prompt.includes(join(trustedRoot, '.agents/skills/code-review', rulePath(matching[0])))) continue
      if (spawns.has(id)) continue
      spawns.set(id, { rule: matching[0], taskId: id, spawnEventId: item.id })
    }
    if (['wait', 'close_agent'].includes(item.tool)) {
      for (const [id, state] of Object.entries(item.agents_states ?? {})) {
        if (['completed', 'errored', 'interrupted', 'shutdown', 'not_found'].includes(state.status)) {
          // A later close/shutdown must not erase a previously confirmed result.
          if (!terminal.has(id) || terminal.get(id).status !== 'completed') {
            terminal.set(id, { status: state.status, output: state.message ?? null, terminalEventId: item.id })
          }
        }
      }
    }
  }
  return [...spawns.values()].map(spawn => ({ ...spawn, ...(terminal.get(spawn.taskId) ?? { status: 'unknown', output: null, terminalEventId: null }) }))
}
