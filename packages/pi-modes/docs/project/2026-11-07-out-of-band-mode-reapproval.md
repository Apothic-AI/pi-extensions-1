---
summary: "Out-of-band mode re-approval: the /mode-reapprove --expect attestation and the read-only pi-modes CLI."
read_when:
  - "Propagating a mode-file edit to a lane, or automating the second half of it."
  - "Changing /mode-reapprove's arguments or the pi-modes state/expected/attest CLI."
  - "Looking for a headless / RPC way to run /mode-reapprove or touch a session from outside pi."
system4d:
  container: "pi-modes source, package docs, and the out-of-band CLI."
  compass: "Automate mode propagation without a second writer on any session."
  engine: "expected -> lane-side /mode-reapprove --expect -> attest."
  fog: "RPC --session looks like the headless answer and is actually the second-writer trap."
---

# Out-of-band mode re-approval: `--expect` and a read-only CLI

> **Trap: do not use `pi --mode rpc --session <file>` as a headless way to run `/mode-reapprove`.**
> It looks like the headless answer and it is the opposite: `--session` *resumes* that session as a
> second writer. Measured twice, independently — the child appends `model_change` and
> `thinking_level_change` entries, writes a fresh `pi-mode-state.v3` with `source: "startup"` from
> its own inherited `PI_MODE`, and grows the file (one run: 173 KB → 272 KB). It does **not** run the
> command you sent, and against a live lane it is the two-writers failure the fleet forbids. The
> safe shapes are: this read-only CLI (`state` / `expected` / `attest`), and for a running lane the
> lane re-approving **itself**. See [§4](#4-the-live-session-hazard-and-why-rpc-is-not-an-escape).

Date: 2026-11-07
Status: adopted
Beads: `swarm-tar` (epic), `swarm-024`, `swarm-2r8`, `swarm-0ic`, `swarm-56k`

## Problem

Propagating a mode-file edit to a running lane is two steps, and only the first is obvious:

1. A launcher lane reads its **own materialised copy** of `modes/` at
   `~/.pi-profile-switch/instances/launch-XXXX/modes/<key>.json` — a snapshot taken at launch
   (pi-profile's [ADR-0019](https://github.com/…/pi-profile-switch) materialises `modes/` and
   `mode-presets/` because pi-modes fails closed on a symlinked mode root). `/reload` does **not**
   refresh it; `/profile reload` does.
2. Refreshing the copy is not enough. The lane's session still records the **old definition
   digest**, so under the default `block` drift policy it composes the **native** prompt and
   silently loses its role contract. It needs `/mode-reapprove` to accept the new digest.

`/mode-reapprove` existed only as an in-TUI command whose parser accepts `--confirm-exact` and
`--confirm-project`. A helper could hash a file, send the command, and the file could change in
between — reapprove would bless the new text under the helper's stale attestation, and the tool's
own guard would not catch it, because the helper's hash never entered the tool (operator TODO FT-40).

## Decision

### 1. `/mode-reapprove` accepts `--expect <sha256>` (FT-40)

`--expect` pins the exact definition(s) the caller looked at:

```text
/mode-reapprove --confirm-project --expect <sha256>              # single-mode selection
/mode-reapprove --confirm-project --expect leader=<sha256>,...   # one key=sha256 per mode
```

The handler verifies each digest with the package's own `modeDefinitionFingerprint` **before** any
question is asked or anything is persisted, and refuses on a mismatch with the existing message
("Mode definitions changed after confirmation; preview and confirm the selection again").

**`--expect` also settles the TUI confirm, so a non-interactive caller finishes.** In a TUI session
`/mode-reapprove` shows "Reapprove active prompt mode definitions?" when there is drift it has not
otherwise shown. A caller that supplied `--expect` for **every** selected mode has already attested
the exact definition(s) — strictly more than pressing Enter on that generic prompt — so the dialog is
skipped. Without `--expect`, or when it covers only some keys, the dialog behaves exactly as before.
(Measured defect, reported by the first external consumer: polling for that dialog and sending Enter
is a race — a non-interactive caller can check too early, never press Enter, and leave the lane stuck
on a modal reporting `drift -> drift`.)

Without `--expect`, behaviour is unchanged, so the interactive consent gate is not weakened. The
`expectedDefinitionFingerprint` gate on `persistSelection` is untouched: it still recomputes
`selectionDefinitionFingerprint(selection, modes)` at append time and refuses if the composition
moved between the handler's check and the write. `--expect` narrows *what* is being attested; the
existing gate still closes the TOCTOU window *when* it is attested.

**The digest is per-key and includes `scope` and `path`.** The same mode text at an instance copy
hashes differently from the real agent dir — measured: instance `3fef5517…` vs real `7fd1f88c…` for
`solid-lynx`'s leader mode. A caller must compute `--expect` with `modeDefinitionFingerprint` for the
path the lane **actually reads**, never as a hash of the file's bytes and never against a freshly
discovered path.

### 2. A read-only CLI: `pi-modes state|expected|attest`

`scripts/mode-cli.ts`, exposed as the `pi-modes` bin via `bin/pi-modes.mjs` — a shim that loads the
TypeScript CLI through jiti, because Node refuses type-stripping for files under `node_modules`
(verified: the raw `.ts` bin throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` once installed; the
shim runs the installed bin from any cwd). It **never writes to a session and never attaches to
one**:

| Command | Does | Safe against a live session |
|---|---|---|
| `state <session.jsonl>` | Reads the last `pi-mode-state.v3` entry; reports the recorded digest, the definition path read, and whether that digest still matches the file at that path. Exit 0 match / 3 drift / **4 unknown** / 1 no state. | yes (read-only) |
| `expected <session.jsonl>` | Prints the digest(s) the lane would record after `/profile reload`, fingerprinted at the recorded path (`key=sha256`, or a bare sha256 for one mode). | yes (read-only) |
| `attest <session.jsonl> --expect <sha256>` | Verifies the lane's recorded definition matches `--expect`. Exit 0 attested / 2 mismatch / 1 no state. | yes (read-only) |

`state` reports **UNKNOWN** when the recorded definition path is gone — a launch instance swept on
exit. That is *not verified*: neither a pass nor a failure. It has its own exit code (4) and a
`verdict` field under `--json` precisely so it cannot be read as healthy. Historical sessions whose
instances were swept are the common case and are not a fault signal.

**`--json` shape, for consumers.** `recorded` is a **boolean** ("a v3 entry exists") — it is *not* a
digest, and reading it expecting one silently yields nothing. The digest lives at
`keys[].recordedDigest` (with `recordedPath`, `recordedScope`, `currentDigest`, and a per-key
`verdict`). For a single-key selection the same values are also lifted to the top level as `key`,
`recordedDigest`, `recordedPath`, `currentDigest`, alongside a top-level `verdict`. A consumer should
read `verdict` (or `keys[].verdict`) — `match` / `drift` / `unknown` — and should treat `keys`
entries that carry a `problem` and no `currentDigest` as unknown rather than as no-work-to-do. (First
external consumer read `recorded` as a digest, got an empty result, and every lane looked like it
needed work.)

**A composed mode must be resolved, not hashed standalone.** Composition happens **only at the project
layer**: a project `append` is merged with (not replacing) the definition it shares a key with, so the
lane records the digest of the *composed* result, whose `systemPrompt` is the global text followed by
the project text. Hashing the project file on its own yields a different digest, so an early version
of this CLI reported a **permanent false drift** for every composed lane and produced an `expected`
digest that `/mode-reapprove --expect` then refused. Measured on a real lane: recorded `079814bb…`
(composed) against `9868a9a9…` (the standalone hash of the same file). The fix resolves a `project`
row through `loadModes` exactly as the runtime does. A `global` or `builtin` row is still read at its
**recorded path**: for a profile lane that path is its instance copy, and the path is part of the
fingerprint, so re-resolving it from the real agent dir would produce a different wrong digest. On the
three real project-delta lanes this turned two permanent false drifts (`sibyl`, `billion-context`) into
`match` and left one genuine drift (`pi-rooms`) reported — the drift that matters, caused by the global
base changing under an untouched project file.

### 3. A restricted mode, armed by default — friction, and said so

By operator decision, the CLI requires a shared secret held in the workspaces of approved leaders.
It is **armed by default**: **absence of any environment means armed**, so the gate applies by simply
existing, with no variable to set. The secret is read from `$PI_MODES_CLI_SECRET_FILE` (default
`~/.pi/agent/secrets/pi-modes-cli`, deliberately **not** populated; refused if group/world-readable).
`PI_MODES_CLI_SECRET` is an optional assertion that must match the file. `PI_MODES_CLI_AUTH_DISABLED=1`
is the single deliberate disarm; `PI_MODES_CLI_SECRET_REQUIRED` is retired and ignored. A refused call
exits **6** and prints what to do next, naming who to ask — the message is the product, because it
converts a wall into a handoff rather than a puzzle.

**Why armed by default, and not opt-in.** The first design required a variable to arm the gate. Two
findings killed it:

- `pil` parses `.pi/launch.env` against a fixed whitelist (`case "$key" in PI_MODE|PI_PROFILE|PI_MODE_CONFIRM_PROJECT)`)
  and applies the file only for leader names, so an arming variable there is silently discarded and
  could never gate a worker lane.
- A running `herdr` server freezes the environment its panes inherit (a variable set with
  `systemctl --user set-environment` did not reach a newly spawned pane; only `environment.d` values
  present when the server started arrive). So an arming variable added now reaches no running lane and
  never arrives without a restart or a new login.

Arming on *absence* needs neither mechanism, and takes effect the moment the code ships. This is a
strictly better design than the one originally asked for, and it came from the operator.

**This is friction, not a security boundary, and the documentation says exactly that.** The operator
asked for it to make a casual caller pause and notice it is crossing a boundary, not to stop a
determined agent:

- Every lane here has the same uid and no namespace separation, so a `600` secret is readable by any
  lane that knows the path, and a lane could point the CLI at a file it made itself. File permissions
  set navigation cost, nothing more; the friction is that crossing the boundary must be *deliberate*.
- The gate covers **this CLI only** — a surface with no write path. It does not cover re-approving
  from inside a lane.

**What this deliberately leaves open.** `/mode-reapprove` in a lane is **ungated**: a bare
`/mode-reapprove --confirm-project` re-blesses whatever definition is on disk, and in RPC mode
(`ctx.mode === "rpc"`) the TUI confirm does not fire at all, so `services.reapprove` runs with no
dialog and no attestation. That is the status quo, it predates this work, and it is left unchanged
deliberately so that any lane observed self-blessing becomes a clean, separate decision. A capability
boundary (who may run `/mode-reapprove` at all) is the control that would actually enforce, and it
belongs in the permission layer, not here.

### 4. The live-session hazard, and why RPC is not an escape

**A second writer on a session a running agent still holds is a race, and the fleet forbids it.** A
duplicate writer corrupts state and can strand the lane; recovery is owned by `overlord-watchdog`,
not by attaching to the session.

RPC is *the thing that creates the race*, not a way around it. Measured **twice, independently** (by
the pi-modes workspace, and again by the self-improvement-leader review on a throwaway copy):
running `pi --mode rpc --session <file>` **resumed** the session — the child appended `model_change`
and `thinking_level_change` entries and re-recorded mode state with `source: "startup"` from its
inherited `PI_MODE` environment, **not** from the command sent to it, growing one file from 173 KB to
272 KB. Against a live lane that is exactly the two-writers failure, and it does not even perform the
requested re-approval.

Both runs were on throwaway copies precisely because using it on a live lane is the hazard. Anyone
reaching for `--session` should know it is a *resume*, not an out-of-band execution channel.

So the second half of a propagation is the **lane's own act**:

- **Running lane**: send the lane
  `/mode-reapprove --confirm-project --expect <digest from expected>` over herdr. Its own session
  records the new digest, so the consent gate stays real. The CLI's role is then to **read and
  attest**: confirm with `attest` that the lane recorded the digest.
- **Stopped / wedged / crashed lane**: there is no live writer; the same lane-side command is issued
  when it next runs. The CLI still only reads.

The CLI therefore has no write path and no `--force`. If a future need for a live write appears, it
must arrive as a separate, explicitly-reviewed decision that names precisely what makes it safe and
proves it on a scratch lane first.

## Consequences

- A propagation can be automated end to end without a TUI: `expected` → send `/mode-reapprove
  --expect` to the lane → `attest`. A definition that changes mid-flight fails loudly at the CLI's
  pre-flight (exit 2) *and* at the gate inside `persistSelection`.
- Repairing a stopped lane is a read plus a lane-side command, not a session surgery.
- `state` doubles as a fleet-wide diagnostic: it reports drift and swept instance copies
  (`UNKNOWN`) across historical sessions without touching any live process.
- The restricted mode is armed by default and adds friction only; it changes nothing about the CLI's
  read-only nature or the in-lane `/mode-reapprove` path (see §3).

### Where the secret lives, and why it cannot be a boundary

Every lane on this machine runs as the **same uid (1000) with no namespace separation**, so a `600`
secret file is readable by any lane that knows the path. The location therefore confers **no
protection** — it only sets how much navigation a caller must do before it can read the secret. That
is exactly the intended friction, and it means the choice of path should optimise for *discoverability
by the wrong caller* and *no accidental leakage*, not for access control.

The two authorized copies live in the approved leaders' own workspaces, mode `600`, holding the same
value so rotation is one act:

- `~/Documents/Fleet/.pi/pi-modes-cli.secret` (self-improvement-leader)
- `~/.overlord/pi-modes-cli.secret` (overlord)

The default path `~/.pi/agent/secrets/pi-modes-cli` is **documented but deliberately not populated**.
Populating it would let any lane that reads the refusal message find a working secret in one step,
which would zero the friction the gate exists to create. It remains the convention the message names,
and a caller points `PI_MODES_CLI_SECRET_FILE` at a leader's file instead.

Copies in a leader's workspace are a *shortcut for that leader*, not a security measure: any such copy
is equally readable by every other lane, and a lane could point the CLI at a file it created itself.
Crossing the boundary must be deliberate — that decision, not an unbreakable wall, is the control. A
lane that needs the secret but is not an approved leader has no path that does not involve a human
running the command or granting access — asking is the designed outcome, and the refusal message says
who to ask.

## Verification

- Unit/behavioural tests: `tests/selection-commands.test.ts` (parser), `tests/mode-extension.test.ts`
  (refuse-on-mismatch, persist-on-match, dialog-skip with `--expect`), `tests/mode-cli-state.test.ts`
  (reader, scope+path in the fingerprint, drift, expected, UNKNOWN verdict), `tests/mode-cli-auth.test.ts`
  (refuses without/with wrong secret, succeeds with the right one, refuses before any work, escalation
  sentence present).
- The refusal message and all four auth paths were exercised on the real CLI (exit 6 on every
  refusal), not merely asserted in unit tests.
- Cross-check on a real session (`solid-lynx`, `launch-RXYi4n`): the CLI's `expected` digest
  `3fef5517dd90…` equals the digest `/mode-reapprove --expect` computes internally for the same
  recorded path.
- One-lane proof (Fleet leader, stopped — confirmed by `proc-find --arg <session>`, which matches
  explicit fields only and excludes this process): `state` → DRIFT (recorded `812c8183…`, now
  `41733951…`); `expected` → `41733951…`; `attest` with the stale digest → exit 2; with the current
  digest → exit 0.
