#!/usr/bin/env node
/**
 * Generate the `preset-standard` override that enforces the token policy.
 *
 * WHY THE PRESET AT ALL
 * ---------------------
 * In the `web` profile (the one DSH Desktop runs) the context-shaping plugins are
 * NOT host-plane rows. `dsh-web-app/cordis.patch.yml` disables the host copies and
 * `presets/standard.patch.yml` re-mounts them inside the `preset-standard` row:
 *
 *     compaction-basic, tool-result-pruner, tool-fs, tool-fs-search,
 *     tool-skill, agent-instructions, tool-subagent*, tool-workflow, tool-web
 *
 * A Cordis patch REPLACES a row's whole `config`; it does not deep-merge
 * (`dsh-app-boot/lib/index.js`). So reaching those rows means restating the whole
 * `plugins` list. Restating by hand is how you silently lose tools on the next
 * DSH upgrade, so this script reads the *installed* preset and re-emits it.
 *
 * WHY A CUSTOM EMITTER
 * --------------------
 * The shipped preset contains conditional rows:
 *
 *     - id: tool-bash
 *       disabled: !!js process.platform === 'win32'
 *
 * A plain YAML parse yields the STRING `"process.platform === 'win32'"`. Emitting
 * that as a normal scalar gives a truthy string, which would disable BOTH shell
 * tools and leave the agent unable to run a command. This emitter re-attaches the
 * `!!js` tag to any `disabled` scalar that came from a tagged expression, so the
 * expressions survive as expressions.
 *
 * Re-run after every DSH upgrade so newly shipped rows are carried through.
 *
 * @module bin/enforce-preset.mjs
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Locate the installed DSH app bundle. */
function appRoot() {
  if (process.env.DSH_APP_ROOT) return process.env.DSH_APP_ROOT
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (!base) continue
      const candidate = join(base, 'DSH Desktop', 'resources', 'app')
      if (existsSync(join(candidate, 'node_modules'))) return candidate
    }
  }
  return '/Applications/DSH Desktop.app/Contents/Resources/app'
}

/**
 * Tools that let one agent spawn more agents.
 *
 * This is the enforcement behind "no unrequested fan-out": prompt text is advice,
 * a `disabled: true` row is a tool that does not exist. AgentTeams still works
 * when you explicitly start it, because team members are spawned by the
 * `agent-teams` plugin through the `subagent` SERVICE, not through these tools.
 * The shipped `dsh-experimental-agent-team-profile` bundle disables the same
 * rows for the same reason.
 */
const DELEGATION_TOOLS = new Set([
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'workflow-ptc',
  'tool-workflow',
])

/**
 * `config` overrides per row id. Every key was checked against the plugin's own
 * schemastery `Config`, and every value against its validation rules.
 */
const CONFIG_EDITS = {
  // AGENTS.md + CLAUDE.md, re-sent on every request. Base 65536.
  'agent-instructions': { maxBytes: 16384 },

  // Invariant: headChars + marker(37) + tailChars <= thresholdChars, else the
  // plugin throws at mount. 1600 + 37 + 600 = 2237 <= 4096.
  'tool-result-pruner': { thresholdChars: 4096, headChars: 1600, tailChars: 600 },

  // Catalog lines ride a message that is re-sent every turn. Base 500/skill.
  'tool-skill': { catalogDescriptionMaxLength: 160 },

  // `sampleOverCapGlobResults` has NO schema default: omitting it fails the load.
  'tool-fs-search': {
    sampleOverCapGlobResults: false,
    globMaxResults: 40,
    grepMaxMatches: 80,
    grepMaxLineBytes: 800,
    searchMetaMaxBytes: 8192,
  },

  // One oversized read is re-sent on every later turn. Base 2000/2000/51200.
  'tool-fs': { readLimit: 500, readMaxLineLength: 800, readMaxBytes: 24576 },

  // `maxTokens` caps the summarizer's output (base = headroomTokens = 65536).
  // `retainRatio` must stay < `thresholdRatio`, or the plugin throws at mount.
  'compaction-basic': {
    auto: true,
    thresholdRatio: 0.75,
    headroomTokens: 65536,
    retainRatio: 0.1,
    maxTokens: 8192,
    compactionRetries: 0,
    maxOverflowRetries: 1,
  },

  'tool-web': {
    fetch: true,
    searchTimeoutMs: 60000,
    searchMaxResults: 4,
    searchMaxQueries: 2,
    fetchMaxOutputChars: 60000,
  },
}

