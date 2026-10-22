// Generates src/protocol/linkTypes.ts, the TypeScript types of the link protocol v1, from the JSON
// Schemas in protocol/v1 (protocol/v1/SPEC.md). The schemas are normative; the types follow them.
//
//   npm run protocol:types          writes the file
//   node scripts/gen-link-types.mjs --check    exits 1 if the file is stale
//
// test/frontend/protocol/linkTypes.test.ts also fails when the file is stale.
//
// It understands only the JSON Schema keywords the protocol uses (KEYWORDS below) and stops with
// an error on any other, so that a schema change the generator cannot express is noticed instead
// of being turned into a wrong type. Each schema or $defs entry with a `title` becomes a named,
// exported type. An object whose allOf holds only if/then branches on one property (the
// discriminator, for example an event's kind) becomes `Base & (A | B | ...)`, one member per set
// of discriminator values that the same branches apply to.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const SCHEMA_DIR = join(ROOT, 'protocol', 'v1')
export const OUTPUT = join(ROOT, 'src', 'protocol', 'linkTypes.ts')

const KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', '$comment', 'title', 'description', 'type', 'properties',
  'required', 'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'maxProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'enum', 'const', 'allOf', 'anyOf', 'if', 'then',
  'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'minLength', 'maxLength'
])
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const WIDTH = 100

/** @param {string} dir */
function loadSchemas(dir) {
  /** @type {Map<string, any>} */
  const byId = new Map()
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.schema.json')).sort()) {
    const schema = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    if (typeof schema.$id !== 'string') throw new Error(`${name}: no $id`)
    byId.set(schema.$id, schema)
  }
  return byId
}

/** Every keyword in a schema tree must be one the generator understands. */
function checkKeywords(node, where) {
  if (typeof node === 'boolean') return
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${where}: a schema must be an object or a boolean`)
  }
  for (const [key, value] of Object.entries(node)) {
    if (!KEYWORDS.has(key)) throw new Error(`${where}: keyword ${key} is not supported`)
    if (key === 'properties' || key === '$defs') {
      for (const [name, sub] of Object.entries(value)) checkKeywords(sub, `${where}/${key}/${name}`)
    } else if (key === 'allOf' || key === 'anyOf' || key === 'prefixItems') {
      value.forEach((sub, i) => checkKeywords(sub, `${where}/${key}/${i}`))
    } else if (['items', 'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'if',
      'then'].includes(key)) {
      checkKeywords(value, `${where}/${key}`)
    }
  }
}

/** JSDoc comment for a description, wrapped to the line width. */
function doc(text, indent) {
  if (!text) return ''
  const words = String(text).replaceAll('*/', '*\\/').split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    if (line && indent.length + 3 + line.length + 1 + word.length > WIDTH) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  if (lines.length === 1 && indent.length + 7 + lines[0].length <= WIDTH) {
    return `${indent}/** ${lines[0]} */\n`
  }
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`
}

/** A TypeScript literal type for a JSON value. */
function literal(value) {
  return typeof value === 'string' ? `'${value.replaceAll("'", "\\'")}'` : JSON.stringify(value)
}

const key = (name) => (IDENT.test(name) ? name : `'${name}'`)

/** `a | b | c`, or one alternative per line when the line would be too long. */
function union(parts, indent) {
  const flat = parts.join(' | ')
  if (indent.length + 30 + flat.length <= WIDTH) return flat
  return parts.map((part) => `\n${indent}  | ${part}`).join('')
}

class Generator {
  /** @param {Map<string, any>} schemas */
  constructor(schemas) {
    this.schemas = schemas
    /** @type {Map<any, string>} named type of each titled schema node */
    this.names = new Map()
    /** @type {string[]} */
    this.out = []
    /** @type {Set<any>} */
    this.emitted = new Set()
  }

