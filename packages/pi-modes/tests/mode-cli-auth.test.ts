import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AUTH_DISABLED_ENV,
  authRequired,
  checkAuth,
  DEFAULT_SECRET_FILE,
  ESCALATION,
  SECRET_FILE_ENV,
  SECRET_REQUIRED_ENV,
  SECRET_VALUE_ENV,
} from "../src/mode-cli-auth.ts";

const CLI = join(import.meta.dirname, "..", "scripts", "mode-cli.ts");
const SECRET = "s3cret-and-long-enough-to-not-guess";

/** The auth env vars, so each case starts from a clean slate rather than the caller's shell. */
const AUTH_ENV_KEYS = [
  AUTH_DISABLED_ENV,
  SECRET_FILE_ENV,
  SECRET_VALUE_ENV,
  SECRET_REQUIRED_ENV,
] as const;

function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of AUTH_ENV_KEYS) delete base[key];
  return { ...base, ...extra } as NodeJS.ProcessEnv;
}

function secretFile(dir: string, value = SECRET, mode = 0o600): string {
  const path = join(dir, "secret");
  writeFileSync(path, `${value}\n`);
  chmodSync(path, mode);
  return path;
}

/** Runs the real CLI with a clean auth environment plus whatever the case needs. */
function runCli(args: string[], extra: Record<string, string | undefined>) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env: cleanEnv(extra),
  });
}

test("ARMED by default: a clean environment with no auth vars means armed", () => {
  // The important one: assert with the env var explicitly UNSET, not set to "1".
  const env = cleanEnv();
  assert.equal(SECRET_REQUIRED_ENV in env, false);
  assert.equal(authRequired(env), true);
});

test("only the explicit disarm hatch turns the gate off", () => {
  assert.equal(authRequired(cleanEnv({ [AUTH_DISABLED_ENV]: "1" })), false);
  // The retired var neither arms nor disarms: it is accepted and ignored.
  assert.equal(authRequired(cleanEnv({ [SECRET_REQUIRED_ENV]: "0" })), true);
  assert.equal(authRequired(cleanEnv({ [SECRET_REQUIRED_ENV]: "1" })), true);
});

test("a refusal names the escalation, the path, and how to fix it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-auth-missing-"));
  try {
    const result = checkAuth(cleanEnv({ [SECRET_FILE_ENV]: join(dir, "absent") }));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /restricted to approved leaders/);
    assert.match(result.ok ? "" : result.message, new RegExp(ESCALATION.slice(0, 40)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a group/world-readable secret rather than accepting a leaked one", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-auth-loose-"));
  try {
    const path = secretFile(dir, SECRET, 0o644);
    const result = checkAuth(cleanEnv({ [SECRET_FILE_ENV]: path }));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /group\/world-readable/);
    assert.match(result.ok ? "" : result.message, /chmod 600/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a valid secret file is accepted, and an optional mismatched value refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-auth-ok-"));
  try {
    const path = secretFile(dir);
    assert.deepEqual(checkAuth(cleanEnv({ [SECRET_FILE_ENV]: path })), {
      ok: true,
      enforced: true,
    });
    // Supplying a matching value is fine; a mismatch is refused.
    assert.deepEqual(checkAuth(cleanEnv({ [SECRET_FILE_ENV]: path, [SECRET_VALUE_ENV]: SECRET })), {
      ok: true,
      enforced: true,
    });
    const wrong = checkAuth(cleanEnv({ [SECRET_FILE_ENV]: path, [SECRET_VALUE_ENV]: "nope" }));
    assert.equal(wrong.ok, false);
    assert.match(wrong.ok ? "" : wrong.message, /does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty secret file is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-auth-empty-"));
  try {
    const path = secretFile(dir, "");
    const result = checkAuth(cleanEnv({ [SECRET_FILE_ENV]: path }));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI refuses by DEFAULT with a clean environment, before doing any work", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-auth-default-"));
  try {
    const session = join(dir, "derived-truth.jsonl");
    writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "t" })}\n`);
    const result = runCli(["state", session], {});
    assert.equal(result.status, 6);
    assert.match(result.stderr, /restricted to approved leaders/);
    assert.match(result.stderr, new RegExp(ESCALATION.slice(0, 40)));
    // It never got as far as reporting the session file: no work happened.
    assert.doesNotMatch(result.stderr, /session file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the disarm hatch lets the same call through ungated", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-auth-hatch-"));
  try {
    const session = join(dir, "s.jsonl");
    writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "t" })}\n`);
    const result = runCli(["state", session], { [AUTH_DISABLED_ENV]: "1" });
    // No v3 entry: exit 1 means auth let the work through.
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /restricted to approved leaders/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI proceeds with a valid secret file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-auth-run-"));
  try {
    const path = secretFile(dir);
    const session = join(dir, "s.jsonl");
    writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "t" })}\n`);
    const result = runCli(["state", session], { [SECRET_FILE_ENV]: path });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /restricted to approved leaders/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The property the reviewer most wanted to confirm by hand: a refusal must not echo the caller's
// arguments or touch the session file. Pinned here so it cannot regress into a path leak.
test("a refusal leaks neither the caller's arguments nor the session path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-modes-auth-leak-"));
  try {
    const session = join(dir, "leaky-session-name.jsonl");
    writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "t" })}\n`);
    for (const args of [
      ["state", session, "--json", "--key", "leader"],
      ["expected", session, "--json"],
      ["attest", session, "--expect", "a".repeat(64)],
    ]) {
      const result = runCli(args, {});
      assert.equal(result.status, 6, `${args[0]} must be refused`);
      const output = `${result.stdout}${result.stderr}`;
      assert.doesNotMatch(output, /leaky-session-name/, `${args[0]} leaked the session path`);
      assert.doesNotMatch(output, /--json|--key|--expect/, `${args[0]} echoed caller arguments`);
      assert.match(result.stderr, new RegExp(ESCALATION.slice(0, 40)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the documented default secret path is deliberately not the one leaders use", () => {
  assert.match(DEFAULT_SECRET_FILE, /\.pi\/agent\/secrets\/pi-modes-cli$/);
});
