import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.env.USERPROFILE
const app = join(process.env.ProgramFiles, 'DSH Desktop', 'resources', 'app')

async function main() {
  const { parse } = await import(pathToFileURL(join(app, 'node_modules', 'yaml', 'dist', 'index.js')).href)
  const patch = readFileSync(join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  const rows = parse(patch.replace(/!!js\s+/g, ''))
  const preset = rows.find((r) => r && r.id === 'preset-standard')
  const plugins = preset.config.plugins
  const flat = []
  const walk = (list) => { for (const p of list) { flat.push(p); if (Array.isArray(p.config)) walk(p.config) } }
  walk(plugins)
  const by = Object.fromEntries(flat.map((p) => [p.id, p]))
  const checks = [
    ['preset parsed', Array.isArray(rows) && rows.length > 0],
    ['agent-instructions maxBytes 16384', by['agent-instructions']?.config?.maxBytes === 16384],
    ['tool-skill catalogDescriptionMaxLength 160', by['tool-skill']?.config?.catalogDescriptionMaxLength === 160],
    ['compaction maxTokens 8192', by['compaction-basic']?.config?.maxTokens === 8192],
    ['compaction auto true', by['compaction-basic']?.config?.auto === true],
    ['result-pruner thresholdChars 4096', by['tool-result-pruner']?.config?.thresholdChars === 4096],
    ['tool-subagent disabled', by['tool-subagent']?.disabled === true],
    ['tool-workflow disabled', by['tool-workflow']?.disabled === true],
    ['tool-fs readMaxBytes capped', (by['tool-fs']?.config?.readMaxBytes ?? 0) > 0],
    ['tool-web fetchMaxOutputChars capped', (by['tool-web']?.config?.fetchMaxOutputChars ?? 0) > 0],
  ]
  let bad = 0
  for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`) }

  // Duplicate top-level ids are not fatal (Cordis keeps the last row), but they mean an
  // older hand-patch overlapped a generated one. Surface it instead of hiding it.
  const ids = rows.map((r) => r?.id).filter(Boolean)
  const dup = [...new Set(ids.filter((id) => ids.indexOf(id) !== ids.lastIndexOf(id)))]
  if (dup.length) console.log(`WARN duplicate top-level ids: ${dup.join(', ')} (harmless, last row wins)`)
  console.log(`\nplugin rows: ${flat.length}`)
  console.log(bad === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${bad})`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e.message); process.exit(1) })