/** Keys emitted as bare scalars when they are booleans/numbers. */
function renderScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * Render a value after a `key:` (or as a sequence item).
 *
 * Multi-line strings must use a literal block scalar. A single-quoted scalar
 * containing raw newlines is not valid YAML, and the shipped preset has several
 * (the plan-mode instructions, for one).
 *
 * @returns {{ inline: string|null, block: string[] }}
 */
function renderValueParts(value, keyIndent) {
  if (typeof value === 'string' && value.includes('\n')) {
    const pad = ' '.repeat(keyIndent + 2)
    const body = value.replace(/\n+$/, '').split('\n').map((line) => (line === '' ? '' : `${pad}${line}`))
    return { inline: '|', block: body }
  }
  return { inline: renderScalar(value), block: [] }
}

/**
 * Render one plugin row. `disabled` strings are JS expressions from a `!!js` tag.
 * @param {object} entry
 * @param {number} indent
 * @returns {string[]}
 */
function renderRow(entry, indent) {
  const pad = ' '.repeat(indent)
  const keys = Object.keys(entry).filter((key) => entry[key] !== undefined)
  const [head, ...rest] = keys
  const lines = []

  const renderValue = (key, value, keyIndent) => {
    const keyPad = ' '.repeat(keyIndent)
    if (key === 'disabled' && typeof value === 'string') {
      lines.push(`${keyPad}${key}: !!js ${value}`)
      return
    }
    if (Array.isArray(value)) {
      lines.push(`${keyPad}${key}:`)
      for (const item of value) {
        if (item !== null && typeof item === 'object') {
          const child = renderRow(item, keyIndent + 2)
          child[0] = `${' '.repeat(keyIndent + 2)}- ${child[0].trimStart()}`
          lines.push(...child)
        } else {
          const parts = renderValueParts(item, keyIndent + 2)
          lines.push(`${' '.repeat(keyIndent + 2)}- ${parts.inline}`)
          lines.push(...parts.block)
        }
      }
      return
    }
    if (value !== null && typeof value === 'object') {
      lines.push(`${keyPad}${key}:`)
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childValue !== undefined) renderValue(childKey, childValue, keyIndent + 2)
      }
      return
    }
    const parts = renderValueParts(value, keyIndent)
    lines.push(`${keyPad}${key}: ${parts.inline}`)
    lines.push(...parts.block)
  }

  // First key rides the `- ` bullet; the caller prepends it.
  if (head === 'disabled' && typeof entry[head] === 'string') {
    lines.push(`${pad}disabled: !!js ${entry[head]}`)
  } else if (entry[head] !== null && typeof entry[head] === 'object') {
    lines.push(`${pad}${head}:`)
    for (const [childKey, childValue] of Object.entries(entry[head])) {
      if (childValue !== undefined) renderValue(childKey, childValue, indent + 2)
    }
  } else {
    const parts = renderValueParts(entry[head], indent)
    lines.push(`${pad}${head}: ${parts.inline}`)
    lines.push(...parts.block)
  }
  for (const key of rest) renderValue(key, entry[key], indent + 2)
  return lines
}

/** Render the whole patch entry. */
function renderPatch(definition, edits, changes) {
  const lines = [
    '',
    '# ===========================================================================',
    '# TOKEN POLICY - restates the standard agent preset.',
    '# Generated by dsh-token-saver/bin/enforce-preset.mjs - do not hand-edit.',
    '#',
    '# These rows live inside the agent preset, not on the host plane, and a Cordis',
    '# patch replaces a row config wholesale - so the entire plugins list is',
    '# restated. RE-RUN THE GENERATOR AFTER EVERY DSH UPGRADE or newly shipped',
    '# tools will be missing.',
    '# ===========================================================================',
    '- id: preset-standard',
    '  config:',
    `    id: ${renderScalar(definition.id)}`,
    `    order: ${definition.order}`,
    '    plugins:',
  ]
  for (const entry of definition.plugins) {
    const row = renderRow(entry, 6)
    row[0] = `${' '.repeat(6)}- ${row[0].trimStart()}`
    lines.push(...row)
  }
  lines.push('')
  return lines
}

