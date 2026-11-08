/**
summary: "Friction gate for the pi-modes CLI: armed by default, disarmed only by an explicit escape hatch. Friction, not a security boundary."
read_when:
  - "Changing pi-modes CLI authentication, its env vars, or its refusal message."
  - "A lane reports that the pi-modes CLI refuses to run."
*/
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What this is, stated plainly because the message is the product: this is **friction, not a
 * security boundary**. Every lane on this machine runs as the same uid with no namespace
 * separation, so a `600` secret file is readable by any lane that knows the path, and a lane could
 * even point the CLI at a file it made itself. The gate exists so that an agent reaching for the
 * convenient surface has to *notice* it is crossing a boundary and go fetch a real secret from an
 * approved leader's workspace — that decision is the control. It stops drift, not intent. And
 * `/mode-reapprove` inside a lane is not gated at all, by deliberate operator decision.
 */

/** The one deliberate opt-out: set to `1` to run the CLI ungated (demonstrations, maintenance). */
export const AUTH_DISABLED_ENV = "PI_MODES_CLI_AUTH_DISABLED";
/** Path to the secret file for this invocation. Defaults to DEFAULT_SECRET_FILE (unpopulated). */
export const SECRET_FILE_ENV = "PI_MODES_CLI_SECRET_FILE";
/**
 * Optional assertion: if set, it must equal the secret file's contents. Lets a caller prove it read
 * the intended file. It adds no security over the file check (a caller controls both), so it is
 * optional — but a mismatch is always refused.
 */
export const SECRET_VALUE_ENV = "PI_MODES_CLI_SECRET";
/**
 * Retired. The gate is now armed by default, so nothing needs to request it. Accepted and ignored
 * so an env line written before this change does not silently start meaning something else.
 */
export const SECRET_REQUIRED_ENV = "PI_MODES_CLI_SECRET_REQUIRED";

/** Where an approved leader may keep a secret for this CLI. Deliberately NOT populated. */
export const DEFAULT_SECRET_FILE = join(homedir(), ".pi", "agent", "secrets", "pi-modes-cli");

/** The sentence that turns a wall into a handoff; tests assert on it. */
export const ESCALATION =
  "The pi-modes CLI is restricted to approved leaders. If you need it, ask the " +
  "self-improvement leader (or the operator) to run it for you or to grant access.";

export type AuthOutcome = { ok: true; enforced: boolean } | { ok: false; message: string };

/**
 * Whether the gate is armed. **Armed by default: absence of any environment means armed.** This is
 * deliberate — pil drops unknown keys from `.pi/launch.env` and a running herdr server freezes the
 * environment of the panes it spawns, so an env var that must be *set* to arm cannot gate a running
 * fleet. Arming by default applies the moment the code ships, with no environment at all.
 */
export function authRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUTH_DISABLED_ENV] !== "1";
}

function secretPath(env: NodeJS.ProcessEnv): string {
  return env[SECRET_FILE_ENV]?.trim() || DEFAULT_SECRET_FILE;
}

/**
 * Checks the gate. Armed by default; returns `{ok: true}` only when a valid secret file is present
 * at the configured path (and, if a caller value was supplied, it matches). It reads only the
 * configured file — never writes, never creates, never prompts.
 */
export function checkAuth(env: NodeJS.ProcessEnv = process.env): AuthOutcome {
  if (!authRequired(env)) return { ok: true, enforced: false };

  const path = secretPath(env);
  let expected: string;
  try {
    // Refuse a group/world-readable secret rather than silently accepting a leaked one.
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      return {
        ok: false,
        message:
          `Refusing to use the pi-modes CLI secret at ${path}: it is group/world-readable ` +
          `(mode ${mode.toString(8)}). Tighten it with: chmod 600 ${path}\n${ESCALATION}`,
      };
    }
    expected = readFileSync(path, "utf8").trim();
  } catch (error) {
    return {
      ok: false,
      message:
        `Refusing to use the pi-modes CLI: it is restricted to approved leaders and no secret file ` +
        `was found at ${path} (${error instanceof Error ? error.message : String(error)}). ` +
        `Point ${SECRET_FILE_ENV} at an approved leader's secret file to use it.\n${ESCALATION}`,
    };
  }
  if (!expected) {
    return {
      ok: false,
      message: `Refusing to use the pi-modes CLI: the secret file at ${path} is empty.\n${ESCALATION}`,
    };
  }

  // Optional assertion. A caller that supplies the value must have read the file we just read.
  const supplied = env[SECRET_VALUE_ENV]?.trim();
  if (supplied && supplied !== expected) {
    return {
      ok: false,
      message: `Refusing to use the pi-modes CLI: the supplied secret does not match ${path}.\n${ESCALATION}`,
    };
  }
  return { ok: true, enforced: true };
}
