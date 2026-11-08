#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findAppRoot, listProfiles, profileDir, profilePatchPath, readFileText } from '../src/paths.mjs'

async function main() {
  const app = findAppRoot()
  if (!app) throw new Error('DSH app bundle not found')
  const { parse } = await import(pathToFileURL(join(app.appRoot, 'node_modules', 'yaml', 'dist', 'index.js')).href)
  let checked = 0

  for (const profile of listProfiles()) {
    const patch = readFileText(profilePatchPath(profile))
    if (patch === null) continue
    const rows = parse(patch.replace(/!!js\s+/g, ''))
    const cap = rows.filter((row) => row?.id === 'subagent').at(-1)
    if (cap?.config?.maxActiveSubagents !== 1 || cap?.config?.maxDepth !== 1) {
      throw new Error(`${profile}: subagent limits are not capped at depth 1 / concurrency 1`)
    }
    const plugin = join(profileDir(profile), 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json')
    if (existsSync(plugin)) {
      const policy = rows.filter((row) => row?.id === 'agent-teams').at(-1)
      if (policy?.disabled !== true) throw new Error(`${profile}: AgentTeams is not disabled`)
      console.log(`OK ${profile}: cap=1, AgentTeams disabled`)
    } else {
      console.log(`OK ${profile}: cap=1`)
    }
    checked += 1
  }

  if (checked === 0) throw new Error('No DSH profiles with cordis.patch.yml found')
  console.log(`RESULT: PASS (${checked} profile(s))`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
