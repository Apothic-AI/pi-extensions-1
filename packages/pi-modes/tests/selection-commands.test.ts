import assert from "node:assert/strict";
import test from "node:test";
import { createModeState, parseModeDefinition, type ResolvedMode } from "../src/modes.ts";
import {
  parseDirectSelection,
  parseReapproveFlags,
  requiresReplaceFinalConfirmation,
  selectionDefinitionFingerprint,
} from "../src/selection-commands.ts";

function mode(
  key: string,
  promptStrategy: "append" | "replace_base" | "replace_final",
): ResolvedMode {
  return {
    ...parseModeDefinition({ key, label: key, promptStrategy, systemPrompt: key }),
    scope: "global",
  };
}

const modes = [
  mode("builder", "replace_base"),
  mode("exact", "replace_final"),
  mode("review", "append"),
  mode("explain", "append"),
];

test("legacy direct append selection becomes native plus one overlay", () => {
  assert.deepEqual(
    parseDirectSelection("review", modes, { baseKey: "builder", overlayKeys: ["explain"] })
      .selection,
    { baseKey: null, overlayKeys: ["review"] },
  );
});

test("plus and minus preserve base and deterministic overlay order", () => {
  const initial = { baseKey: "builder", overlayKeys: ["review"] };
  const added = parseDirectSelection("+explain", modes, initial).selection;
  assert.deepEqual(added, { baseKey: "builder", overlayKeys: ["review", "explain"] });
  assert.ok(added);
  assert.deepEqual(parseDirectSelection("-review", modes, added).selection, {
    baseKey: "builder",
    overlayKeys: ["explain"],
  });
});

test("set accepts exact ordered composition", () => {
  assert.deepEqual(
    parseDirectSelection("set builder --overlay explain --overlay review", modes, {
      baseKey: null,
      overlayKeys: [],
    }).selection,
    { baseKey: "builder", overlayKeys: ["explain", "review"] },
  );
});

test("every accepted direct selection is replayable at the shared overlay bound", () => {
  const overlays = Array.from({ length: 65 }, (_, index) =>
    mode(`o${String(index).padStart(2, "0")}`, "append"),
  );
  const allModes = [mode("builder", "replace_base"), ...overlays];
  const command = (count: number) =>
    `set builder ${overlays
      .slice(0, count)
      .map((overlay) => `--overlay ${overlay.key}`)
      .join(" ")}`;
  const accepted = parseDirectSelection(command(64), allModes, {
    baseKey: null,
    overlayKeys: [],
  });
  const acceptedSelection = accepted.selection;
  assert.ok(acceptedSelection);
  assert.equal(acceptedSelection.overlayKeys.length, 64);
  assert.doesNotThrow(() => createModeState(acceptedSelection, allModes, "command"));
  assert.match(
    parseDirectSelection(command(65), allModes, { baseKey: null, overlayKeys: [] }).error ?? "",
    /at most 64 overlays/,
  );
  assert.throws(
    () =>
      createModeState(
        { baseKey: "builder", overlayKeys: overlays.map((overlay) => overlay.key) },
        allModes,
        "command",
      ),
    /at most 64 overlays/,
  );
});

test("set rejects duplicate overlays and replace_final combinations", () => {
  assert.match(
    parseDirectSelection("set builder --overlay review --overlay review", modes, {
      baseKey: null,
      overlayKeys: [],
    }).error ?? "",
    /duplicate/,
  );
  assert.match(
    parseDirectSelection("set exact --overlay review", modes, { baseKey: null, overlayKeys: [] })
      .error ?? "",
    /exclusive/,
  );
});

test("plus refuses to weaken replace_final implicitly", () => {
  assert.match(
    parseDirectSelection("+review", modes, { baseKey: "exact", overlayKeys: [] }).error ?? "",
    /exclusive/,
  );
});

test("minus rejects unknown and unselected overlays", () => {
  assert.match(
    parseDirectSelection("-missing", modes, { baseKey: null, overlayKeys: [] }).error ?? "",
    /not an append overlay/,
  );
  assert.match(
    parseDirectSelection("-review", modes, { baseKey: null, overlayKeys: [] }).error ?? "",
    /not selected/,
  );
});