  /** The schema a $ref points to, and the base id to resolve refs inside it. */
  resolve(ref, baseId) {
    const url = new URL(ref, baseId)
    const fileId = url.href.split('#')[0]
    const file = this.schemas.get(fileId)
    if (!file) throw new Error(`unresolved $ref ${ref} from ${baseId}`)
    let node = file
    for (const part of url.hash.replace(/^#\/?/, '').split('/').filter(Boolean)) {
      node = node[decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~')]
      if (node === undefined) throw new Error(`unresolved $ref ${ref} from ${baseId}`)
    }
    return { node, baseId: fileId }
  }

  /** The named type of a titled node, emitting its declaration the first time. */
  named(node, baseId) {
    if (!IDENT.test(node.title)) throw new Error(`title ${node.title} is not an identifier`)
    if (!this.emitted.has(node)) {
      const owner = this.names.get(node)
      if (owner && owner !== node.title) throw new Error(`two names for one schema: ${owner}`)
      for (const [other, name] of this.names) {
        if (name === node.title && other !== node) throw new Error(`two schemas named ${name}`)
      }
      this.names.set(node, node.title)
      this.emitted.add(node)
      this.declare(node, baseId)
    }
    return node.title
  }

  /** Emits `export interface` or `export type` for a titled node. */
  declare(node, baseId) {
    const head = doc(node.description, '')
    if (node.type === 'object' && !node.allOf && !this.isMap(node) && !this.isEmpty(node)) {
      this.out.push(`${head}export interface ${node.title} ${this.body(node, baseId, '')}\n`)
    } else if (node.type === 'object' && node.allOf) {
      this.out.push(head + this.discriminated(node, baseId))
    } else {
      this.out.push(`${head}export type ${node.title} = ${this.inline(node, baseId, '', true)}\n`)
    }
  }

  isMap(node) {
    return typeof node.additionalProperties === 'object' || node.propertyNames !== undefined
  }

  isEmpty(node) {
    return Object.keys(node.properties ?? {}).length === 0 && node.additionalProperties === false
  }

  /** `{ ...properties }` of an object schema. */
  body(node, baseId, indent) {
    const required = new Set(node.required ?? [])
    const lines = Object.entries(node.properties ?? {})
      .filter(([, sub]) => sub !== false)
      .map(([name, sub]) => this.field(name, sub, !required.has(name), `${indent}  `, baseId))
    return lines.length ? `{\n${lines.join('\n')}\n${indent}}` : '{}'
  }

  /** One property of an object type, with its JSDoc, at the given indent. */
  field(name, sub, optional, indent, baseId) {
    const type = this.inline(sub, baseId, indent)
    const description = typeof sub === 'object' ? sub.description : undefined
    const gap = type.startsWith('\n') ? '' : ' '
    return `${doc(description, indent)}${indent}${key(name)}${optional ? '?' : ''}:${gap}${type}`
  }

  /** A type expression for a schema node. `own`: the node is being declared under its title. */
  inline(node, baseId, indent, own = false) {
    if (node === true) return 'unknown'
    if (node === false) return 'never'
    if (node.title && !own) return this.named(node, baseId)
    if (node.$ref) {
      const target = this.resolve(node.$ref, baseId)
      return target.node.title
        ? this.named(target.node, target.baseId)
        : this.inline(target.node, target.baseId, indent)
    }
    if ('const' in node) return literal(node.const)
    if (node.enum) return union(node.enum.map(literal), indent)
    if (node.anyOf) return node.anyOf.map((sub) => this.inline(sub, baseId, indent)).join(' | ')
    switch (node.type) {
      case 'string': return 'string'
      case 'integer':
      case 'number': return 'number'
      case 'boolean': return 'boolean'
      case 'array': {
        if (node.prefixItems) {
          if (node.items !== false) throw new Error('prefixItems needs items: false')
          return `[${node.prefixItems.map((sub) => this.inline(sub, baseId, indent)).join(', ')}]`
        }
        const item = this.inline(node.items ?? true, baseId, indent)
        return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`
      }
      case 'object': {
        if (this.isMap(node)) {
          return `Record<string, ${this.inline(node.additionalProperties ?? true, baseId, indent)}>`
        }
        if (this.isEmpty(node)) return 'Record<string, never>'
        if (node.allOf) throw new Error('an object with allOf needs a title')
        return this.body(node, baseId, indent)
      }
      default:
        throw new Error(`no type for schema ${JSON.stringify(node).slice(0, 80)}`)
    }
  }

  /**
   * `export type T = TBase & (A | B ...)` for an object whose allOf branches all test one
   * discriminator property with const or enum.
   */
  discriminated(node, baseId) {
    let discriminator
    const branches = node.allOf.map((branch) => {
      const test = branch.if
      const names = Object.keys(test?.properties ?? {})
      if (!test || !branch.then || names.length !== 1 || Object.keys(branch).length !== 2) {
        throw new Error(`${node.title}: allOf may only hold if/then on one property`)
      }
      if (discriminator && discriminator !== names[0]) {
        throw new Error(`${node.title}: allOf tests two properties`)
      }
      discriminator = names[0]
      const condition = test.properties[discriminator]
      const values = 'const' in condition ? [condition.const] : condition.enum
      return { values, then: branch.then }
    })
    const own = node.properties[discriminator]
    const all = 'const' in own ? [own.const] : own.enum
    if (!all) throw new Error(`${node.title}: ${discriminator} must be an enum`)
    // values that the same branches apply to share one member
    const groups = new Map()
    for (const value of all) {
      const applying = branches.filter((b) => b.values.includes(value))
      const id = applying.map((b) => branches.indexOf(b)).join(',')
      if (!groups.has(id)) groups.set(id, { values: [], applying })
      groups.get(id).values.push(value)
    }
    const base = `${node.title}Base`
    const baseNode = { ...node, title: base, allOf: undefined, description: undefined }
    delete baseNode.allOf
    this.out.push(`export interface ${base} ${this.body(baseNode, baseId, '')}\n`)
    const members = []
    const indent = '      '
    for (const { values, applying } of groups.values()) {
      const parts = []
      const fields = [`${indent}${key(discriminator)}: ${values.map(literal).join(' | ')}`]
      for (const { then } of applying) {
        if (then.$ref) {
          const target = this.resolve(then.$ref, baseId)
          if (!target.node.title) throw new Error(`${node.title}: a then $ref needs a title`)
          parts.push(this.named(target.node, target.baseId))
          continue
        }
        const required = new Set(then.required ?? [])
        for (const [name, sub] of Object.entries(then.properties ?? {})) {
          fields.push(this.field(name, sub, !required.has(name), indent, baseId))
          required.delete(name)
        }
        // required by the branch, defined (and documented) in the base
        for (const name of required) {
          const sub = node.properties[name]
          if (!sub) throw new Error(`${node.title}: required ${name} is not a property`)
          fields.push(this.field(name, { ...sub, description: undefined }, false, indent, baseId))
        }
      }
      const object = fields.length === 1
        ? `{ ${fields[0].trim()} }`
        : `{\n${fields.join('\n')}\n    }`
      members.push([object, ...parts].join(' & '))
    }
    const alternatives = members.map((m) => `  | ${m}`).join('\n')
    return `export type ${node.title} = ${base} & (\n${alternatives}\n)\n`
  }
}

/**
 * The text of src/protocol/linkTypes.ts for the schemas in `dir`.
 * @param {string} [dir]
 */
export function generateLinkTypes(dir = SCHEMA_DIR) {
  const schemas = loadSchemas(dir)
  for (const [id, schema] of schemas) checkKeywords(schema, id)
  const gen = new Generator(schemas)
  const common = [...schemas.values()].find((s) => s.$id.endsWith('/common.schema.json'))
  const message = [...schemas.values()].find((s) => s.$id.endsWith('/message.schema.json'))
  if (!common || !message) throw new Error('common.schema.json or message.schema.json missing')
  for (const def of Object.values(common.$defs)) if (def.title) gen.named(def, common.$id)
  const types = []
  for (const branch of message.allOf) {
    const target = gen.resolve(branch.then.$ref, message.$id)
    types.push(gen.named(target.node, target.baseId))
  }
  const header = [
    '// Generated from protocol/v1/*.schema.json by scripts/gen-link-types.mjs: do not edit.',
    '// Regenerate with `npm run protocol:types`; test/frontend/protocol/linkTypes.test.ts fails',
    '// when this file is stale. The schemas are normative (protocol/v1/SPEC.md); these types',
    '// do not express their patterns and ranges, so validate with src/protocol/validate.js.',
    ''
  ].join('\n')
  const tail = [
    doc(message.description, ''),
    `export type ${message.title} =\n${types.map((t) => `  | ${t}`).join('\n')}\n`,
    '\n/** The message types of version 1. */\n',
    `export type LinkMessageType = ${message.title}['type']\n`,
    '\n/** The message of one type, for example MessageOfType<\'event\'>. */\n',
    'export type MessageOfType<T extends LinkMessageType> =\n',
    `  Extract<${message.title}, { type: T }>\n`
  ].join('')
  return `${header}\n${gen.out.join('\n')}\n${tail}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = generateLinkTypes()
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT, 'utf8')
    if (current !== text) {
      console.error('src/protocol/linkTypes.ts is stale: run npm run protocol:types')
      process.exit(1)
    }
    console.log('src/protocol/linkTypes.ts is up to date')
  } else {
    writeFileSync(OUTPUT, text)
    console.log(`wrote ${OUTPUT}`)
  }
}
