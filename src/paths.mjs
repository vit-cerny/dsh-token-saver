/**
 * Filesystem layout of an installed DSH, resolved at runtime.
 *
 * Nothing here is hard-coded to one machine: the DSH home comes from `$DSH_HOME`
 * or `~/.dsh`, and the app bundle is discovered by looking for the
 * `@deepseek-ai/dsh-base` package in the usual install roots.
 *
 * @module src/paths.mjs
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Expand a leading `~` and normalize separators. */
export function expandHome(value) {
  if (typeof value !== 'string' || value === '') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** The DSH home directory (`$DSH_HOME` or `~/.dsh`). */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(expandHome(fromEnv.trim()))
  return join(homedir(), '.dsh')
}

/** Candidate directories that contain `@deepseek-ai/*` plugin packages. */
export function appRootCandidates() {
  const roots = []
  const fromEnv = process.env.DSH_APP_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') roots.push(resolve(expandHome(fromEnv.trim())))

  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']]) {
      if (!base) continue
      roots.push(join(base, 'DSH Desktop', 'resources', 'app'))
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Applications/DSH Desktop.app/Contents/Resources/app')
  } else {
    for (const base of ['/opt', '/usr/lib', '/usr/local/lib']) roots.push(join(base, 'dsh-desktop', 'resources', 'app'))
  }
  return roots
}

/**
 * Locate the installed DSH app bundle.
 * @returns {{ appRoot: string, pluginsRoot: string, version: string|null } | null}
 */
export function findAppRoot() {
  for (const root of appRootCandidates()) {
    const pluginsRoot = join(root, 'node_modules', '@deepseek-ai')
    if (!existsSync(join(pluginsRoot, 'dsh-base'))) continue
    let version = null
    try {
      const pkg = JSON.parse(readFileText(join(root, 'package.json')))
      version = typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      // A missing or unreadable app manifest only costs us the version string.
    }
    return { appRoot: root, pluginsRoot, version }
  }
  return null
}

/** Read a UTF-8 text file, returning `null` when it does not exist. */
export function readFileText(path) {
  try {
    return require_fs().readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// Keep the import list small for readers: `node:fs` is only needed here.
function require_fs() {
  return fsModule
}
import * as fsModule from 'node:fs'

/** List profile names that have a directory under `$DSH_HOME/profiles`. */
export function listProfiles() {
  const dir = join(dshHome(), 'profiles')
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== 'node_modules')
      .sort()
  } catch {
    return []
  }
}

/** Absolute path of a profile directory. */
export function profileDir(name) {
  return join(dshHome(), 'profiles', name)
}

/** The profile patch file DSH applies last (`cordis.patch.yml`). */
export function profilePatchPath(name) {
  return join(profileDir(name), 'cordis.patch.yml')
}

/** The skill root DSH discovers at rank 400. */
export function userSkillRoot() {
  return join(dshHome(), 'skills')
}

/** Parent directory of a path, for `mkdir -p` style creation. */
export function parentOf(path) {
  return dirname(path)
}
