---
summary: "Composable, drift-aware Pi prompt modes with one base and ordered overlays."
read_when:
  - "Installing, operating, or extending @tryinget/pi-modes."
system4d:
  container: "Installable Pi prompt-mode package."
  compass: "Compose prompt policy without confusing base replacement, exact-final replacement, or execution authority."
  engine: "Discover -> validate -> select/preset -> fingerprint -> compose -> observe -> reapprove drift."
  fog: "Prompt layers, inherited definitions, and extension ordering can silently change effective model context."
---

# @tryinget/pi-modes

Switch and compose Pi prompt profiles during a session without restarting Pi.

A composition contains zero or one base plus zero or more ordered overlays:

- `append` definitions are overlays that retain the chosen base;
- `replace_base` definitions replace the static base while preserving Pi's dynamic append/context/skills/cwd envelope;
- `replace_final` definitions replace the final prompt with exact configured bytes at this extension's composition point and are exclusive;
- native host with no overlays leaves Pi unchanged.

Mode activation changes prompt policy only. It never grants tools, mutation, continuation, peer launch, campaign execution, publication, promotion, or other authority.

## Commands

| Command | Purpose |
|---|---|
| `/mode` | Open the atomic searchable selector: one base plus ordered overlays. |
| `/mode <key>` | Select one base, or native plus one legacy-style append overlay. |
| `/mode +<overlay>` / `/mode -<overlay>` | Add or remove one overlay while preserving the base and validating contracts. |
| `/mode set <base\|native> [--overlay <key>]...` | Apply an exact composition in listed order. |
| `/mode off` | Clear base and overlays. |
| `/mode save [--project] <preset>` | Save the active composition as a named preset without embedding prompt text. |
| `/mode use <preset> [--confirm-exact] [--confirm-project]` | Validate and atomically activate a preset. |
| `/mode export <preset>` | Export strict JSON plus a portable base64url payload. |
| `/mode import [--project] <preset> [--data <base64url>]` | Import without activation; TUI callers may edit JSON. |
| `/mode presets` | List discovered named compositions and diagnostics. |
| `/mode-status [--json]` | Show selection, effective components, hashes, estimates, provenance, drift, and fallback. |
| `/mode-preview [--json] [selection]` | Preview components and the composed prompt without activation. |
| `/mode-reapprove [--confirm-exact] [--confirm-project] [--expect <sha256>]` | Explicitly accept changed active definitions and refresh fingerprints. `--expect` (single sha256, or `key=sha256,...`) refuses unless the definition digest matches, which pins the attestation for a non-interactive caller. In the TUI the confirm names the digest it is about to accept — the same value `--expect` compares, so it can be copied straight into a headless call. |
| `/mode-policy <block\|warn\|allow>` | Choose what later definition drift does; `block` is the default. |
| `/mode-new [--project] <key>` | Save a new strict mode without activating it. |
| `/mode-edit <key>` | Edit a custom mode; active edits become blocked drift until reapproved. |
| `/mode-delete <key>` | Confirm and safely delete an owned custom mode. |

The package includes `plan`, `review`, and `explain` append overlays.

Mode keys that match command words such as `presets`, `save`, or `use` remain addressable without ambiguity through `/mode set <key>`.

### Interactive selector

Type to filter by key, label, description, strategy, or scope. Use Ctrl+U to clear, Up/Down to navigate the bounded choice window, Enter/Space to toggle, Alt+Up/Down to reorder checked overlays, then Apply or Cancel atomically. The selected row always remains visible even at the discovery bound. A details pane shows description, provenance, contracts, effective bytes/token estimate/hash, host-byte delta, and validation diagnostics.

Selecting or reapproving a new or drifted `replace_final` definition always requires TUI confirmation. Headless/RPC activation requires the explicit `--confirm-exact` acknowledgement:

```text
/mode exact-minimal --confirm-exact
/mode set exact-minimal --confirm-exact
/mode-reapprove --confirm-exact
```

Pi currently may report transport-level command acceptance after an extension command emits `extension_error`; automation must inspect the error event/stderr rather than exit/success alone.

### Project mode confirmation

Pi trusts a repository without asking when its only Pi configuration is `.pi/modes`, so a cloned repository can bring its own modes, or replace a built-in, global or outer-directory mode by reusing its key (a project `review.json` replaces the built-in `review`). Only project mode definitions you confirmed ever reach the system prompt:

