#!/usr/bin/env node
/**
summary: "Out-of-band pi-modes CLI: read a lane's recorded mode state, compute the expected digest, and attest it — never a session writer."
read_when:
  - "Propagating a mode-file edit to a lane, or reading/attesting a lane's recorded digest."
  - "Automating the second half of a mode propagation (see /mode-reapprove, FT-40)."
*/
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkAuth } from "../src/mode-cli-auth.ts";
import {
  compareState,
  compareVerdict,
  expectedDigestsForState,
  readRecordedModeState,
  readSessionCwd,
  recordedKeys,
} from "../src/mode-cli-state.ts";

/** Refused by the friction gate. Distinct from usage (2) so a script can tell them apart. */
const REFUSED_EXIT = 6;

const USAGE = `pi-modes — out-of-band mode state reader and digest attester (READ-ONLY)

Usage:
  pi-modes state <session.jsonl> [--key <mode>] [--json]
      Read the lane's last recorded pi-mode-state.v3 entry: the digest it recorded, the
      definition path it read, and whether that digest still matches the file at that path.
      Exit: 0 match, 3 drift, 4 unknown (recorded copy gone — NOT VERIFIED), 1 no state.

  pi-modes expected <session.jsonl> [--key <mode>] [--json]
      Print the digest(s) the lane would record after /profile reload: \`key=sha256\` (or a bare
      sha256 for a single-mode selection). Pass this to the lane's own /mode-reapprove --expect.
      The digest covers the definition's scope and path, so it is computed for the path the lane
      READS (its materialised copy), never as a hash of the file's bytes.

  pi-modes attest <session.jsonl> --expect <sha256> [--key <mode>] [--json]
      Verify the lane's recorded definition matches <sha256> (single-mode selection). This is the
      read-and-attest half of a propagation: compute with "expected", send the digest to the lane,
      then confirm the lane recorded it. Exit: 0 attested, 2 mismatch, 1 no state.

Options:
  --key <mode>       Only consider this mode key (default: the lane's recorded base/overlays).
  --global-dir <d>   Global mode directory (default: $PI_CODING_AGENT_DIR/modes or ~/.pi/agent/modes).
  --json             Emit machine-readable JSON on stdout.
  -h, --help         Show this help.

Restricted mode (ARMED BY DEFAULT):
  Every subcommand refuses before doing any work unless a valid secret file is present at
  $PI_MODES_CLI_SECRET_FILE (default ~/.pi/agent/secrets/pi-modes-cli, which is deliberately not
  populated: point the variable at an approved leader's secret file, mode 600). If
  PI_MODES_CLI_SECRET is also set it must match that file.

  Absence of any environment means ARMED. There is nothing to switch on: the gate applies by
  simply existing. To disarm deliberately, set PI_MODES_CLI_AUTH_DISABLED=1.

  This is friction, not a security boundary. Every lane on this machine runs as the same uid, so
  a 600 secret is readable by any lane that knows the path, and a lane could point the CLI at a
  file it made itself. Trying is the point: the gate exists so an agent reaching for the
  convenient surface has to notice it is crossing a boundary and fetch a real secret. Running
  /mode-reapprove inside a lane is not gated at all, by deliberate operator decision.
  Refused calls exit 6.

Why this tool does not write, and does not attach to a session:

  The mechanism is two-step: /profile reload refreshes the lane's materialised copy of modes/
  (a snapshot taken at launch), and the lane then needs /mode-reapprove to accept the new
  definition digest, or under the default 'block' drift policy it composes the native prompt
  and silently loses its role contract.

  The second half is the LANE'S OWN act. Writing a session from outside — including by attaching
  a second \`pi --mode rpc --session <file>\` — makes two writers on one session, which the fleet
  forbids: a duplicate writer corrupts state and can strand the lane. Measured directly: a second
  RPC pi resumed the session, appended model_change/thinking_level_change entries, and re-recorded
  mode state from its inherited PI_MODE environment rather than from the command sent to it.

  So for a RUNNING lane, have the lane re-approve ITSELF: send it

      /mode-reapprove --confirm-project --expect <digest from "expected">
  over herdr (its own session records the new digest, so the consent gate stays real), then
  confirm with "attest". For a STOPPED, wedged, or crashed lane there is no live writer, and the
  same lane-side command is issued when it next runs. Either way this CLI only reads.
`;

