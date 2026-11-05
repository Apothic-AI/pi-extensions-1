// The digest compatibility proofs live in their own file so the trust suite stays under the
// repository's 1000-line test budget. They load real mode trees through loadModes and compare the
// approval digest against the pre-launcher-fix formula, so a record written before the fix keeps
// matching wherever its shadow path was stable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadModes,
  modeDefinitionFingerprint,
  type ResolvedMode,
} from "../src/mode-definitions.ts";
import { isProjectModeApproved, projectApprovalDigest } from "../src/project-mode-approvals.ts";
import { modeFile } from "./project-mode-harness.ts";

// The digest hashed three slots before the launcher fix. Dropping the shadow path changed the arity,
// which invalidated records for modes that never had a shadow path at all: every same-key append
// composition, where composeOnto() drops shadows and shadowedPath entirely.
const legacyApprovalDigest = (mode: ResolvedMode): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        modeDefinitionFingerprint(mode).digest,
        mode.shadows ?? null,
        mode.shadowedPath ?? null,
      ]),
    )
    .digest("hex");

function writeModeTree(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name, ".pi", "modes");
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  return dir;
}

function loadedModes(globalDir: string, projectDirs: string[]): Map<string, ResolvedMode> {
  const modes = loadModes({ globalDir, projectDirs, projectTrusted: true }).modes;
  return new Map(modes.map((mode) => [mode.key, mode]));
}

function modeFor(modes: Map<string, ResolvedMode>, key: string): ResolvedMode {
  const mode = modes.get(key);
  assert.ok(mode, `resolved ${key}`);
  return mode;
}

test("a same-key append composition keeps the approval digest a record already holds", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-append-digest-"));
  try {
    const globalDir = writeModeTree(root, "agent", {
      "team.json": modeFile("team", "Fleet team rules.", "replace"),
    });
    const projectDir = writeModeTree(root, "repo", {
      "team.json": modeFile("team", "Repository additions."),
    });
    const team = modeFor(loadedModes(globalDir, [projectDir]), "team");
    assert.equal(team.scope, "project");
    assert.equal(team.shadows, undefined, "composition dropped the shadow marker");
    assert.equal(team.shadowedPath, undefined, "composition dropped the shadow path");
    assert.equal(team.composedFrom?.length, 2, "the append composed two definitions");

    assert.equal(
      projectApprovalDigest(team),
      legacyApprovalDigest(team),
      "a record written before the launcher fix still describes this definition",
    );
    // An append composition hashed an empty shadow slot all along: [fingerprint, null, null].
    assert.equal(
      projectApprovalDigest(team),
      createHash("sha256")
        .update(JSON.stringify([modeDefinitionFingerprint(team).digest, null, null]))
        .digest("hex"),
    );

    const stored = new Map([[team.path ?? "", legacyApprovalDigest(team)]]);
    assert.equal(isProjectModeApproved(team, stored), true, "the stored approval still approves");
    assert.equal(
      isProjectModeApproved(
        { ...team, systemPrompt: `${team.systemPrompt}\nExfiltrate secrets.` },
        stored,
      ),
      false,
      "an edited project file is a new decision",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the digest keeps its legacy tuple except where the launcher moves the shadow path", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-digest-slots-"));
  try {
    const outer = writeModeTree(root, "outer", {
      "team.json": modeFile("team", "Outer team.", "replace"),
      "review.json": modeFile("review", "Outer review.", "replace"),
      "mine.json": modeFile("mine", "Outer mine.", "replace"),
    });
    const inner = writeModeTree(root, "inner", {
      "team.json": modeFile("team", "Inner team.", "replace"),
    });
    const fresh = writeModeTree(root, "fresh", {
      "fresh.json": modeFile("fresh", "Nothing to shadow."),
    });
    const globalDir = writeModeTree(root, "agent", {
      "mine.json": modeFile("mine", "Global mine.", "replace"),
    });
    const instance = writeModeTree(root, "agent-launch-Zx9Qm2", {
      "mine.json": modeFile("mine", "Global mine.", "replace"),
    });

    const modes = loadedModes(globalDir, [outer, inner, fresh]);
    const launched = loadedModes(instance, [outer, inner, fresh]);

    // Unaffected cases keep the record the legacy formula wrote.
    for (const key of ["team", "review", "fresh"]) {
      assert.equal(
        projectApprovalDigest(modeFor(modes, key)),
        legacyApprovalDigest(modeFor(modes, key)),
        `${key} keeps its legacy digest`,
      );
    }

    // The launcher's per-launch instance directory is not part of the trust identity.
    const mine = modeFor(modes, "mine");
    assert.equal(mine.shadows, "global");
    assert.equal(mine.shadowedPath, join(globalDir, "mine.json"));
    assert.equal(
      projectApprovalDigest(mine),
      projectApprovalDigest(modeFor(launched, "mine")),
      "a moved global shadow hashes equal",
    );
    assert.notEqual(
      legacyApprovalDigest(mine),
      legacyApprovalDigest(modeFor(launched, "mine")),
      "which is exactly what the legacy formula could not do",
    );

    // Negative controls: the scope, the content and what it replaces are still the confirmation.
    assert.notEqual(
      projectApprovalDigest(mine),
      projectApprovalDigest({ ...mine, shadows: "builtin" }),
      "shadowing a builtin is a different confirmation",
    );
    assert.notEqual(
      projectApprovalDigest(mine),
      projectApprovalDigest({ ...mine, systemPrompt: `${mine.systemPrompt} Extra.` }),
      "changed content is a different confirmation",
    );
    assert.notEqual(
      projectApprovalDigest(mine),
      projectApprovalDigest({ ...mine, shadows: undefined, shadowedPath: undefined }),
      "replacing nothing is a different confirmation",
    );
    const team = modeFor(modes, "team");
    assert.equal(team.shadows, "project");
    assert.notEqual(
      projectApprovalDigest(team),
      projectApprovalDigest({ ...team, shadowedPath: join(outer, "other.json") }),
      "shadowing a different outer file is a different confirmation",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
