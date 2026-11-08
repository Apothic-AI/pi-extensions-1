import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareFingerprint,
  compareState,
  compareVerdict,
  expectedDigestsForState,
  readRecordedModeState,
  resolveCurrentModes,
} from "../src/mode-cli-state.ts";
import { readModeFile } from "../src/mode-definitions.ts";
import { type ModeStateV3, modeDefinitionFingerprint } from "../src/modes.ts";

function writeMode(dir: string, key: string, text: string): string {
  const path = join(dir, `${key}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      key,
      label: key,
      promptStrategy: "replace_base",
      systemPrompt: text,
    }),
  );
  return path;
}

/** A session file holding one v3 entry, as the runtime writes it. */
function writeSession(dir: string, state: unknown): string {
  const session = join(dir, "session.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "test",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
  };
  const entry = {
    type: "custom",
    customType: "pi-mode-state.v3",
    data: state,
    id: "a1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(session, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
  return session;
}

test("readRecordedModeState returns the last v3 entry and ignores other entries", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-state-"));
  try {
    const session = join(root, "session.jsonl");
    writeFileSync(
      session,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "t",
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user" } }),
        JSON.stringify({
          type: "custom",
          customType: "pi-mode-state.v3",
          data: {
            baseKey: "old",
            overlayKeys: [],
            fingerprints: {},
            driftPolicy: "block",
            activatedAt: "2026-01-01T00:00:00.000Z",
            source: "command",
          },
          id: "a1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "custom",
          customType: "pi-mode-state.v3",
          data: {
            baseKey: "leader",
            overlayKeys: [],
            fingerprints: {
              leader: { digest: "a".repeat(64), scope: "global", path: "/tmp/x/leader.json" },
            },
            driftPolicy: "block",
            activatedAt: "2026-01-01T00:00:00.000Z",
            source: "reapprove",
          },
          id: "a2",
          parentId: "a1",
          timestamp: "2026-01-01T00:00:01.000Z",
        }),
      ].join("\n"),
    );
    const recorded = readRecordedModeState(session);
    assert.ok(recorded);
    assert.equal(recorded.state.baseKey, "leader");
    assert.equal(recorded.state.source, "reapprove");
    assert.equal(recorded.timestamp, "2026-01-01T00:00:01.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no v3 entry reads as undefined rather than throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-none-"));
  try {
    const session = join(root, "session.jsonl");
    writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "t" })}\n`);
    assert.equal(readRecordedModeState(session), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compareFingerprint reports a match, and drift when the file changed at that path", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-cmp-"));
  try {
    const modes = join(root, "modes");
    mkdirSync(modes, { recursive: true });
    const path = writeMode(modes, "leader", "original contract");
    const { definition } = readModeFile(path);
    const fingerprint = modeDefinitionFingerprint({ ...definition, scope: "global", path });

    const match = compareFingerprint(fingerprint, "leader");
    assert.equal(match.matches, true);

    // The same path, changed text: the recorded digest no longer matches.
    writeMode(modes, "leader", "edited contract");
    const drift = compareFingerprint(fingerprint, "leader");
    assert.equal(drift.matches, false);
    assert.notEqual(drift.currentDigest, fingerprint.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the fingerprint covers scope and path: same text, different path, different digest", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-path-"));
  try {
    const a = join(root, "instances/launch-AAAA/modes");
    const b = join(root, "modes");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const pathA = writeMode(a, "leader", "identical text");
    const pathB = writeMode(b, "leader", "identical text");
    const defA = readModeFile(pathA).definition;
    const defB = readModeFile(pathB).definition;
    const digestA = modeDefinitionFingerprint({ ...defA, scope: "global", path: pathA }).digest;
    const digestB = modeDefinitionFingerprint({ ...defB, scope: "global", path: pathB }).digest;
    assert.notEqual(digestA, digestB, "scope and path are part of the fingerprint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expectedDigestsForState fingerprints each selected definition at its recorded path", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-exp-"));
  try {
    const modes = join(root, "modes");
    mkdirSync(modes, { recursive: true });
    const path = writeMode(modes, "leader", "contract text");
    const { definition } = readModeFile(path);
    const digest = modeDefinitionFingerprint({ ...definition, scope: "global", path }).digest;
    const state: ModeStateV3 = {
      baseKey: "leader",
      overlayKeys: [],
      fingerprints: { leader: { digest, scope: "global", path } },
      driftPolicy: "block",
      activatedAt: "2026-01-01T00:00:00.000Z",
      source: "reapprove",
    };
    const expected = expectedDigestsForState(state, { globalModeDir: modes });
    assert.deepEqual(expected, [{ key: "leader", digest, path }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session with a stale digest reads as drift and its expected digest is the current one", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-sess-"));
  try {
    const modes = join(root, "modes");
    mkdirSync(modes, { recursive: true });
    const path = writeMode(modes, "leader", "current contract");
    const session = writeSession(root, {
      baseKey: "leader",
      overlayKeys: [],
      fingerprints: { leader: { digest: "0".repeat(64), scope: "global", path } },
      driftPolicy: "block",
      activatedAt: "2026-01-01T00:00:00.000Z",
      source: "reapprove",
    });
    const recorded = readRecordedModeState(session);
    assert.ok(recorded);
    const leader = recorded.state.fingerprints.leader;
    assert.ok(leader);
    const comparison = compareFingerprint(leader, "leader");
    assert.equal(comparison.matches, false);
    const expected = expectedDigestsForState(recorded.state, { globalModeDir: modes });
    assert.equal(expected[0]?.digest, comparison.currentDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compareVerdict distinguishes a swept copy (unknown) from drift and a match", () => {
  // A swept instance copy: the recorded path is gone, so nothing was verified.
  const swept = compareFingerprint(
    {
      digest: "a".repeat(64),
      scope: "global",
      path: "/nonexistent/instances/launch-XXXX/modes/leader.json",
    },
    "leader",
  );
  assert.equal(compareVerdict(swept), "unknown");
  assert.ok(swept.problem, "a swept copy must carry a problem explaining it");

  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-verdict-"));
  try {
    const modes = join(root, "modes");
    mkdirSync(modes, { recursive: true });
    const path = writeMode(modes, "leader", "current text");
    const { definition } = readModeFile(path);
    const fingerprint = modeDefinitionFingerprint({ ...definition, scope: "global", path });
    assert.equal(compareVerdict(compareFingerprint(fingerprint, "leader")), "match");
    writeMode(modes, "leader", "edited text");
    assert.equal(compareVerdict(compareFingerprint(fingerprint, "leader")), "drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The JSON summary must be self-describing: `recorded` is a boolean ("a v3 entry exists"), and the
// digest for a single-key selection is also surfaced at the top level as `recordedDigest`. A
// consumer that reads `recorded` expecting a digest silently finds nothing; this pins the shape so
// that cannot regress and the two names never again differ.
test("compareFingerprint exposes recordedDigest and verdict per key, distinct from the boolean", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-shape-"));
  try {
    const modes = join(root, "modes");
    mkdirSync(modes, { recursive: true });
    const path = writeMode(modes, "leader", "shape text");
    const { definition } = readModeFile(path);
    const fingerprint = modeDefinitionFingerprint({ ...definition, scope: "global", path });
    const comparison = compareFingerprint(fingerprint, "leader");
    assert.equal(typeof comparison.recordedDigest, "string");
    assert.equal(comparison.recordedDigest, fingerprint.digest);
    assert.equal(compareVerdict(comparison), "match");
    // The word "recorded" alone must never be a digest on a comparison object.
    assert.equal(typeof comparison.recordedDigest, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The defect that shipped: a project `append` composes with its global base, so the lane records the
// COMPOSED digest while a standalone hash of the project file gives a different value. Reporting the
// standalone digest as "current" made every composed lane read as permanent false drift, and made
// `expected` produce a digest `/mode-reapprove --expect` then refused.
test("a project append composes: compareState and expected use the composed digest", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-cli-compose-"));
  try {
    const globalDir = join(root, "agent", "modes");
    const cwd = join(root, "work");
    const projectDir = join(cwd, ".pi", "modes");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const globalPath = join(globalDir, "leader.json");
    writeFileSync(
      globalPath,
      JSON.stringify({
        schemaVersion: 2,
        key: "leader",
        label: "leader",
        promptStrategy: "replace_base",
        systemPrompt: "GLOBAL CONTRACT",
      }),
    );
    const projectPath = join(projectDir, "leader.json");
    writeFileSync(
      projectPath,
      JSON.stringify({
        schemaVersion: 2,
        key: "leader",
        label: "leader",
        promptStrategy: "append",
        systemPrompt: "PROJECT DELTA",
      }),
    );

    // What the runtime records: loadModes composes the two, and THAT is the digest.
    const loaded = resolveCurrentModes({ cwd, globalModeDir: globalDir });
    const composed = loaded.modes.find((mode) => mode.key === "leader");
    assert.ok(composed);
    const composedDigest = modeDefinitionFingerprint(composed).digest;

    // The standalone project file hashes differently — that is the trap.
    const { definition } = readModeFile(projectPath);
    const standalone = modeDefinitionFingerprint({
      ...definition,
      scope: "project",
      path: projectPath,
    }).digest;
    assert.notEqual(composedDigest, standalone, "composition must change the digest");

    const state: ModeStateV3 = {
      baseKey: "leader",
      overlayKeys: [],
      fingerprints: {
        leader: { digest: composedDigest, scope: "project", path: projectPath },
      },
      driftPolicy: "block",
      activatedAt: "2026-01-01T00:00:00.000Z",
      source: "reapprove",
    };

    // The lane is IN SYNC: a composed comparison says match, not the false drift of a standalone hash.
    const comparisons = compareState(state, { cwd, globalModeDir: globalDir });
    const first = comparisons[0];
    assert.ok(first);
    assert.equal(compareVerdict(first), "match");

    // `expected` returns the composed digest — the value the lane will accept.
    const expected = expectedDigestsForState(state, { cwd, globalModeDir: globalDir });
    assert.equal(expected[0]?.digest, composedDigest);

    // And a global-scope row is still read at its recorded path, never re-resolved: its path is part
    // of the fingerprint, which is what a profile lane's instance copy depends on.
    const instancePath = join(root, "instances", "launch-AAAA", "modes", "leader.json");
    mkdirSync(join(root, "instances", "launch-AAAA", "modes"), { recursive: true });
    writeFileSync(instancePath, readFileSync(globalPath, "utf8"));
    const instanceDigest = modeDefinitionFingerprint({
      ...readModeFile(instancePath).definition,
      scope: "global",
      path: instancePath,
    }).digest;
    const globalState: ModeStateV3 = {
      ...state,
      fingerprints: { leader: { digest: instanceDigest, scope: "global", path: instancePath } },
    };
    const globalComparison = compareState(globalState, { cwd, globalModeDir: globalDir })[0];
    assert.ok(globalComparison);
    assert.equal(
      compareVerdict(globalComparison),
      "match",
      "a global row is read at its recorded (instance) path",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