interface Args {
  command: string;
  session: string;
  key?: string;
  globalDir?: string;
  expect?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const [command = "", session = "", ...rest] = argv;
  const args: Args = { command, session, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    const next = rest[index + 1];
    switch (token) {
      case "--key":
        if (!next) throw new Error("--key requires a mode key");
        args.key = next;
        index += 1;
        break;
      case "--global-dir":
        if (!next) throw new Error("--global-dir requires a directory");
        args.globalDir = next;
        index += 1;
        break;
      case "--expect":
        if (!next) throw new Error("--expect requires a sha256 digest");
        if (!/^[a-f0-9]{64}$/u.test(next.toLowerCase())) {
          throw new Error("--expect requires a lowercase sha256 hex digest");
        }
        args.expect = next.toLowerCase();
        index += 1;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`unexpected argument: ${token}`);
    }
  }
  return args;
}

/**
 * The global mode dir used to resolve the lane's composition. Defaults to the REAL agent dir, not
 * `PI_CODING_AGENT_DIR`: this CLI may itself run inside a lane whose instance dir is not the target
 * lane's, and the caller's instance would silently be the wrong base. A composed fingerprint does
 * not include the global PATH, only its text, so after a `/profile reload` the real dir gives the
 * same value the lane reads. Override with `--global-dir` for a lane that differs.
 */
function globalModeDir(args: Args): string {
  if (args.globalDir) return resolve(args.globalDir);
  return join(homedir(), ".pi", "agent", "modes");
}

function targetKeys(recordedKeyList: string[], args: Args): string[] {
  return args.key ? [args.key] : recordedKeyList;
}

/**
 * The per-key definition digests the lane would record after /profile reload, over the definitions at
 * the lane's recorded paths. This is the value `/mode-reapprove --expect` accepts: \`key=sha256\` for
 * a multi-mode selection, or a bare sha256 when the selection has one mode.
 */
function expectedDigestsForSession(
  session: string,
  args: Args,
): { key: string; digest: string; path: string | null }[] {
  const recorded = readRecordedModeState(session);
  if (!recorded) throw new Error(`no pi-mode-state.v3 entry recorded in ${session}`);
  const cwd = readSessionCwd(session);
  return expectedDigestsForState(recorded.state, {
    ...(cwd ? { cwd } : {}),
    globalModeDir: globalModeDir(args),
  });
}

