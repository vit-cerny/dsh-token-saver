#!/usr/bin/env node
/**
 * Turn Agent Teams / subagents on or off for a profile.
 *
 * Default is OFF: the gate rows ship disabled so no agent can spawn a team or a
 * subagent unless a human asks. When you *do* want them, this flips exactly the
 * spawn gate and leaves every cap in place (`maxActiveSubagents`, `maxMembers`),
 * so an explicit request stays bounded instead of becoming a 78M-token run.
 *
 * Note: the profile patch is read at startup. Restart DSH after toggling.
 *
 * @module bin/teams.mjs
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Rows that gate agent spawning, in the order they are written. */
const GATES = ['tool-agent-team', 'agent-team', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'workflow-ptc']

/**
 * Rewrite the gate rows in a patch so they are disabled (off) or un-disabled (on).
 *
 * Text-level on purpose: the patch contains `!!js` expressions and block scalars
 * that a YAML round-trip would corrupt (a `!!js` expression re-emitted as a
 * string is truthy, which would disable the wrong rows).
 *
 * @param {string} text
 * @param {boolean} enabled
 * @returns {{ text: string, changed: string[] }}
 */
export function setGates(text, enabled) {
  const lines = text.split(/\r?\n/)
  const changed = []
  const out = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = /^-\s+id:\s*(\S+)\s*$/.exec(line)
    out.push(line)
    if (!match || !GATES.includes(match[1])) continue

    // Collect this row's body so `disabled:` can be inserted or removed.
    let end = index + 1
    while (end < lines.length && /^\s+\S/.test(lines[end]) && !/^-\s/.test(lines[end])) end += 1
    const body = lines.slice(index + 1, end)
    const disabledAt = body.findIndex((entry) => /^\s+disabled:\s*true\s*$/.test(entry))

    if (!enabled && disabledAt === -1) {
      body.unshift('  disabled: true')
      changed.push(`${match[1]}: off`)
    } else if (enabled && disabledAt !== -1) {
      body.splice(disabledAt, 1)
      changed.push(`${match[1]}: on`)
    }

    out.push(...body)
    index = end - 1
  }

  return { text: out.join('\n'), changed }
}

function main() {
  const mode = process.argv.find((arg) => arg === 'on' || arg === 'off')
  const profile = process.argv.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length) ?? 'web'
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  const patch = join(home, 'profiles', profile, 'cordis.patch.yml')

  if (mode === undefined) {
    const text = existsSync(patch) ? readFileSync(patch, 'utf8') : ''
    const state = GATES.map((id) => {
      const row = new RegExp(`-\\s+id:\\s*${id}\\s*\\n(?:\\s+[^\\n]*\\n)*?\\s+disabled:\\s*true`)
      return `${id}=${row.test(text) ? 'off' : 'on'}`
    })
    console.log(`profile ${profile}: ${state.join('  ')}`)
    console.log('usage: dsh-token-saver-teams on|off [--profile=web]')
    return
  }

  if (!existsSync(patch)) {
    console.error(`patch not found: ${patch}`)
    process.exitCode = 1
    return
  }

  const before = readFileSync(patch, 'utf8')
  const { text, changed } = setGates(before, mode === 'on')

  if (changed.length === 0) {
    console.log(`profile ${profile}: nothing to change (already ${mode})`)
    return
  }

  copyFileSync(patch, `${patch}.bak-teams`)
  writeFileSync(patch, text, 'utf8')
  console.log(`profile ${profile}: ${changed.join(', ')}`)
  console.log(`backup: ${patch}.bak-teams`)
  console.log('Restart DSH for the change to take effect.')
}

main()