#!/usr/bin/env node
/**
 * Apply the host-plane token policy to every DSH profile.
 *
 * WHY EVERY PROFILE
 * -----------------
 * `~/.dsh/AGENTS.md` and the skill frontmatter gates are global: they load the
 * same way whatever profile starts. Configuration is not. Each profile has its
 * own `cordis.patch.yml`, and a profile you never patch keeps the stock,
 * expensive defaults even though the policy file claims otherwise.
 *
 * The `web` profile is special: its tools live inside the `preset-standard`
 * preset and are handled by `enforce-preset.mjs`. Every other bundle
 * (`dsh-sdk-app`, `dsh-headless`, `dsh-acp-app`, `dsh-base`) mounts the same
 * plugins on the host plane, where a plain `- id:` row works.
 *
 * Generated profiles get a note: `dsh-cli` rewrites its patch from the desktop
 * profile, so appending here is lost on `node scripts/install-profile.mjs`
 * unless the row ids are also in that script's COPIED_ROWS list.
 *
 * @module bin/apply-all.mjs
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Profiles whose patch is generated from another profile and must not be edited. */
const GENERATED_PROFILES = new Set(['dsh-cli', 'dsh-cli-acp'])

/** Marker used to make the append idempotent. */
const MARKER = '# TOKEN POLICY (dsh-token-saver)'
const TEAM_MARKER = '# DSH TOKEN POLICY: AgentTeams disabled by default'
const CAP_MARKER = '# DSH TOKEN POLICY: subagent cap set to 1'

/** Plugin packages live inside the installed app bundle. */
const APP_NODE_MODULES = join(
  process.env.DSH_APP_ROOT
    ?? (process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DSH Desktop', 'resources', 'app')
      : '/Applications/DSH Desktop.app/Contents/Resources/app'),
  'node_modules',
)

/** Only exclude the profile-local dependency directory from profile discovery. */
const SKIP = new Set(['node_modules'])