test("same-key replace_final strategy or byte drift requires fresh acknowledgement", () => {
  const oldBuilder = mode("builder", "replace_base");
  const approved = createModeState(
    { baseKey: "builder", overlayKeys: [] },
    [oldBuilder],
    "command",
  );
  const changedToExact = { ...oldBuilder, promptStrategy: "replace_final" as const };
  assert.equal(
    requiresReplaceFinalConfirmation(
      { baseKey: "builder", overlayKeys: [] },
      { baseKey: "builder", overlayKeys: [] },
      [changedToExact],
      approved.fingerprints,
    ),
    true,
  );
  const exactMode = modes.find((candidate) => candidate.key === "exact");
  assert.ok(exactMode);
  const approvedExact = createModeState(
    { baseKey: "exact", overlayKeys: [] },
    [exactMode],
    "command",
  );
  assert.equal(
    requiresReplaceFinalConfirmation(
      approvedExact,
      approvedExact,
      [exactMode],
      approvedExact.fingerprints,
    ),
    false,
  );
});

test("definition fingerprint detects prompt, strategy, scope, and provenance drift", () => {
  const selection = { baseKey: "builder", overlayKeys: ["review"] };
  const baseline = selectionDefinitionFingerprint(selection, modes);
  const changed = modes.map((candidate) =>
    candidate.key === "review" ? { ...candidate, systemPrompt: "changed" } : candidate,
  );
  assert.notEqual(selectionDefinitionFingerprint(selection, changed), baseline);
  const moved = modes.map((candidate) =>
    candidate.key === "builder"
      ? { ...candidate, scope: "project" as const, path: "/new" }
      : candidate,
  );
  assert.notEqual(selectionDefinitionFingerprint(selection, moved), baseline);
});

// --expect: the out-of-band attestation FT-40 asks for. The parser must accept exactly one
// lowercase sha256, reject a malformed or repeated value, and keep the interactive defaults.
const DIGEST = "a".repeat(64);

test("reapprove accepts --expect with a sha256 and passes it through", () => {
  const flags = parseReapproveFlags(["--confirm-project", "--expect", DIGEST]);
  assert.equal(flags.error, undefined);
  assert.equal(flags.project, true);
  assert.equal(flags.exact, false);
  assert.equal(flags.expectedDefinitionDigests.get(""), DIGEST);
  assert.deepEqual(flags.rest, []);
});

test("reapprove accepts a keyed --expect for a multi-mode selection", () => {
  const flags = parseReapproveFlags(["--expect", `leader=${DIGEST},writer=${DIGEST}`]);
  assert.equal(flags.error, undefined);
  assert.equal(flags.expectedDefinitionDigests.get("leader"), DIGEST);
  assert.equal(flags.expectedDefinitionDigests.get("writer"), DIGEST);
});

test("reapprove without --expect is unchanged for interactive use", () => {
  const flags = parseReapproveFlags(["--confirm-exact"]);
  assert.equal(flags.error, undefined);
  assert.equal(flags.exact, true);
  assert.equal(flags.expectedDefinitionDigests.size, 0);
});

test("reapprove rejects a malformed, missing, or repeated --expect", () => {
  assert.match(parseReapproveFlags(["--expect", "not-a-digest"]).error ?? "", /sha256/);
  assert.match(parseReapproveFlags(["--expect"]).error ?? "", /requires a sha256/);
  assert.match(
    parseReapproveFlags(["--expect", DIGEST, "--expect", DIGEST]).error ?? "",
    /only once/,
  );
  assert.match(
    parseReapproveFlags(["--expect", `bad key=${DIGEST}`]).error ?? "",
    /canonical mode key/,
  );
  assert.match(parseReapproveFlags(["--expect", "leader=nope"]).error ?? "", /sha256/);
  // Uppercase is normalised rather than rejected, so a caller's shell casing does not matter.
  assert.equal(
    parseReapproveFlags(["--expect", DIGEST.toUpperCase()]).expectedDefinitionDigests.get(""),
    DIGEST,
  );
});