function runState(args: Args): number {
  const session = resolve(args.session);
  const recorded = readRecordedModeState(session);
  if (!recorded) {
    const message = `no pi-mode-state.v3 entry recorded in ${session}`;
    if (args.json) console.log(JSON.stringify({ session, recorded: false, reason: message }));
    else console.error(message);
    return 1;
  }
  const cwd = readSessionCwd(session);
  const comparisons = compareState(recorded.state, {
    ...(cwd ? { cwd } : {}),
    globalModeDir: globalModeDir(args),
    keys: targetKeys(recordedKeys(recorded.state), args),
  }).map((item) => ({ ...item, verdict: compareVerdict(item) }));
  // Exit codes are distinct so a script cannot read `unknown` as success: 0 match, 3 drift,
  // 4 unknown (the recorded copy is gone, so nothing was verified), 1 no recorded state.
  const exitCode = comparisons.some((item) => item.verdict === "drift")
    ? 3
    : comparisons.some((item) => item.verdict === "unknown")
      ? 4
      : 0;
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          session,
          // `recorded` is a boolean ("a v3 entry exists"), NOT a digest. The digests live in
          // `keys[].recordedDigest` and, for a single-key selection, in `recordedDigest` here. A
          // consumer that reads `recorded` expecting a digest gets a boolean and silently finds
          // nothing — so the summary fields below are named to say what they hold.
          recorded: true,
          activatedAt: recorded.state.activatedAt,
          source: recorded.state.source,
          driftPolicy: recorded.state.driftPolicy,
          recordedAt: recorded.timestamp ?? null,
          verdict: exitCode === 3 ? "drift" : exitCode === 4 ? "unknown" : "match",
          ...(comparisons.length === 1
            ? {
                key: comparisons[0]?.key,
                recordedDigest: comparisons[0]?.recordedDigest,
                recordedPath: comparisons[0]?.recordedPath ?? null,
                currentDigest: comparisons[0]?.currentDigest ?? null,
              }
            : {}),
          keys: comparisons,
        },
        null,
        1,
      ),
    );
    return exitCode;
  }
  console.log(`session      ${session}`);
  console.log(`recorded at  ${recorded.timestamp ?? "-"} (source ${recorded.state.source})`);
  console.log(`drift policy ${recorded.state.driftPolicy}`);
  for (const item of comparisons) {
    console.log("");
    console.log(`  key        ${item.key}`);
    console.log(`  recorded   ${item.recordedDigest} (${item.recordedScope})`);
    console.log(`  path       ${item.recordedPath ?? "-"}`);
    if (item.problem) {
      console.log(`  status     UNKNOWN — NOT VERIFIED (neither a pass nor a failure)`);
      console.log(`             ${item.problem}`);
      console.log(
        "             The recorded definition path is gone (its launch instance was swept), so",
      );
      console.log(
        "             the digest could not be re-checked. Read the live lane with /mode-status",
      );
      console.log("             rather than counting this historical record as healthy.");
    } else if (item.matches)
      console.log("  status     MATCH — the definition at that path is current");
    else console.log(`  status     DRIFT — now ${item.currentDigest}`);
  }
  return exitCode;
}

function runExpected(args: Args): number {
  const session = resolve(args.session);
  const results = expectedDigestsForSession(session, args);
  if (args.json) {
    console.log(JSON.stringify({ session, expected: results }, null, 1));
    return 0;
  }
  if (results.length === 1) {
    console.log(results[0]?.digest ?? "");
  } else {
    console.log(results.map((item) => `${item.key}=${item.digest}`).join(","));
  }
  return 0;
}

function runAttest(args: Args): number {
  if (!args.expect) throw new Error("attest requires --expect <sha256>");
  const session = resolve(args.session);
  const results = expectedDigestsForSession(session, args);
  // A bare --expect attests a single-mode selection; the digest must match the definition the lane
  // records. For a multi-mode selection use `expected` to get the keyed form.
  const attested = results.length === 1 && results[0]?.digest === args.expect;
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          session,
          attested,
          expected: args.expect,
          computed: results.map((item) => ({ key: item.key, digest: item.digest })),
        },
        null,
        1,
      ),
    );
  } else if (attested) {
    console.log(
      `attested ${session}: the definition at the lane's recorded path matches ${args.expect}`,
    );
  } else {
    console.error(
      `not attested: the definitions at the lane's recorded paths are ${results
        .map((item) => `${item.key}=${item.digest}`)
        .join(", ")}`,
    );
  }
  return attested ? 0 : 2;
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  // The gate runs before argument parsing, so a refusal never echoes a caller's arguments and never
  // reads a session file first: no work happens before the check.
  const auth = checkAuth();
  if (!auth.ok) {
    console.error(auth.message);
    return REFUSED_EXIT;
  }
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (!args.session) {
    console.error("a session file path is required");
    return 2;
  }
  if (!existsSync(args.session)) {
    console.error(`session file not found: ${args.session}`);
    return 2;
  }
  try {
    switch (args.command) {
      case "state":
        return runState(args);
      case "expected":
        return runExpected(args);
      case "attest":
        return runAttest(args);
      default:
        console.error(`unknown command: ${args.command}`);
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exit(main());
