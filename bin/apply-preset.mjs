#!/usr/bin/env node
/**
 * apply-preset — install the generated `preset-standard` block into a profile patch.
 *
 * enforce-preset.mjs writes `cordis.patch.yml.preset-block.yml` and asks you to append it
 * by hand. Appending would create a second `preset-standard` row, so this replaces the
 * existing one instead, validates the result, and keeps a backup.
 *
 *   node bin/apply-preset.mjs [--dry-run] [profile...]
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { profilePatchPath, listProfiles } from '../src/paths.mjs'

const BLOCK_SUFFIX = '.preset-block.yml'
const dryRun = process.argv.includes('--dry-run')
const wantProfiles = process.argv.slice(2).filter((a) => !a.startsWith('--'))

/** Minimal structural check without a YAML dependency: counts top-level `- id:` rows. */
function inspect(text) {
  const lines = text.split(/\r?\n/)
  const ids = []
  for (const l of lines) {
    const m = l.match(/^- id:\s*'?([A-Za-z0-9_.-]+)'?\s*$/)
    if (m) ids.push(m[1])
  }
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  return { ids, dup: [...new Set(dup)] }
}

export function replacePresetEntry(profileText, blockText) {
  const lines = profileText.split(/\r?\n/)
  const blk = blockText.replace(/^\s*\n/, '').split(/\r?\n/)
  const find = (re) => lines.findIndex((l) => re.test(l))
  const a = find(/^- id:\s*'?preset-standard'?\s*$/)
  if (a < 0) return null
  // entry ends at the next top-level `- id:` line (or EOF)
  let b = -1
  for (let i = a + 1; i < lines.length; i++) {
    if (/^- id:\s*/.test(lines[i])) { b = i; break }
  }
  if (b < 0) b = lines.length
  const nextIsPreset = b < lines.length
  const out = [...lines.slice(0, a), ...blk, ...(nextIsPreset ? [''] : []), ...lines.slice(b)]
  return out.join('\n')
}

function main() {
  const profiles = wantProfiles.length ? wantProfiles : listProfiles()
  let touched = 0
  for (const p of profiles) {
    const patch = profilePatchPath(p)
    const block = patch + BLOCK_SUFFIX
    if (!existsSync(block)) {
      if (wantProfiles.includes(p)) console.log(`${p}: no ${BLOCK_SUFFIX} (run enforce-preset.mjs first)`)
      continue
    }
    const original = readFileSync(patch, 'utf8')
    const next = replacePresetEntry(original, readFileSync(block, 'utf8'))
    if (next === null) {
      console.log(`${p}: no preset-standard row — skipped`)
      continue
    }
    const before = inspect(original)
    const after = inspect(next)
    const added = after.dup.filter((d) => !before.dup.includes(d))
    if (added.length) {
      console.error(`${p}: ABORT — would duplicate ${added.join(', ')}`)
      process.exitCode = 1
      continue
    }
    if (next === original) {
      console.log(`${p}: already applied`)
      continue
    }
    if (dryRun) {
      console.log(`${p}: would replace preset-standard (${after.ids.length} top-level rows) [dry run]`)
      continue
    }
    copyFileSync(patch, `${patch}.bak-apply-preset`)
    writeFileSync(`${patch}.tmp`, next)
    renameSync(`${patch}.tmp`, patch)
    rmSync(block, { force: true })
    console.log(`${p}: installed preset block (${after.ids.length} top-level rows)`)
    touched++
  }
  if (!touched && !dryRun) console.log('nothing to do')
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('apply-preset.mjs')) {
  main()
}