- The TUI asks when you add one, showing its source file, what its strategy does, a definition digest, the start of its prompt (with a note when it is cut short), and which mode it replaces. Characters a terminal hides, blanks or reorders (controls, bidirectional overrides, zero-width, default-ignorable and Unicode tag characters) are shown as a counted `⟨n hidden⟩` marker with a warning, in the prompt and in the label, which the model reads as the prompt's heading. Cancel and run `/mode-preview` to read all of it.
- Headless/RPC activation needs `--confirm-project`, which accepts the definitions as they are at that moment: review them with `/mode-preview` first.
- The confirmation is remembered per file, content and what it replaces in `~/.pi/agent/mode-approvals.json` (`PI_CODING_AGENT_DIR` moves it; a symlinked record, chains included, is written through), so your own project modes ask again only after they change, or once they take over a mode that appeared after you confirmed them.
- It is enforced every turn, whatever the drift policy: an unconfirmed or changed project definition blocks the composition, falls back to the native prompt with a warning, and the status bar (`!`), `/mode-status` and every activation message say why. `/mode-preview` shows the files as they are now, also for an active selection whose definitions changed (it says which), so the text can be reviewed before confirming it. The TUI preview shows repository text inertly: every hidden character is spelled out (`⟨U+200B⟩`, `⟨U+001B⟩[2J`), runs of tag characters are decoded (`⟨tags "…"⟩`), a literal `⟨` or `⟩` is spelled out so it cannot pass for a marker, and the title says how many hidden characters the whole prompt has. Recognized emoji sequences (families, flags, keycaps) are left as they are. `/mode-edit` refuses a file with hidden characters, since the editor would show it raw.
- Only modes an activation adds are asked about, so removing or adding other modes never stalls on an active project mode whose file changed. Confirm that one with `/mode-reapprove`, which validates the composition first, also asks about any other changed definition, and keeps your drift policy. Passing `--confirm-project` to `/mode`, `/mode use` or `/mode-reapprove` covers every project mode in the result, active ones included, and records any not yet recorded. The `/mode` selector starts with every selected mode checked except those whose definition changed under the `block` policy; checking one of those again asks like a new mode, and applying never drops the modes around it.

```text
/mode +review --confirm-project
/mode use team --confirm-project
/mode-reapprove --confirm-project
```

Built-in and global modes never ask. A session that already used a project mode before this rule falls back until you confirm it once with `/mode-reapprove`. To withdraw a confirmation, delete its entry (or the file); it takes effect on the next turn. A malformed record counts as no confirmations; the next confirmation saves its exact content to `mode-approvals.json.invalid-<time>-<id>` before rewriting it. A record in a newer format, larger than 1 MiB, or unreadable is left alone, and you are told so before any confirmation is asked. An entry is dropped when its file is gone from a directory whose modes you are confirming; other directories are not visited, since a check on an unreachable mount could hang, so entries for files out of view (another checkout, a sandbox) are kept. The record keeps the 2048 most recently confirmed files within 1 MiB and forgets older ones without looking at them on disk; a forgotten file is only asked about again. Two sessions confirming at the same instant can lose one confirmation, which is then asked again. Project presets are not gated themselves: they may only combine modes that are confirmed, built-in or global.

### Headless observability

`/mode-status --json` and `/mode-preview --json` emit one deterministic JSON object. Preview's `prompt` is what the current files compose, so changed or unconfirmed text can be read; its `blocked`, `driftedKeys` and `diagnostics` say what the model gets now. Status includes only metadata and hashes. Both report `composition.hiddenCharacters`, the characters a terminal would not show, and print only printable ASCII: everything else is `\u` escaped, so the output is safe in a terminal and parses back to the exact text. Non-TUI status/preview use JSON automatically. Pi currently redirects extension `console` output to process stderr and does not correlate it as an RPC result event, so automation must capture stderr together with `extension_error`; the JSON line is machine-parseable, but its channel is a host limitation.

### Out-of-band state and attestation (`pi-modes` CLI)

`pi-modes state|expected|attest <session.jsonl>` reads a lane's recorded mode state from a session file and attestations against it, **without writing to the session and without attaching to it**. The `pi-modes` bin is `bin/pi-modes.mjs`, a shim that loads the TypeScript CLI through jiti (Node refuses type-stripping under `node_modules`, so an installed package cannot run its `.ts` sources directly). In this repo you can also run `node --experimental-strip-types scripts/mode-cli.ts` directly. This is the non-interactive half of propagating a mode change: a launcher lane reads its own materialised `modes/` copy, and after `/profile reload` refreshes it the lane still needs `/mode-reapprove` to accept the new digest, or it composes the native prompt under the default `block` policy.

