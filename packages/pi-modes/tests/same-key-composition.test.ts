import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadModes, resolveModeSelection } from "../src/modes.ts";

const GLOBAL = "the fleet contract";
const PROJECT = "this space's addition";
const OUTER = "an outer directory's addition";
const INNER = "the innermost addition";

function modeFile(key: string, promptStrategy: string, systemPrompt: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    key,
    label: key,
    description: `${key} for the test`,
    promptStrategy,
    systemPrompt,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-compose-"));
  const globalDir = join(root, "global");
  const outer = join(root, "outer", ".pi", "modes");
  const cwd = join(root, "space");
  const projectDir = join(cwd, ".pi", "modes");
  mkdirSync(globalDir, { recursive: true });
  return { root, globalDir, outer, cwd, projectDir };
}

function write(dir: string, key: string, promptStrategy: string, prompt: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), modeFile(key, promptStrategy, prompt));
}

test("a same-key project append composes with the definition it extends", () => {
  const f = fixture();
  write(f.globalDir, "leader", "replace_base", GLOBAL);
  write(f.projectDir, "leader", "append", PROJECT);

  const loaded = loadModes({
    globalDir: f.globalDir,
    projectDir: f.projectDir,
    projectTrusted: true,
  });
  const leader = loaded.modes.find((mode) => mode.key === "leader");

  assert.equal(leader?.systemPrompt, `${GLOBAL}\n\n${PROJECT}`);
  // The shallower host strategy survives: a contract that replaces the base prompt still does.
  assert.equal(leader?.promptStrategy, "replace_base");
  assert.equal(leader?.scope, "project");
  assert.equal(leader?.composedFrom?.length, 2);
  assert.equal(leader?.shadows, undefined);
  // The shallower text is kept for the case where the project half cannot be used.
  assert.equal(leader?.fallback?.systemPrompt, GLOBAL);
  assert.equal(leader?.fallback?.scope, "global");
});

test("replace says shadow rather than compose, and is settled before selection", () => {
  const f = fixture();
  write(f.globalDir, "leader", "replace_base", GLOBAL);
  write(f.projectDir, "leader", "replace", PROJECT);

  const leader = loadModes({
    globalDir: f.globalDir,
    projectDir: f.projectDir,
    projectTrusted: true,
  }).modes.find((mode) => mode.key === "leader");

  assert.equal(leader?.systemPrompt, PROJECT);
  assert.equal(leader?.shadows, "global");
  assert.equal(leader?.composedFrom, undefined);
  assert.equal(leader?.promptStrategy, "replace_base");
});

test("a project definition with no strategy still shadows, as it always did", () => {
  const f = fixture();
  write(f.globalDir, "leader", "replace_base", GLOBAL);
  write(f.projectDir, "leader", "replace_base", PROJECT);

  const leader = loadModes({
    globalDir: f.globalDir,
    projectDir: f.projectDir,
    projectTrusted: true,
  }).modes.find((mode) => mode.key === "leader");

  assert.equal(leader?.systemPrompt, PROJECT);
  assert.equal(leader?.shadows, "global");
});

test("a built-in definition composes too", () => {
  const f = fixture();
  write(f.projectDir, "review", "append", PROJECT);

  const loaded = loadModes({
    globalDir: f.globalDir,
    projectDir: f.projectDir,
    projectTrusted: true,
  });
  const review = loaded.modes.find((mode) => mode.key === "review");

  assert.equal(review?.scope, "project");
  assert.equal(review?.composedFrom?.[0]?.scope, "builtin");
  assert.ok(review?.systemPrompt.endsWith(PROJECT));
});

test("every ancestor that appends composes, root to cwd", () => {
  const f = fixture();
  write(f.globalDir, "leader", "replace_base", GLOBAL);
  write(f.outer, "leader", "append", OUTER);
  write(f.projectDir, "leader", "append", INNER);

  const leader = loadModes({
    globalDir: f.globalDir,
    projectDirs: [f.outer, f.projectDir],
    projectTrusted: true,
  }).modes.find((mode) => mode.key === "leader");

  assert.equal(leader?.systemPrompt, `${GLOBAL}\n\n${OUTER}\n\n${INNER}`);
  assert.deepEqual(
    leader?.composedFrom?.map((part) => part.scope),
    ["global", "project", "project"],
  );
});

test("a project append with no shallower definition stands alone", () => {
  const f = fixture();
  write(f.projectDir, "solo", "append", PROJECT);

  const solo = loadModes({
    globalDir: f.globalDir,
    projectDir: f.projectDir,
    projectTrusted: true,
  }).modes.find((mode) => mode.key === "solo");

  assert.equal(solo?.promptStrategy, "append");
  assert.equal(solo?.systemPrompt, PROJECT);
  assert.equal(solo?.composedFrom, undefined);
  assert.equal(solo?.shadows, undefined);
});

test("an unconfirmed project half drops its own text and keeps the global contract", () => {
  const f = fixture();
  write(f.globalDir, "leader", "replace_base", GLOBAL);
  write(f.projectDir, "leader", "append", PROJECT);

  const loaded = loadModes({
    globalDir: f.globalDir,
    projectDir: f.projectDir,
    projectTrusted: true,
  });
  const resolved = resolveModeSelection(
    { baseKey: "leader", overlayKeys: [] },
    loaded.modes,
    // Nothing confirmed: the project half must not be used, and must not take the
    // definition it extends with it.
    { projectApprovals: new Map<string, string>() },
  );

  assert.equal(resolved.blocked, false);
  assert.ok(resolved.base, "the shallower definition still resolves");
  assert.equal(resolved.base?.systemPrompt, GLOBAL);
  assert.ok(
    resolved.diagnostics.some((diagnostic) => diagnostic.message.includes("project text dropped")),
    `expected a drop warning, got ${JSON.stringify(resolved.diagnostics)}`,
  );
});