function home() {
  return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

function listProfiles() {
  const dir = join(home(), 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
    .map((entry) => entry.name)
}

/**
 * Whether a patch file is an empty list (`[]`), which must be replaced rather
 * than appended to — `[]` followed by `- id: ...` is invalid YAML.
 * @param {string} text
 */
function isEmptyList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .every((line) => line === '[]' || line === '---')
}

/**
 * Whether a profile composes agents from presets.
 *
 * `@deepseek-ai/dsh-web-app` disables the host copies of the token-relevant
 * plugins and re-mounts them inside `preset-standard`. A host-plane `- id:` row
 * in such a profile hits the DISABLED row and is a silent no-op, so those
 * profiles need `enforce-preset.mjs` instead.
 *
 * @param {string} profile
 * @returns {boolean}
 */
function usesPresets(profile) {
  const manifest = join(home(), 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    const bundles = JSON.parse(readFileSync(manifest, 'utf8'))?.dsh?.profile?.bundles ?? []
    return bundles.includes('@deepseek-ai/dsh-web-app')
  } catch {
    return false
  }
}

/** Whether this profile has the separate AgentTeams spawn service installed. */
function hasAgentTeams(profile) {
  return existsSync(join(home(), 'profiles', profile, 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'))
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const fragmentPath = join(import.meta.dirname ?? '.', '..', 'fragments', 'host-plane.yml')
  const teamFragmentPath = join(import.meta.dirname ?? '.', '..', 'fragments', 'agent-teams.yml')
  const capFragmentPath = join(import.meta.dirname ?? '.', '..', 'fragments', 'subagent-cap.yml')
  if (!existsSync(fragmentPath)) {
    console.error(`fragment not found: ${fragmentPath}`)
    process.exitCode = 1
    return
  }
  if (!existsSync(teamFragmentPath)) {
    console.error(`fragment not found: ${teamFragmentPath}`)
    process.exitCode = 1
    return
  }
  if (!existsSync(capFragmentPath)) {
    console.error(`fragment not found: ${capFragmentPath}`)
    process.exitCode = 1
    return
  }
  // A BOM anywhere but the very start of a YAML stream is a parse error. Strip it
  // once here, and never write it back: a BOM prefixing an appended fragment is
  // enough to make every profile patch fail to parse.
  const fragment = readFileSync(fragmentPath, 'utf8').replace(/^\uFEFF/, '').trimEnd()
  const teamFragment = readFileSync(teamFragmentPath, 'utf8').replace(/^\uFEFF/, '').trimEnd()
  const capFragment = readFileSync(capFragmentPath, 'utf8').replace(/^\uFEFF/, '').trimEnd()

  // Refuse to write anything that does not parse, so a bad edit cannot leave a
  // profile that fails to boot.
  const { parse } = await import(pathToFileURL(join(APP_NODE_MODULES, 'yaml', 'dist', 'index.js')).href)
  const assertParses = (text, label) => {
    try {
      parse(text.replace(/!!js\s+/g, ''))
    } catch (error) {
      throw new Error(`${label} does not parse as YAML: ${error.message.split('\n')[0]}`)
    }
  }
  assertParses(fragment, 'fragment')
  assertParses(teamFragment, 'AgentTeams fragment')
  assertParses(capFragment, 'subagent cap fragment')

  console.log(`fragments: ${fragmentPath}, ${teamFragmentPath}, ${capFragmentPath}\n`)
  let changed = 0

  for (const profile of listProfiles()) {
    const patchPath = join(home(), 'profiles', profile, 'cordis.patch.yml')
    const label = profile.padEnd(16)

    if (!existsSync(patchPath)) {
      console.log(`${label} no cordis.patch.yml, skipped`)
      continue
    }

    const text = readFileSync(patchPath, 'utf8')

    const hasHostPolicy = text.includes(MARKER)
    const hasTeamPolicy = text.includes(TEAM_MARKER)
    const hasCapPolicy = text.includes(CAP_MARKER)
    const teamInstalled = hasAgentTeams(profile)
    if (hasHostPolicy && hasCapPolicy && (hasTeamPolicy || !teamInstalled)) {
      console.log(`${label} already patched`)
      continue
    }

    const generated = GENERATED_PROFILES.has(profile)
    const presetProfile = usesPresets(profile)
    const blocks = []
    if (!hasHostPolicy && !generated && !presetProfile) blocks.push(fragment)
    if (!hasCapPolicy) blocks.push(capFragment)
    if (!hasTeamPolicy && teamInstalled) blocks.push(teamFragment)

    if (!hasHostPolicy && generated) {
      console.log(`${label} GENERATED from desktop; host policy skipped (re-run dsh-cli/scripts/install-profile.mjs after desktop changes)`)
    } else if (!hasHostPolicy && presetProfile) {
      console.log(`${label} uses presets; host token rows are handled by enforce-preset.mjs`)
    }
    if (blocks.length === 0) {
      console.log(`${label} no applicable rows, skipped`)
      continue
    }

    // `[]` is a complete empty sequence: appending `- id:` after it is invalid
    // YAML. Replace it; for a real patch, keep existing rows and append.
    const base = isEmptyList(text) ? '' : text.trimEnd()
    const next = base === '' ? `${blocks.join('\n\n')}\n` : `${base}\n\n${blocks.join('\n\n')}\n`
    try {
      assertParses(next, profile)
    } catch (error) {
      console.error(`${label} SKIPPED: ${error.message}`)
      continue
    }

    const labels = blocks.map((block) => block.includes(TEAM_MARKER)
      ? 'AgentTeams gate'
      : block.includes(CAP_MARKER) ? 'subagent cap' : 'host token policy')
    console.log(`${label} append ${labels.join(' + ')} (${isEmptyList(text) ? 'empty patch' : 'existing patch'})`)
    changed += 1

    if (dryRun) continue
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(patchPath, `${patchPath}.bak-tokensaver-${stamp}`)
    writeFileSync(patchPath, next, 'utf8')
  }

  console.log(`\n${changed} profile(s) ${dryRun ? 'would be ' : ''}updated`)
  if (dryRun) console.log('dry run: nothing written')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
