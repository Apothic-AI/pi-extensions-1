/**
summary: "Read a lane's recorded mode state from a session file and compare it to the definition it read."
read_when:
  - "Building or changing the out-of-band pi-modes CLI (state / reapprove)."
  - "Diagnosing a lane that composes native after a mode-file edit."
*/
import { readFileSync } from "node:fs";
import { ancestorModeDirectories, loadModes, readModeFile } from "./mode-definitions.ts";
import {
  type DefinitionFingerprint,
  type LoadedModes,
  MODE_STATE_TYPE_V3,
  type ModeStateV3,
  modeDefinitionFingerprint,
  type ResolvedMode,
  selectedKeys,
} from "./modes.ts";

/** The v3 entry a lane last recorded, as read from its session file. */
export interface RecordedModeState {
  state: ModeStateV3;
  /** The entry's own timestamp, so callers can order several v3 entries. */
  timestamp?: string;
}

/**
 * The last well-formed v3 entry in a session file, or undefined when the lane never recorded one.
 * Reads the file directly: a session branch is a linear file, and the last v3 entry is the active
 * one (`selectionFromEntries` keeps the last entry it can parse). This is read-only and is therefore
 * safe against a session a live agent still holds — unlike anything that appends.
 */
export function readRecordedModeState(sessionPath: string): RecordedModeState | undefined {
  let text: string;
  try {
    text = readFileSync(sessionPath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read session file ${sessionPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let last: RecordedModeState | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes(MODE_STATE_TYPE_V3)) continue;
    let entry: { customType?: unknown; data?: unknown; timestamp?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.customType !== MODE_STATE_TYPE_V3) continue;
    // parseModeStateV3 is not exported; validate by shape through the same loader the runtime uses.
    const state = coerceV3State(entry.data);
    if (!state) continue;
    last = {
      state,
      ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
    };
  }
  return last;
}

/**
 * The v3 payload validated exactly as the runtime validates it: the same field set, the same digest
 * shape, and one fingerprint per selected key. Kept local because parseV3State is not exported and
 * this must not drift into accepting state the runtime would reject.
 */
function coerceV3State(data: unknown): ModeStateV3 | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = data as Record<string, unknown>;
  const allowed = new Set([
    "baseKey",
    "overlayKeys",
    "fingerprints",
    "driftPolicy",
    "activatedAt",
    "source",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (value.baseKey !== null && typeof value.baseKey !== "string") return undefined;
  if (!Array.isArray(value.overlayKeys) || !value.overlayKeys.every((k) => typeof k === "string")) {
    return undefined;
  }
  if (
    value.driftPolicy !== "block" &&
    value.driftPolicy !== "warn" &&
    value.driftPolicy !== "allow"
  ) {
    return undefined;
  }
  if (typeof value.activatedAt !== "string" || typeof value.source !== "string") return undefined;
  if (!value.fingerprints || typeof value.fingerprints !== "object") return undefined;
  const fingerprints = value.fingerprints as Record<string, unknown>;
  const normalized: Record<string, DefinitionFingerprint> = {};
  for (const [key, item] of Object.entries(fingerprints)) {
    if (!item || typeof item !== "object") return undefined;
    const fingerprint = item as Record<string, unknown>;
    if (typeof fingerprint.digest !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint.digest)) {
      return undefined;
    }
    if (typeof fingerprint.scope !== "string") return undefined;
    if (fingerprint.path !== null && typeof fingerprint.path !== "string") return undefined;
    normalized[key] = {
      digest: fingerprint.digest,
      scope: fingerprint.scope as DefinitionFingerprint["scope"],
      path: fingerprint.path as string | null,
    };
  }
  return {
    baseKey: value.baseKey as string | null,
    overlayKeys: value.overlayKeys as string[],
    fingerprints: normalized,
    driftPolicy: value.driftPolicy,
    activatedAt: value.activatedAt,
    source: value.source as ModeStateV3["source"],
  };
}

/** One selected key's recorded digest next to the digest of the definition at its recorded path. */
export interface FingerprintComparison {
  key: string;
  recordedDigest: string;
  recordedScope: string;
  recordedPath: string | null;
  /** The digest at the recorded path right now; undefined when the path is gone (the copy was swept). */
  currentDigest?: string;
  currentScope?: string;
  currentPath?: string | null;
  /** True when the recorded digest equals the digest of the definition at the recorded path. */
  matches?: boolean;
  /** Why the comparison could not be made, when it could not. */
  problem?: string;
}

/**
 * What a recorded fingerprint says about a lane right now. `unknown` is deliberately distinct from
 * `match`: it means the comparison could not be made (the recorded instance copy was swept when its
 * launch ended), NOT that the lane is fine. Collapsing it into `match` is how a swept copy reads as
 * healthy.
 */
export type CompareVerdict = "match" | "drift" | "unknown";

export function compareVerdict(comparison: FingerprintComparison): CompareVerdict {
  if (comparison.problem) return "unknown";
  return comparison.matches ? "match" : "drift";
}

/**
 * Compares a recorded fingerprint to the definition the lane would load NOW. `current` must be the
 * mode as the runtime resolves it — through `loadModes`, which composes a project `append` over its
 * global base. Fingerprinting the recorded file standalone is only a fallback for when the key is no
 * longer resolvable: for a composed mode the two differ, and using the standalone digest reports a
 * spurious DRIFT (measured: a project `append` lane that recorded 079814bb… was reported as drift
 * against 9868a9a9…, the standalone hash of the very same file).
 */
export function compareFingerprint(
  fingerprint: DefinitionFingerprint,
  key: string,
  current?: ResolvedMode,
): FingerprintComparison {
  const base: FingerprintComparison = {
    key,
    recordedDigest: fingerprint.digest,
    recordedScope: fingerprint.scope,
    recordedPath: fingerprint.path,
  };
  let mode = current;
  if (!mode) {
    if (!fingerprint.path) {
      return { ...base, problem: "recorded fingerprint has no path (builtin mode)" };
    }
    try {
      const { definition } = readModeFile(fingerprint.path);
      mode = { ...definition, scope: fingerprint.scope, path: fingerprint.path };
    } catch (error) {
      return {
        ...base,
        problem: `recorded path is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const resolved = modeDefinitionFingerprint(mode);
  return {
    ...base,
    currentDigest: resolved.digest,
    currentScope: resolved.scope,
    currentPath: resolved.path,
    matches: resolved.digest === fingerprint.digest,
  };
}

/**
 * Loads modes the way the runtime does for a lane: the global mode dir plus every project `.pi/modes`
 * from the filesystem root down to `cwd`. Composition happens here, so a project `append` over a
 * global base comes back already composed — which is what the lane records and compares.
 */
export function resolveCurrentModes(options: { cwd?: string; globalModeDir: string }): LoadedModes {
  return loadModes({
    globalDir: options.globalModeDir,
    ...(options.cwd ? { projectDir: `${options.cwd}/.pi/modes` } : {}),
    projectDirs: options.cwd ? ancestorModeDirectories(options.cwd) : [],
    projectTrusted: true,
  });
}

/** The `cwd` recorded in a session header — the lane's project directory, for project-mode discovery. */
export function readSessionCwd(sessionPath: string): string | undefined {
  let firstLine: string;
  try {
    const text = readFileSync(sessionPath, "utf8");
    const end = text.indexOf("\n");
    firstLine = end === -1 ? text : text.slice(0, end);
  } catch {
    return undefined;
  }
  try {
    const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
    if (header.type === "session" && typeof header.cwd === "string") return header.cwd;
  } catch {
    /* An unreadable header is not fatal: project dirs are simply unknown. */
  }
  return undefined;
}

/**
 * The mode to fingerprint as "current" for a key, or undefined when the recorded file itself is the
 * definition. Composition happens **only at the project layer** (a project `append` over the
 * definition it shares a key with), so:
 *
 * - `project` scope: the loaded, possibly-composed mode is the definition. Its path is the project
 *   file, and its digest folds in the global base's text.
 * - `builtin` scope: the loader's builtin definition is the digest; there is no file to read.
 * - `global` scope: the definition is exactly the recorded file. This matters for a profile lane,
 *   whose global mode is its *instance copy* — the path is part of the fingerprint, so re-resolving
 *   it from the real agent dir would produce a different (wrong) digest. Read it at the recorded path.
 */
function currentModeFor(
  state: ModeStateV3,
  key: string,
  loaded: LoadedModes,
): ResolvedMode | undefined {
  // A global row is the one case the recorded path must win: its file is the definition, and for a
  // profile lane that file is the instance copy. Everything else (project, builtin) is what the
  // loader resolves, which is also what the runtime fingerprints.
  if (state.fingerprints[key]?.scope === "global") return undefined;
  return loaded.modes.find((mode) => mode.key === key);
}

/** Compares every selected key of a recorded state against the modes the lane would load now. */
export function compareState(
  state: ModeStateV3,
  options: { cwd?: string; globalModeDir: string; keys?: readonly string[] },
): FingerprintComparison[] {
  const loaded = resolveCurrentModes(options);
  const keys = options.keys ?? selectedKeys(state);
  return keys
    .map((key) => {
      const fingerprint = state.fingerprints[key];
      if (!fingerprint) return undefined;
      return compareFingerprint(fingerprint, key, currentModeFor(state, key, loaded));
    })
    .filter((value): value is FingerprintComparison => value !== undefined);
}

/**
 * The per-key digests a lane would record right now, resolved the way the runtime resolves them
 * (composition included for project modes). This is exactly the value `/mode-reapprove --expect`
 * accepts and the value the lane recomputes — so it must not be a standalone hash of the recorded
 * file when that file composes with a global base.
 */
export function expectedDigestsForState(
  state: ModeStateV3,
  options: { cwd?: string; globalModeDir: string },
): { key: string; digest: string; path: string | null }[] {
  const loaded = resolveCurrentModes(options);
  return selectedKeys(state).map((key) => {
    const mode =
      currentModeFor(state, key, loaded) ?? resolveRecordedMode(state.fingerprints[key], key);
    const fingerprint = modeDefinitionFingerprint(mode);
    return { key, digest: fingerprint.digest, path: fingerprint.path };
  });
}

/**
 * The mode a selection names, read from the recorded path, when `loadModes` no longer resolves the
 * key (for example its project file was deleted). Throws when that path is gone too, because no
 * digest can be computed from a definition that is not there.
 */
function resolveRecordedMode(
  fingerprint: DefinitionFingerprint | undefined,
  key: string,
): ResolvedMode {
  if (!fingerprint?.path) throw new Error(`mode is unavailable: ${key}`);
  const { definition } = readModeFile(fingerprint.path);
  return { ...definition, scope: fingerprint.scope, path: fingerprint.path };
}

/** The keys a recorded state selects, in composition order. */
export function recordedKeys(state: ModeStateV3): string[] {
  return selectedKeys(state);
}