```bash
# What did the lane record, and is that definition still current?
pi-modes state ~/.pi/agent/sessions/--…--/session.jsonl

# The digest the lane would record after /profile reload (fingerprinted at ITS path).
pi-modes expected <session.jsonl>              # prints a sha256 for a single-mode selection

# Have the lane re-approve ITSELF, then confirm it did:
#   send over herdr:  /mode-reapprove --confirm-project --expect <that digest>
pi-modes attest <session.jsonl> --expect <sha256>
```

Exit codes: `state` 0 match / 3 drift / 4 unknown / 1 no state; `attest` 0 attested / 2 mismatch / 1 no state.

`state` reports **UNKNOWN** when the recorded definition path is gone — usually a launch instance that was swept on exit. UNKNOWN is *not verified*: it is neither a pass nor a failure, and it has its own exit code (4) and a `verdict` field in `--json`, so a script cannot read it as healthy.

With `--json`, `recorded` is a **boolean** ("a v3 entry exists"), not a digest. The digest is at `keys[].recordedDigest` (with `recordedPath`, `recordedScope`, `currentDigest`, per-key `verdict`), and for a single-key selection also at the top level as `recordedDigest`/`currentDigest` with a top-level `verdict`. Read `verdict` (`match` / `drift` / `unknown`) rather than `recorded`.

The digest covers the definition's `scope` and `path`, so the **same text at an instance copy hashes differently from the real agent dir**. Always compute `--expect` with `expected` (the package's own `modeDefinitionFingerprint` over the path the lane reads), never as a hash of the file's bytes.

A running lane must re-approve **itself** — the command arrives as input and the lane's own session records the new digest, so the consent gate stays real. Writing a session from outside makes two writers on one session, which the fleet forbids: attaching a second `pi --mode rpc --session <file>` resumes the session, appends its own entries, and re-records mode state from its environment rather than from the command sent to it. `pi-modes` therefore only reads.

#### Restricted mode: ARMED BY DEFAULT (friction, not a boundary)

The CLI refuses to run unless a valid secret file is present. It needs **no environment to be armed** — absence of any variable means armed, so the gate applies by simply existing:

```bash
# Bare invocation, nothing set: refused, exit 6.
pi-modes state <session.jsonl>

# Authorized: point at an approved leader's secret file.
PI_MODES_CLI_SECRET_FILE=~/.overlord/pi-modes-cli.secret pi-modes state <session.jsonl>
```

Why armed by default rather than opt-in: `pil` parses `.pi/launch.env` against a fixed whitelist (only `PI_MODE`, `PI_PROFILE`, `PI_MODE_CONFIRM_PROJECT`) and applies it only to leader names, and a running `herdr` server freezes the environment its panes inherit — so a variable that must be *set* to arm cannot gate a running fleet without restarting lanes. Arming on absence needs neither.

The secret is read from `$PI_MODES_CLI_SECRET_FILE` (default `~/.pi/agent/secrets/pi-modes-cli`, which is deliberately **not** populated — a copy at the documented path would let any lane that reads the refusal message find it in one step and zero the friction). Mode `600`; a group/world-readable file is refused rather than accepted. If `PI_MODES_CLI_SECRET` is also set it must match that file. A refused call exits **6** and prints what to do next, including who to ask. `PI_MODES_CLI_SECRET_REQUIRED` is retired and ignored.

**What this is and is not.** It is a **speed bump**: it makes a caller stop and fetch a secret from an approved leader deliberately. It is **not** a security boundary, and should not be described as one:

- Every lane on this machine runs as the same uid with no namespace separation, so a `600` secret is readable by any lane that knows the path, and a lane could point the CLI at a file it made itself. Trying is the point — the friction is that the agent has to decide to do it.
- The gate covers **this CLI only**. It does not cover re-approving a mode from inside a lane: `/mode-reapprove` is ungated, and in RPC mode it runs with no confirmation dialog at all. That path is left open deliberately, as a watch item.
- The CLI itself has no write path — it cannot re-approve anything — so the secret guards the safe surface, not the dangerous one. It exists because the convenient surface is where drift happens.

`PI_MODES_CLI_AUTH_DISABLED=1` is the one deliberate disarm, for a demonstration or a lane that must run ungated.

## Launch-time selection

Single-key compatibility remains available:

```bash
PI_MODE=focused-builder pi
PI_MODE=review pi
PI_MODE=off pi
```

Structured startup composition uses strict JSON and takes precedence over `PI_MODE`:

