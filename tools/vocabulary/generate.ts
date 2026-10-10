// Writes the files generated from the task vocabulary (schema/vocabulary.json, ADR-0005 F5), or
// checks that they are up to date. The rules and the generated text are in vocabulary.ts.
//
//   npm run vocabulary              write schema/generated/vocabulary.schema.json,
//                                   src/task/vocabulary.generated.ts, threemaze/core/vocabulary.py
//   npm run vocabulary -- --check   write nothing; exit 1 if a file is missing or stale
//   ... --vocabulary <file>         read another vocabulary file (with --check only: tests)
//   (= node --experimental-strip-types tools/vocabulary/generate.ts ...; Node 22.6 or newer)
//
// Exit code: 0 done (or up to date), 1 the vocabulary has problems (over ADR-0002's budget, for
// example) or a generated file is stale, 2 bad arguments or an unreadable file.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderOutputs, VOCABULARY_PATH } from './vocabulary.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Text as committed: git may check text files out with CRLF line ends. */
const normalize = (text: string) => text.replace(/\r\n/g, '\n')

function main(argv: string[]): number {
  let check = false
  let vocabularyFile: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') check = true
    else if (arg === '--vocabulary' && i + 1 < argv.length) vocabularyFile = argv[++i]!
    else {
      console.error(`unknown argument: ${arg}\nusage: generate.ts [--check] [--vocabulary <file>]`)
      return 2
    }
  }
  if (vocabularyFile !== null && !check) {
    console.error(`--vocabulary is only for --check: the generated files come from ${VOCABULARY_PATH}`)
    return 2
  }
  const source = vocabularyFile ?? path.join(ROOT, VOCABULARY_PATH)
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(source, 'utf8'))
  } catch (err) {
    console.error(`cannot read ${source}: ${(err as Error).message}`)
    return 2
  }
  let outputs: Map<string, string>
  try {
    outputs = renderOutputs(value)
  } catch (err) {
    console.error(`${source}: ${(err as Error).message}`)
    return 1
  }
  const stale: string[] = []
  for (const [relative, text] of outputs) {
    const file = path.join(ROOT, relative)
    const current = fs.existsSync(file) ? normalize(fs.readFileSync(file, 'utf8')) : null
    if (current === text) continue
    if (check) {
      stale.push(relative)
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
      console.log(`wrote ${relative}`)
    }
  }
  if (stale.length) {
    console.error(`stale or missing (run \`npm run vocabulary\`): ${stale.join(', ')}`)
    return 1
  }
  if (check) console.log(`up to date: ${[...outputs.keys()].join(', ')}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
