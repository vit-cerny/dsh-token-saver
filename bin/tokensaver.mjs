#!/usr/bin/env node
/**
 * tokensaver â€” one entry point to turn the DSH token policy on, off, or inspect it.
 *
 *   node bin/tokensaver.mjs on       apply the policy (backs up first)
 *   node bin/tokensaver.mjs off      return to DSH defaults (delegation back on)
 *   node bin/tokensaver.mjs status   run both verifiers
 *   node bin/tokensaver.mjs teams    show the teams gate state
 *
 * Everything is text-level on purpose: the patches contain `!!js` expressions and
 * block scalars that a YAML round-trip would corrupt (see teams.mjs).
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, listProfiles, profilePatchPath, readFileText } from '../src/paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const run = (script, args = []) => {
  const r = spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8' })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  return r.status ?? 1
}

const STAMP = '.token-saver-backup'
function backupOnce(profile, file) {
  const dir = join(dshHome(), STAMP)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${profile}${STAMP}.yml`)
  if (!existsSync(dest)) {
    copyFileSync(file, dest)
    console.log(`  backup ${profile} -> ${dest}`)
  }
}

/** Text-level row flag flip: set or clear `disabled:` on one `- id:` row. */
function setRowDisabled(text, id, disabled) {
  const lines = text.split(/\r?\n/)
  const re = new RegExp(`^(\\s*)- id:\\s*'?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?\\s*$`)
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue
    const indent = lines[i].match(/^(\s*)/)[1]
    // find the row's block end
    let end = i + 1
    while (end < lines.length) {
      const l = lines[end]
      if (l.trim() && !l.startsWith(indent + ' ') && !l.startsWith(indent + '\t')) break
      end++
    }
    const block = lines.slice(i, end)
    const has = block.findIndex((l) => /^\s+disabled:/.test(l))
    if (disabled) {
      if (has >= 0) block[has] = `${indent}  disabled: true`
      else block.splice(1, 0, `${indent}  disabled: true`)
    } else if (has >= 0) {
      block.splice(has, 1)
    }
    lines.splice(i, end - i, ...block)
    return { text: lines.join('\n'), changed: true }
  }
  return { text, changed: false }
}

function cmdOn() {
  console.log('applying token policy')
  for (const p of listProfiles()) {
    const f = profilePatchPath(p)
    if (existsSync(f)) backupOnce(p, f)
  }
  let rc = run('apply-all.mjs')
  rc = run('enforce-preset.mjs') || rc
  rc = run('apply-preset.mjs') || rc
  rc = run('teams.mjs', ['off']) || rc
  console.log(rc === 0 ? 'done â€” restart DSH' : 'finished with errors')
  return rc
}

function cmdOff() {
  console.log('restoring DSH defaults')
  // A snapshot taken by `on` is the most faithful rollback; fall back to flag flips.
  for (const p of listProfiles()) {
    const snap = join(dshHome(), STAMP, `${p}${STAMP}.yml`)
    const live = profilePatchPath(p)
    if (existsSync(snap) && existsSync(live)) {
      copyFileSync(snap, live)
      console.log(`  ${p}: restored from snapshot`)
    }
  }
  let rc = 0
  for (const p of listProfiles()) {
    const f = profilePatchPath(p)
    if (!existsSync(f)) continue
    let text = readFileText(f)
    let any = false
    for (const id of ['spill-policy', 'repeat-tool-reminder', 'session-title-llm']) {
      const r = setRowDisabled(text, id, true)
      if (r.changed) { text = r.text; any = true }
    }
    const hc = setRowDisabled(text, 'harness-dev-context', false)
    if (hc.changed) { text = hc.text; any = true }
    // desktop tools back to eager, as shipped
    if (/toolPreset:\s*lazy/.test(text)) {
      text = text.replace(/toolPreset:\s*lazy/g, 'toolPreset: full')
      any = true
    }
    if (any) {
      writeFileSync(f, text)
      console.log(`  ${p}: savers off`)
    }
  }
  rc = run('teams.mjs', ['on']) || rc
  console.log(rc === 0 ? 'done â€” restart DSH' : 'finished with errors')
  return rc
}

function cmdStatus() {
  const a = run('verify.mjs')
  const b = run('verify-agent-teams.mjs')
  return a || b
}

const cmd = process.argv[2] ?? 'status'
const rc =
  cmd === 'on' ? cmdOn()
  : cmd === 'off' ? cmdOff()
  : cmd === 'teams' ? run('teams.mjs')
  : cmd === 'status' ? cmdStatus()
  : (console.log('usage: tokensaver <on|off|status|teams>'), 2)
process.exit(rc)