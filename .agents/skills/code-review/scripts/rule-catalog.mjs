import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
export const skillDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
export function discoverRuleCatalog(root = skillDirectory) {
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
  const catalogs = [...skill.matchAll(/<!-- ai-rule-catalog:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- ai-rule-catalog:end -->/g)]
  if (catalogs.length !== 1) throw new Error('SKILL.md 必须包含唯一的规则适用目录 JSON 区块')
  const descriptions = JSON.parse(catalogs[0][1])
  if (!descriptions || typeof descriptions !== 'object' || Array.isArray(descriptions)) throw new Error('规则适用目录必须是 JSON 对象')
  const files = readdirSync(join(root, 'references/ai_review_rules'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name).sort()
  for (const file of Object.keys(descriptions)) if (!files.includes(file)) throw new Error(`规则文件缺失：${file}`)
  for (const file of files) {
    if (typeof descriptions[file] !== 'string' || !descriptions[file].trim()) throw new Error(`规则缺少适用说明：${file}`)
  }
  return files.map(file => ({ path: `references/ai_review_rules/${file}`, applicability: descriptions[file], required: false }))
}
