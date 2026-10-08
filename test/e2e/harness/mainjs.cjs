'use strict'
// Reads top-level blocks of the app's electron/main.js by source text, so that the e2e harnesses run
// the app's own backend start/stop and quit code instead of a copy of it. main.js is an ES module
// with side effects (it creates windows and starts the backend on import), so it cannot simply be
// imported; the harnesses evaluate the blocks they need in their own scope instead.
//
// A block starts at a line that begins with the given text (column 0) and ends at the next line that
// is "}" or "})" at column 0. If main.js is restructured so that a block is no longer found, the
// harness stops with an error naming it: update the start text here and in the harness.
const fs = require('fs')
const path = require('path')

function readMainJs (repoRoot) {
  const file = path.join(repoRoot, 'electron', 'main.js')
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
  return { file, lines }
}

function balanced (s) {
  const t = s.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
  return (t.match(/[({[]/g) || []).length === (t.match(/[)}\]]/g) || []).length
}

// The top-level statement that starts at line i
function blockAt (src, i) {
  const { lines, file } = src
  if (balanced(lines[i])) return lines[i]
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\}\)?;?\s*$/.test(lines[j])) return lines.slice(i, j + 1).join('\n')
  }
  throw new Error(`unterminated block at ${file}:${i + 1}`)
}

// The block whose first line starts with `start`; null if optional and absent
function grab (src, start, optional = false) {
  const i = src.lines.findIndex(l => l.startsWith(start))
  if (i < 0) {
    if (optional) return null
    throw new Error(`not found in ${src.file}: a line starting with ${JSON.stringify(start)}`)
  }
  return blockAt(src, i)
}

// Every top-level ipcMain.handle / ipcMain.on registration
function ipcBlocks (src) {
  const out = []
  src.lines.forEach((l, i) => {
    const m = /^ipcMain\.(handle|on)\('([^']+)'/.exec(l)
    if (m) out.push({ kind: m[1], channel: m[2], code: blockAt(src, i) })
  })
  return out
}

module.exports = { readMainJs, grab, ipcBlocks }