```bash
PI_MODES='{"baseKey":"focused-builder","overlayKeys":["review","explain"]}' pi
```

Startup `replace_final` is also fail-closed and requires a separate explicit acknowledgement for either startup selector:

```bash
PI_MODE=exact-minimal PI_MODE_CONFIRM_EXACT=1 pi
PI_MODES='{"baseKey":"exact-minimal","overlayKeys":[]}' PI_MODE_CONFIRM_EXACT=1 pi
```

Startup activation of a project mode that was never confirmed falls back the same way unless `PI_MODE_CONFIRM_PROJECT=1` is set. That accepts the startup definitions for this Pi process only (through `/reload`, but not after the file changes) and records nothing; it does not hold up `/mode-reapprove` of other changes, and `/mode-reapprove --confirm-project` in that process makes it permanent; a startup key can resolve to a project file that replaces the mode you meant:

```bash
PI_MODE=review PI_MODE_CONFIRM_PROJECT=1 pi
```

Startup precedence:

1. nonblank `PI_MODES`;
2. nonblank `PI_MODE`;
3. newest recognized active-branch session entry;
4. native project/global `SYSTEM.md` or Pi's built-in base.

Invalid or unavailable startup selections fail closed to native host and write authoritative fingerprinted state so an older selection cannot unexpectedly reactivate.

## Discovery

Global modes and presets:

```text
~/.pi/agent/modes/*.json
~/.pi/agent/mode-presets/*.json
```

Trusted ancestor/project layers:

```text
<filesystem-root>/.pi/modes/*.json
...
<cwd>/.pi/modes/*.json

<filesystem-root>/.pi/mode-presets/*.json
...
<cwd>/.pi/mode-presets/*.json
```

Discovery follows Pi's `AGENTS.md` direction: global first, then filesystem root to cwd, with deeper keys overriding shallower keys. Untrusted projects contribute no ancestor definitions or presets. Inherited artifacts are selectable but read-only from descendants; project authoring writes only to cwd. Symlink boundaries, path traversal, oversized inputs, and malformed files fail closed per file.

## Strict mode schema v2

```json
{
  "schemaVersion": 2,
  "key": "hard-nosed-review",
  "label": "Hard-nosed Review",
  "description": "Adversarial correctness review.",
  "promptStrategy": "append",
  "systemPrompt": "Challenge assumptions and demand concrete evidence.",
  "requires": ["plan"],
  "conflictsWith": ["minimal-output"],
  "after": ["plan"]
}
```

Schema v2 requires an explicit strategy and rejects unknown fields, noncanonical keys, unsafe display text, oversized prompts, duplicates, self-reference, contradictory contracts, and invalid contract roles. Legacy schema v1 remains readable and retains its historical missing-strategy default of `replace_base`; saving through current authoring writes v2.

Optional contracts:

- `requires`: every named component must also be selected;
- `conflictsWith`: the composition is invalid when a named component is selected;
- `before` / `after`: conditional ordering assertions for append overlays when both keys are selected.

Contracts never auto-add, auto-remove, or auto-reorder. Invalid candidates are rejected atomically; replay-time contract failure returns native host with diagnostics.

### Prompt in a Markdown file

A schema v2 mode can keep its prompt in `<key>.md` beside `<key>.json`, leaving `systemPrompt` out of the JSON; the file is used whenever it is present. A prompt in both places is an error, and so is an empty file. A `<key>.md` beside a mode's JSON is always read as its prompt, so notes kept under that name in a modes directory need another name. The file must be a regular file (not a symbolic link, FIFO or directory); it is checked before it is read, and the 131072-byte prompt limit applies to the prompt text, not to line endings or blank lines around it. A leading byte order mark is dropped, and the text is trimmed like an inline prompt, except for `replace_final`, which is kept exactly.

Moving an unchanged prompt into the file is not a change of definition, but any edit to the file is: it counts as drift, and for a project mode it needs confirming again. `/mode-edit` shows the prompt with the rest of the definition and saves it back to the `.md`. `/mode-new` for a key whose `.md` already exists creates the JSON around it; any other save that did not load its prompt from the `.md` is refused rather than overwrite it. Deleting a mode removes the `.md` its prompt came from, first, and the confirmation says so. `npm run mode:lint` checks the `.md` beside each JSON file it is given.

Packaged schemas live under [`schemas`](schemas). Lint files with:

```bash
npm run mode:lint -- path/to/mode.json path/to/preset.json
```

## Named composition presets

Presets store only keys and overlay order—not prompt text, authority, objectives, tools, or drift bypasses:

```json
{
  "schemaVersion": 1,
  "key": "deep-review",
  "label": "Deep Review",
  "selection": {
    "baseKey": "focused-builder",
    "overlayKeys": ["plan", "review"]
  }
}
```

Preset import/use resolves current trusted definitions and validates the complete composition before writing one state entry.

## Prompt composition

```text
native assembled host prompt
OR
replace_base systemPrompt
  + APPEND_SYSTEM.md / --append-system-prompt
  + trusted AGENTS.md / CLAUDE.md
  + visible skills
  + cwd

THEN
+ append overlay 1   (section prompt_overlay_1)
+ append overlay 2   (section prompt_overlay_2)
+ ... persisted order
```

Pi 1.x builds the system prompt from its prompt options and keeps it in the session transcript as named sections. `pi-modes` therefore edits those options in `before_agent_start` instead of returning text: `replace_base` sets `customPrompt` (Pi itself then renders the addendum, project context, skills and cwd after it), and each append overlay adds a `prompt_overlay_<n>` section, which Pi renders last. Only `replace_final` returns a prompt, which Pi sends as forced text.

`replace_final` preserves configured bytes exactly at the `pi-modes` handler. A later `before_agent_start` extension may still modify them; provider-payload exactness requires control of the full extension chain.

`/mode-preview` and `/mode-status` render the composed prompt with a copy of Pi's custom-base rendering. Its output is compatibility-tested against Pi's pinned host prompt builder with read, bash-only, hidden-reader and no-reader skill fixtures; the prompt the model receives comes from Pi's own builder either way. This release supports `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` `>=1.1.0 <2.0.0`. Advance that range only with the parity canary and installed-artifact smoke passing.

## Drift-resistant state and observability

New writes use `pi-mode-state.v3` with:

- base and ordered overlay keys;
- SHA-256 semantic/provenance fingerprints for every selected definition;
- activation source and timestamp;
- drift policy (`block` by default).

Fingerprints include prompt meaning, strategy, normalized contracts, scope, and source path—not JSON whitespace or mtime. Changed, missing, or newly shadowed definitions are visible in status. `block` returns native host until explicit reactivation or `/mode-reapprove`; `warn` and `allow` require explicit policy selection and never bypass slot, exact-final, or contract validation.

Session replay remains chronological across v1, v2, and v3. Valid legacy state migrates once to v3; invalid legacy state freezes to native host. Historical entries are never rewritten.

Status/preview expose effective component hashes, final composition hash, UTF-8 bytes, approximate token count, host-byte delta, activation provenance, drift, and diagnostics. Token counts are estimates, not provider tokenizer authority.

## Safety and rollback

- Mode/preset files are parsed independently with deterministic bounds.
- Saves use same-directory temporary files and atomic rename.
- Authoring does not activate implicitly.
- Project-scoped mode text reaches the prompt only while its exact definition is confirmed (see Project mode confirmation).
- State changes append one validated entry; discovery never silently repairs state.
- `/mode off`, package disable/removal, or native host are the rollback surfaces.
- Downgrading to a pre-v3 release may expose an older v2 entry; explicitly use that version's `/mode off` or disable the package.

## Install and verify

```bash
git clone https://github.com/tryingET/pi-extensions.git
cd pi-extensions/packages/pi-modes
npm install
npm run check
npm run release:check
pi install "$PWD"
```

Then `/reload` and exercise:

```text
/mode set native --overlay review --overlay explain
/mode save deep-review
/mode off
/mode use deep-review
/mode-status --json
/mode-preview --json
/mode-reapprove
```

The release check installs the packed artifact into an isolated, credential-free Pi agent directory and runs extension-level migration, composition, exact-final, and semantic-error smoke probes. The publication gate uses `release:check:ci`, which additionally requires npm registry truth; `release:check:quick` remains the template-compatible artifact-only check. Local installation still requires `/reload` and a fresh real command/tool call.

- Architecture: [`docs/project/2026-07-11-prompt-mode-architecture.md`](docs/project/2026-07-11-prompt-mode-architecture.md)
- Composition design/evidence: [`docs/project/2026-07-13-base-plus-append-overlay-composition.md`](docs/project/2026-07-13-base-plus-append-overlay-composition.md)

## Attribution

The concept and command vocabulary were informed by Maxime Rivest's MIT-licensed [`pi-modes`](https://github.com/MaximeRivest/pi-modes). This implementation has separate composition, trust, persistence, preset, observability, validation, and test contracts.