/** Apply the policy to a parsed preset definition. */
export function applyPolicy(definition) {
  const changes = []
  const plugins = structuredClone(definition.plugins)

  const walk = (list) => {
    for (const entry of list ?? []) {
      if (!entry || typeof entry !== 'object') continue

      if (DELEGATION_TOOLS.has(entry.id) && entry.disabled !== true) {
        entry.disabled = true
        changes.push(`${entry.id}: disabled (no unrequested fan-out)`)
      }

      const edits = CONFIG_EDITS[entry.id]
      if (edits) {
        entry.config = { ...(entry.config ?? {}), ...edits }
        changes.push(`${entry.id}: ${Object.keys(edits).join(', ')}`)
      }

      // `cordis:group` children live in `config` as an array.
      if (Array.isArray(entry.config)) walk(entry.config)
    }
  }
  walk(plugins)

  return { definition: { id: definition.id, order: definition.order, plugins }, changes }
}

async function main() {
  const root = appRoot()
  const presetFile = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  const yamlEntry = join(root, 'node_modules', 'yaml', 'dist', 'index.js')
  if (!existsSync(presetFile)) {
    console.error(`shipped preset not found: ${presetFile}`)
    console.error('Set DSH_APP_ROOT to your DSH app directory.')
    process.exitCode = 1
    return
  }

  const { parse } = await import(pathToFileURL(yamlEntry).href)
  const raw = readFileSync(presetFile, 'utf8')
  const document = parse(raw)
  const inserted = document.find((entry) => Array.isArray(entry?.insert))?.insert ?? []
  const row = inserted.find((entry) => entry?.id === 'preset-standard')
  if (!row) {
    console.error('shipped preset has no `preset-standard` row')
    process.exitCode = 1
    return
  }

  const { definition, changes } = applyPolicy(row.config)
  const lines = renderPatch(definition, CONFIG_EDITS, changes)

  // Round-trip guard: the emitted text must parse back to the same plugin count,
  // and every `!!js` expression from the source must still be present.
  const reparsed = parse(lines.join('\n'))
  const emitted = reparsed.find((entry) => entry?.id === 'preset-standard')
  if (!emitted) {
    console.error('ABORT: generated block does not reparse to a preset-standard row')
    process.exitCode = 1
    return
  }
  const count = (list) => (list ?? []).reduce((total, e) => total + 1 + (Array.isArray(e?.config) ? count(e.config) : 0), 0)
  const before = count(row.config.plugins)
  const after = count(emitted.config.plugins)
  const jsBefore = (raw.match(/!!js /g) ?? []).length
  const jsAfter = (lines.join('\n').match(/!!js /g) ?? []).length

  console.log(`shipped preset : ${presetFile}`)
  console.log(`plugin rows    : ${before} in, ${after} out`)
  console.log(`!!js exprs     : ${jsBefore} in, ${jsAfter} out`)
  console.log(`\nchanges:`)
  for (const change of changes) console.log(`  - ${change}`)

  if (before !== after || jsBefore !== jsAfter) {
    console.error('\nABORT: round-trip mismatch, nothing written.')
    process.exitCode = 1
    return
  }

  if (process.argv.includes('--dry-run')) {
    console.log('\n--- dry run, nothing written ---')
    return
  }

  const profile = process.argv.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length) ?? 'web'
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  const patchFile = join(home, 'profiles', profile, 'cordis.patch.yml')
  const blockFile = `${patchFile}.preset-block.yml`

  writeFileSync(blockFile, lines.join('\n'), 'utf8')
  console.log(`\nwrote ${blockFile}`)
  if (existsSync(patchFile)) {
    copyFileSync(patchFile, `${patchFile}.bak-preset`)
    console.log(`backup ${patchFile}.bak-preset`)
  }
  console.log('Append the block to the profile patch, then restart DSH.')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()