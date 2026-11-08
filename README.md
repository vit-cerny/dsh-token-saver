# dsh-token-saver

Make [DSH] (DeepSeek Harness) stop wasting tokens — globally, in every project.

Built after one unrequested AgentTeams run burned **78M tokens in 40 minutes**.
Every number in this repo is measured from a real DSH install, and every claim
carries a `file:line`.

## What actually costs tokens

Context is re-sent on **every step**, and every subagent is another full request
stream carrying its own copy of the system prompt, tool schemas and skill
catalog. So the cost of a turn is:

```
tokens ≈ (system prompt + tool schemas + skill catalog + AGENTS.md
          + tool results so far) × steps × live agents
```

The multiplier at the end is what hurts. Fan-out is quadratic-ish in practice:
8 concurrent agents at depth 2 can put ~72 agents on the wire.

## The levers, ranked by what they actually saved

| # | Lever | Where | Effect |
|---|---|---|---|
| 1 | **Disable delegation entry points** | `preset-standard` + host `agent-teams` | Subagent/workflow tools and AgentTeams service are absent by default. |
| 2 | **Cap team fan-out** | host `agent-teams` | `maxMembers: 100 → 8`, `memberMaxDepth: 2 → 1` as a backstop if explicitly re-enabled |
| 3 | **Cap concurrent children** | host `subagent` | `maxActiveSubagents: 8 → 1` |
| 4 | **Cap tool results** | host `spill-policy` | `maxInlineTokens: 12500 → 6000` |
| 5 | **Cap preset tool output** | `preset-standard` | `tool-result-pruner`, `tool-fs`, `tool-fs-search`, `tool-web` |
| 6 | **Shrink skill catalog** | `tool-skill` | `catalogDescriptionMaxLength: 500 → 160` |
| 7 | **Trim AGENTS.md budget** | `agent-instructions` | `maxBytes: 65536 → 16384` |
| 8 | **Cheaper compaction** | `compaction-basic` | `maxTokens: 65536 → 8192`, earlier trigger |
| 9 | **Drop always-on dev prompt** | host `harness-dev-context` | `disabled: true` (~333 tok/request) |
| 10 | **Policy gate in AGENTS.md** | `~/.dsh/AGENTS.md` | AgentTeams only on explicit request |

Levers 1–9 are **configuration**, not advice. A `disabled: true` row is a tool
that does not exist; `maxActiveSubagents: 1` is a hard service cap.

## Why the config is split across two planes

This is the part that trips everyone up, so it is stated plainly.

`dsh-web-app/cordis.patch.yml` **disables the host copies** of the agent tools
and `presets/standard.patch.yml` **re-mounts them inside the `preset-standard`
row**. AgentTeams is a separate host plugin and needs its own disable row:

```
compaction-basic, tool-result-pruner, tool-fs, tool-fs-search,
tool-skill, agent-instructions, tool-subagent*, tool-workflow, tool-web
```

A Cordis patch **replaces a row's whole `config`** — it does not deep-merge
(`dsh-app-boot/lib/index.js`). So:

- writing `- id: tool-subagent` at the top level of a profile patch hits the
  **disabled host row** and does nothing (silent no-op), and
- the only way to reach those rows is to restate the **entire**
  `preset-standard.config.plugins` list.

Hand-copying 128 lines is how you silently lose tools on the next DSH upgrade.
`bin/enforce-preset.mjs` reads the *installed* preset and regenerates the block,
so new rows DSH ships are carried through automatically.

## The `!!js` trap

The shipped preset contains conditional rows:

```yaml
- id: tool-bash
  disabled: !!js process.platform === 'win32'
```

A plain YAML parse yields the **string** `"process.platform === 'win32'"`.
Re-emitting that as a normal scalar produces a *truthy string*, which disables
**both** `tool-bash` and `tool-pwsh` and leaves the agent unable to run a single
command. The generator verifies `!!js` expression counts in and out, and aborts
rather than writing a broken file.

## Install

```powershell
git clone https://github.com/vit-cerny/dsh-token-saver
cd dsh-token-saver

# 1. Preview, then apply host policy and one-child caps to every profile
#    AgentTeams is disabled where its plugin is installed.
node bin/apply-all.mjs --dry-run
node bin/apply-all.mjs

# 2. Preview, then write the web preset block
node bin/enforce-preset.mjs --dry-run
node bin/enforce-preset.mjs

# 3. Append the generated block to the web profile patch
#    (appends ~120 lines; keep the .bak-preset backup)
Get-Content "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml.preset-block.yml" |
  Add-Content "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"

# 4. Restart DSH Desktop
```

`apply-all.mjs` writes timestamped backups before changes. It applies host
policy where needed, caps all profiles at one child, and disables AgentTeams
where installed. Re-run it after regenerating a CLI profile from Desktop.

## Verify it worked

After restarting, in a fresh session:

- Run `node bin/verify-agent-teams.mjs`; it checks profile caps and the AgentTeams gate.
- Ask the agent to spawn a subagent. It should report the tool does not exist.
- AgentTeams tools should be absent until you remove the generated disable row
  from that profile and restart DSH.
- `/tier status` still shows the autotier tiers.

Roll back at any time:

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml.bak-preset" `
          "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Force
```

`apply-all.mjs` keeps a timestamped `cordis.patch.yml.bak-tokensaver-*` backup
for each profile it changes.

## Re-run after every DSH upgrade

The preset is restated in full, so an upgrade that adds rows will drop them
until you regenerate:

```powershell
node bin/enforce-preset.mjs --dry-run   # check row count matches
```

## Dangerous settings (do not "optimise" these)

- `compaction-basic.auto: false` → automatic compaction off; sessions die at the
  context limit with no recovery.
- `retainRatio >= thresholdRatio` → **throws at mount**.
- `tool-result-pruner` needs `headChars + 37 + tailChars <= thresholdChars` or it
  **throws at mount**.
- `agent-instructions.maxBytes: 0` → all `AGENTS.md` context silently disappears.
- `tool-fs-search.sampleOverCapGlobResults` has **no schema default**; omitting it
  fails the load.
- `token-meter` has `z.object({})` and **throws on any key**.

## Honest limitations

- **Skill bodies load lazily.** The catalog is capped at 160 characters per
  description; keep broad skills user-invoked and load one matching skill only.
- **RTK only filters supported shell commands when invoked.** It cannot compact
  DSH's internal tool output automatically. Graphify's existing graph can be
  queried directly without loading its full skill body.
- **Headroom is not on the DSH route.** DSH already uses native pruning and
  compaction; do not add another proxy unless a measured test justifies its RAM.
- Ponytail's concise defaults belong in the small global policy; its full skill
  body stays user-invoked instead of loading on every coding request.
- **Token counts are estimates** at 4 chars/token, not a provider tokenizer.

## License

MIT
