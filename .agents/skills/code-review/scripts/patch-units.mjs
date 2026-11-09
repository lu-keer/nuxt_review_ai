import { readFileSync } from 'node:fs'

// Byte offsets refer to the immutable per-file snapshot, never the live tree.
export function indexPatchUnits(layers) {
  return layers.flatMap((layer, layerIndex) => layer.filePatches.flatMap((block, blockIndex) => {
    const bytes = readFileSync(block.patchPath)
    const prefix = `${layer.kind}:${layerIndex}:${blockIndex}`
    const whole = () => [{ id: `${prefix}:file`, layer: layer.kind, layer_index: layerIndex, block_index: blockIndex,
      path: block.path, paths: block.paths, kind: 'file', offset: 0, length: bytes.length, header_bytes: 0,
      bytes: bytes.length, addedLines: block.addedLines, deletedLines: block.deletedLines }]
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return whole() }
    if ((block.paths?.length ?? 0) > 1 || /^[RC]/.test(block.status ?? '') || /^(rename |copy |similarity index |GIT binary patch|Binary files )/m.test(text)) return whole()
    const lines = []
    for (let offset = 0; offset < bytes.length;) {
      const newline = bytes.indexOf(10, offset)
      const end = newline === -1 ? bytes.length : newline + 1
      lines.push({ offset, text: bytes.subarray(offset, end).toString('utf8').replace(/\r?\n$/, '') })
      offset = end
    }
    const starts = lines.flatMap((line, i) => line.text.startsWith('@@') ? [i] : [])
    if (!starts.length) return whole()
    const headerBytes = lines[starts[0]].offset
    const header = bytes.subarray(0, headerBytes).toString('utf8')
    if (!/^diff --git /m.test(header) || !/^--- /m.test(header) || !/^\+\+\+ /m.test(header)) return whole()
    const result = []
    for (let i = 0; i < starts.length; i++) {
      const first = starts[i], last = starts[i + 1] ?? lines.length
      const match = lines[first].text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/)
      if (!match) return whole()
      let oldLines = 0, newLines = 0, addedLines = 0, deletedLines = 0
      for (const line of lines.slice(first + 1, last)) {
        if (line.text.startsWith(' ')) { oldLines++; newLines++ }
        else if (line.text.startsWith('+')) { newLines++; addedLines++ }
        else if (line.text.startsWith('-')) { oldLines++; deletedLines++ }
        else if (line.text !== '\\ No newline at end of file') return whole()
      }
      if (oldLines !== Number(match[2] ?? 1) || newLines !== Number(match[4] ?? 1)) return whole()
      const offset = lines[first].offset, end = lines[last]?.offset ?? bytes.length
      result.push({ id: `${prefix}:h${i}`, layer: layer.kind, layer_index: layerIndex, block_index: blockIndex,
        path: block.path, paths: block.paths, kind: 'hunk', offset, length: end - offset, header_bytes: headerBytes,
        bytes: headerBytes + end - offset, addedLines, deletedLines })
    }
    return result
  }))
}

export function selectPatchBytes(block, units) {
  const bytes = readFileSync(block.patchPath)
  if (units[0].kind === 'file') return bytes
  return Buffer.concat([bytes.subarray(0, units[0].header_bytes), ...units.map(unit => bytes.subarray(unit.offset, unit.offset + unit.length))])
}
