import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import modeExtension from "../extensions/mode.ts";
import {
  normalizeBuildSystemPromptOptions as hostOptions,
  buildSystemPrompt as hostPrompt,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { MODE_STATE_TYPE, MODE_STATE_TYPE_V2, MODE_STATE_TYPE_V3 } from "../src/modes.ts";

interface RegisteredCommand {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
}

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionCommandContext) => unknown;

/** What the model receives: Pi renders the options a handler leaves, unless it forces a prompt. */
async function turnPrompt(
  handler: EventHandler,
  ctx: ExtensionCommandContext,
  options: { cwd: string; selectedTools?: string[] },
): Promise<string> {
  const systemPromptOptions = hostOptions(options);
  const result = (await handler(
    {
      get systemPrompt() {
        return hostPrompt(systemPromptOptions);
      },
      systemPromptOptions,
    },
    ctx,
  )) as { systemPrompt?: string } | undefined;
  return result?.systemPrompt ?? hostPrompt(systemPromptOptions);
}

/** Pi's own prompt for these options, with no mode applied. */
function nativePrompt(options: { cwd: string; selectedTools?: string[] }): string {
  return hostPrompt(hostOptions(options));
}

function harness(
  initialEntries: unknown[] = [],
  options: { mode?: "rpc" | "tui"; confirm?: boolean; onConfirm?: () => void } = {},
) {
  const entries = [...initialEntries];
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, EventHandler[]>();
  const notifications: Array<{ message: string; type: string }> = [];
  const statuses: Array<string | undefined> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const pi = {
    registerEntryRenderer() {},
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(name: string, handler: EventHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;
  modeExtension(pi);
  const ctx = {
    mode: options.mode ?? "rpc",
    hasUI: true,
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => entries },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string, type: string) => notifications.push({ message, type }),
      confirm: async (title: string, message: string) => {
        confirms.push({ title, message });
        options.onConfirm?.();
        return options.confirm ?? false;
      },
    },
    getSystemPromptOptions: () => ({ cwd: process.cwd(), selectedTools: ["read"] }),
    getSystemPrompt: () => "HOST",
  } as unknown as ExtensionCommandContext;
  return { entries, commands, handlers, notifications, statuses, confirms, ctx };
}

test("new sessions inherit the process mode selection", async () => {
  const previous = process.env.PI_MODE;
  const previousComposition = process.env.PI_MODES;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-modes-new-session-"));
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PI_MODE = "review";
    delete process.env.PI_MODES;
    const h = harness();
    const handler = h.handlers.get("session_start")?.[0];
    assert.ok(handler);

    await handler({ reason: "new" }, h.ctx);
    const latest = h.entries.at(-1) as { customType: string; data: unknown };
    assert.equal(latest.customType, MODE_STATE_TYPE_V3);
    assert.deepEqual(
      {
        baseKey: (latest.data as { baseKey: unknown }).baseKey,
        overlayKeys: (latest.data as { overlayKeys: unknown }).overlayKeys,
        source: (latest.data as { source: string }).source,
      },
      { baseKey: null, overlayKeys: ["review"], source: "startup" },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_MODE;
    else process.env.PI_MODE = previous;
    if (previousComposition === undefined) delete process.env.PI_MODES;
    else process.env.PI_MODES = previousComposition;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume restores its session mode instead of applying the process mode", async () => {
  const previous = process.env.PI_MODE;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-modes-resume-session-"));
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PI_MODE = "review";
    const existing = {
      type: "custom",
      customType: MODE_STATE_TYPE_V3,
      data: { baseKey: null, overlayKeys: ["explain"] },
    };
    const h = harness([existing]);
    const handler = h.handlers.get("session_start")?.[0];
    assert.ok(handler);
    await handler({ reason: "resume" }, h.ctx);
    assert.equal(h.entries.at(-1), existing);
  } finally {
    if (previous === undefined) delete process.env.PI_MODE;
    else process.env.PI_MODE = previous;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_start freezes a legacy v1 append slot into fingerprinted v3", async () => {
  const h = harness([{ type: "custom", customType: MODE_STATE_TYPE, data: { key: "review" } }]);
  const handler = h.handlers.get("session_start")?.[0];
  assert.ok(handler);
  await handler({ reason: "reload" }, h.ctx);
  const latest = h.entries.at(-1) as { customType: string; data: unknown };
  assert.equal(latest.customType, MODE_STATE_TYPE_V3);
  assert.deepEqual(
    {
      baseKey: (latest.data as { baseKey: unknown }).baseKey,
      overlayKeys: (latest.data as { overlayKeys: unknown }).overlayKeys,
    },
    { baseKey: null, overlayKeys: ["review"] },
  );
  assert.equal((latest.data as { driftPolicy: string }).driftPolicy, "block");
  assert.match(
    (latest.data as { fingerprints: Record<string, { digest: string }> }).fingerprints.review
      .digest,
    /^[a-f0-9]{64}$/,
  );
});

test("headless direct syntax persists v3 and rejects invalid removals", async () => {
  const h = harness();
  const command = h.commands.get("mode");
  assert.ok(command);
  await command.handler("set native --overlay review --overlay explain", h.ctx);
  const state = h.entries.find(
    (entry) => (entry as { customType?: string }).customType === MODE_STATE_TYPE_V3,
  ) as { data: { baseKey: string | null; overlayKeys: string[]; source: string } };
  assert.deepEqual(
    { baseKey: state.data.baseKey, overlayKeys: state.data.overlayKeys },
    { baseKey: null, overlayKeys: ["review", "explain"] },
  );
  assert.equal(state.data.source, "command");
  await assert.rejects(async () => {
    await command.handler("-missing", h.ctx);
  }, /not an append overlay/);
});

test("headless exact activation requires explicit acknowledgement and status/preview emit JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-extension-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  mkdirSync(join(root, "modes"), { recursive: true });
  writeFileSync(
    join(root, "modes", "exact.json"),
    JSON.stringify({
      schemaVersion: 2,
      key: "exact",
      label: "Exact",
      promptStrategy: "replace_final",
      systemPrompt: " EXACT ",
    }),
  );
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => output.push(String(value));
  try {
    const h = harness();
    const mode = h.commands.get("mode");
    assert.ok(mode);
    await assert.rejects(async () => {
      await mode.handler("exact", h.ctx);
    }, /requires --confirm-exact/);
    await mode.handler("exact --confirm-exact", h.ctx);
    const latest = h.entries.at(-1) as { customType: string; data: { baseKey: string | null } };
    assert.equal(latest.customType, MODE_STATE_TYPE_V3);
    assert.equal(latest.data.baseKey, "exact");

    await h.commands.get("mode-status")?.handler("--json", h.ctx);
    await h.commands.get("mode-preview")?.handler("--json", h.ctx);
    const status = JSON.parse(output.at(-2) ?? "{}") as { composition?: { sha256?: string } };
    const preview = JSON.parse(output.at(-1) ?? "{}") as { prompt?: string };
    assert.match(status.composition?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(preview.prompt, " EXACT ");
    await mode.handler("save portable", h.ctx);
    await mode.handler("export portable", h.ctx);
    const exported = JSON.parse(output.at(-1) ?? "{}") as {
      preset?: Record<string, unknown>;
      encoded?: string;
    };
    assert.equal(exported.preset?.key, "portable");
    assert.equal("scope" in (exported.preset ?? {}), false);
    assert.equal("path" in (exported.preset ?? {}), false);
    assert.match(exported.encoded ?? "", /^[A-Za-z0-9_-]+$/);

    const denied = harness([], { mode: "tui", confirm: false });
    await denied.commands.get("mode")?.handler("exact", denied.ctx);
    assert.equal(
      denied.entries.some(
        (entry) => (entry as { customType?: string }).customType === MODE_STATE_TYPE_V3,
      ),
      false,
    );
    const allowed = harness([], { mode: "tui", confirm: true });
    await allowed.commands.get("mode")?.handler("exact", allowed.ctx);
    assert.equal(
      (allowed.entries.at(-1) as { customType?: string }).customType,
      MODE_STATE_TYPE_V3,
    );
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicitly reactivating the same keys refreshes drifted fingerprints", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-reactivate-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const modesDir = join(root, "modes");
  mkdirSync(modesDir, { recursive: true });
  const path = join(modesDir, "builder.json");
  const definition = (systemPrompt: string) => ({
    schemaVersion: 2,
    key: "builder",
    label: "Builder",
    promptStrategy: "replace_base",
    systemPrompt,
  });
  writeFileSync(path, JSON.stringify(definition("OLD")));
  try {
    const h = harness();
    const command = h.commands.get("mode");
    const before = h.handlers.get("before_agent_start")?.[0];
    assert.ok(command && before);
    await command.handler("builder", h.ctx);
    writeFileSync(path, JSON.stringify(definition("NEW")));
    const blocked = await turnPrompt(before, h.ctx, {
      cwd: process.cwd(),
      selectedTools: ["read"],
    });
    assert.equal(blocked, nativePrompt({ cwd: process.cwd(), selectedTools: ["read"] }));
    const entryCount = h.entries.length;
    await command.handler("builder", h.ctx);
    assert.equal(h.entries.length, entryCount + 1);
    const reactivated = await turnPrompt(before, h.ctx, {
      cwd: process.cwd(),
      selectedTools: ["read"],
    });
    assert.match(reactivated, /^NEW/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("before_agent_start composes ordered overlays from branch state", async () => {
  const h = harness([
    {
      type: "custom",
      customType: MODE_STATE_TYPE_V2,
      data: { baseKey: null, overlayKeys: ["review", "explain"] },
    },
  ]);
  const handler = h.handlers.get("before_agent_start")?.[0];
  assert.ok(handler);
  const result = await turnPrompt(handler, h.ctx, { cwd: process.cwd(), selectedTools: ["read"] });
  assert.ok(result.startsWith(nativePrompt({ cwd: process.cwd(), selectedTools: ["read"] })));
  assert.ok(result.indexOf("overlay 1: Review") < result.indexOf("overlay 2: Explain"));
  // Overlays are prompt sections Pi keeps in the transcript, not a forced replacement.
  const options = hostOptions({ cwd: process.cwd(), selectedTools: ["read"] });
  assert.equal(await handler({ systemPrompt: "", systemPromptOptions: options }, h.ctx), undefined);
  assert.deepEqual(Object.keys(options.sections), ["prompt_overlay_1", "prompt_overlay_2"]);
});

test("same-key replace_final drift cannot reactivate through commands or presets without acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-exact-drift-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const modesDir = join(root, "modes");
  mkdirSync(modesDir, { recursive: true });
  const path = join(modesDir, "builder.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      key: "builder",
      label: "Builder",
      promptStrategy: "replace_base",
      systemPrompt: "OLD",
    }),
  );
  try {
    const h = harness();
    const command = h.commands.get("mode");
    assert.ok(command);
    await command.handler("builder", h.ctx);
    await command.handler("save builder-preset", h.ctx);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        key: "builder",
        label: "Builder",
        promptStrategy: "replace_final",
        systemPrompt: "NEW EXACT",
      }),
    );
    const before = h.handlers.get("before_agent_start")?.[0];
    assert.ok(before);
    await h.commands.get("mode-policy")?.handler("allow", h.ctx);
    const blockedUnderAllow = await turnPrompt(before, h.ctx, { cwd: process.cwd() });
    assert.equal(blockedUnderAllow, nativePrompt({ cwd: process.cwd() }));
    await assert.rejects(async () => {
      await command.handler("builder", h.ctx);
    }, /requires --confirm-exact/);
    await assert.rejects(async () => {
      await command.handler("use builder-preset", h.ctx);
    }, /requires --confirm-exact/);
    await command.handler("builder --confirm-exact", h.ctx);
    const result = await turnPrompt(before, h.ctx, { cwd: process.cwd() });
    assert.equal(result, "NEW EXACT");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy changes and inactive deletion preserve drift fingerprints", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-policy-drift-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const modesDir = join(root, "modes");
  mkdirSync(modesDir, { recursive: true });
  const builderPath = join(modesDir, "builder.json");
  const definition = (systemPrompt: string) => ({
    schemaVersion: 2,
    key: "builder",
    label: "Builder",
    promptStrategy: "replace_base",
    systemPrompt,
  });
  writeFileSync(builderPath, JSON.stringify(definition("OLD")));
  writeFileSync(
    join(modesDir, "unused.json"),
    JSON.stringify({
      schemaVersion: 2,
      key: "unused",
      label: "Unused",
      promptStrategy: "append",
      systemPrompt: "UNUSED",
    }),
  );
  try {
    const h = harness([], { mode: "tui", confirm: true });
    await h.commands.get("mode")?.handler("builder", h.ctx);
    const approved = (h.entries.at(-1) as { data: { fingerprints: unknown } }).data.fingerprints;
    writeFileSync(builderPath, JSON.stringify(definition("NEW")));
    await h.commands.get("mode-policy")?.handler("block", h.ctx);
    const policyState = h.entries.at(-1) as {
      data: { source: string; fingerprints: unknown; driftPolicy: string };
    };
    assert.equal(policyState.data.source, "policy");
    assert.deepEqual(policyState.data.fingerprints, approved);
    const before = h.handlers.get("before_agent_start")?.[0];
    assert.ok(before);
    const promptAfterBlock = await turnPrompt(before, h.ctx, { cwd: process.cwd() });
    assert.equal(promptAfterBlock, nativePrompt({ cwd: process.cwd() }));

    const entriesBeforeInactiveDelete = h.entries.length;
    await h.commands.get("mode-delete")?.handler("unused", h.ctx);
    assert.equal(h.entries.length, entriesBeforeInactiveDelete);
    const promptAfterDelete = await turnPrompt(before, h.ctx, { cwd: process.cwd() });
    assert.equal(promptAfterDelete, nativePrompt({ cwd: process.cwd() }));
    await h.commands.get("mode-policy")?.handler("warn", h.ctx);
    const promptAfterWarn = await turnPrompt(before, h.ctx, { cwd: process.cwd() });
    assert.match(promptAfterWarn, /^NEW/);
    await h.commands.get("mode-policy")?.handler("block", h.ctx);
    const promptAfterRestoredBlock = await turnPrompt(before, h.ctx, { cwd: process.cwd() });
    assert.equal(promptAfterRestoredBlock, nativePrompt({ cwd: process.cwd() }));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact confirmation is bound to the definition snapshot that is persisted", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-confirm-snapshot-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const modesDir = join(root, "modes");
  mkdirSync(modesDir, { recursive: true });
  const path = join(modesDir, "exact.json");
  const definition = (systemPrompt: string) => ({
    schemaVersion: 2,
    key: "exact",
    label: "Exact",
    promptStrategy: "replace_final",
    systemPrompt,
  });
  writeFileSync(path, JSON.stringify(definition("OLD EXACT")));
  let changed = false;
  try {
    const h = harness([], {
      mode: "tui",
      confirm: true,
      onConfirm: () => {
        if (changed) return;
        changed = true;
        writeFileSync(path, JSON.stringify(definition("NEW EXACT")));
      },
    });
    await h.commands.get("mode")?.handler("exact", h.ctx);
    assert.equal(
      h.entries.some(
        (entry) => (entry as { customType?: string }).customType === MODE_STATE_TYPE_V3,
      ),
      false,
    );
    assert.ok(
      h.notifications.some((notification) =>
        /changed after confirmation/.test(notification.message),
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting an inactive mode never rewrites a role-drifted active selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-delete-role-drift-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const modesDir = join(root, "modes");
  mkdirSync(modesDir, { recursive: true });
  const builderPath = join(modesDir, "builder.json");
  const builder = (promptStrategy: "replace_base" | "append") => ({
    schemaVersion: 2,
    key: "builder",
    label: "Builder",
    promptStrategy,
    systemPrompt: "BUILDER",
  });
  writeFileSync(builderPath, JSON.stringify(builder("replace_base")));
  writeFileSync(
    join(modesDir, "unused.json"),
    JSON.stringify({
      schemaVersion: 2,
      key: "unused",
      label: "Unused",
      promptStrategy: "append",
      systemPrompt: "UNUSED",
    }),
  );
  try {
    const h = harness([], { mode: "tui", confirm: true });
    await h.commands.get("mode")?.handler("builder", h.ctx);
    writeFileSync(builderPath, JSON.stringify(builder("append")));
    const entriesBeforeDelete = h.entries.length;
    await h.commands.get("mode-delete")?.handler("unused", h.ctx);
    assert.equal(h.entries.length, entriesBeforeDelete);
    const latest = h.entries.at(-1) as { data: { baseKey: string | null } };
    assert.equal(latest.data.baseKey, "builder");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup exact-final requires a separate environment acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-startup-exact-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousMode = process.env.PI_MODE;
  const previousConfirmation = process.env.PI_MODE_CONFIRM_EXACT;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_MODE = "exact";
  delete process.env.PI_MODE_CONFIRM_EXACT;
  mkdirSync(join(root, "modes"), { recursive: true });
  writeFileSync(
    join(root, "modes", "exact.json"),
    JSON.stringify({
      schemaVersion: 2,
      key: "exact",
      label: "Exact",
      promptStrategy: "replace_final",
      systemPrompt: "EXACT",
    }),
  );
  try {
    const denied = harness();
    await denied.handlers.get("session_start")?.[0]?.({ reason: "startup" }, denied.ctx);
    assert.equal(
      (denied.entries.at(-1) as { data: { baseKey: string | null } }).data.baseKey,
      null,
    );

    process.env.PI_MODE_CONFIRM_EXACT = "1";
    const allowed = harness();
    await allowed.handlers.get("session_start")?.[0]?.({ reason: "startup" }, allowed.ctx);
    assert.equal(
      (allowed.entries.at(-1) as { data: { baseKey: string | null } }).data.baseKey,
      "exact",
    );
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousMode === undefined) delete process.env.PI_MODE;
    else process.env.PI_MODE = previousMode;
    if (previousConfirmation === undefined) delete process.env.PI_MODE_CONFIRM_EXACT;
    else process.env.PI_MODE_CONFIRM_EXACT = previousConfirmation;
    rmSync(root, { recursive: true, force: true });
  }
});

test("commands reject unknown arguments without mutating drift state", async () => {
  const h = harness();
  const count = h.entries.length;
  await assert.rejects(async () => {
    await h.commands.get("mode-reapprove")?.handler("--bogus", h.ctx);
  }, /Usage: \/mode-reapprove/);
  await assert.rejects(async () => {
    await h.commands.get("mode-status")?.handler("--bogus", h.ctx);
  }, /Usage: \/mode-status/);
  assert.equal(h.entries.length, count);
});

// --expect on /mode-reapprove: the out-of-band attestation (FT-40). A mismatch must refuse
// before anything is persisted; a match must persist the refreshed digest.
test("reapprove --expect refuses on a mismatched digest and persists on a match", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-expect-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousMode = process.env.PI_MODE;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_MODE;
    mkdirSync(join(root, "modes"), { recursive: true });
    writeFileSync(
      join(root, "modes", "review.json"),
      JSON.stringify({
        schemaVersion: 2,
        key: "review",
        label: "Review",
        promptStrategy: "append",
        systemPrompt: "review the change",
      }),
    );
    // Start on the real definition, then edit the file so the recorded digest drifts.
    const h = harness();
    await h.commands.get("mode")?.handler("review", h.ctx);
    const recorded = h.entries.at(-1) as {
      data: { fingerprints: Record<string, { digest: string }> };
    };
    const staleDigest = recorded.data.fingerprints.review.digest;
    writeFileSync(
      join(root, "modes", "review.json"),
      JSON.stringify({
        schemaVersion: 2,
        key: "review",
        label: "Review",
        promptStrategy: "append",
        systemPrompt: "review the change carefully",
      }),
    );
    const before = h.entries.length;

    // A stale attestation refuses and appends nothing.
    await assert.rejects(async () => {
      await h.commands.get("mode-reapprove")?.handler(`--expect ${staleDigest}`, h.ctx);
    }, /Mode definitions changed after confirmation/);
    assert.equal(h.entries.length, before, "a refused --expect must not persist");

    // The digest of the CURRENT file at the path the handler discovers is what --expect takes.
    const { modeDefinitionFingerprint } = await import("../src/modes.ts");
    const { readModeFile } = await import("../src/mode-definitions.ts");
    const { definition } = readModeFile(join(root, "modes", "review.json"));
    const current = modeDefinitionFingerprint({
      ...definition,
      scope: "global",
      path: join(root, "modes", "review.json"),
    }).digest;

    await h.commands.get("mode-reapprove")?.handler(`--expect ${current}`, h.ctx);
    const latest = h.entries.at(-1) as {
      customType: string;
      data: { source: string; fingerprints: Record<string, { digest: string }> };
    };
    assert.equal(latest.customType, MODE_STATE_TYPE_V3);
    assert.equal(latest.data.source, "reapprove");
    assert.equal(latest.data.fingerprints.review.digest, current);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousMode === undefined) delete process.env.PI_MODE;
    else process.env.PI_MODE = previousMode;
    rmSync(root, { recursive: true, force: true });
  }
});

// A non-interactive caller must be able to finish. With no drift to show, the TUI confirm is
// skipped for a really-clean selection anyway; with drift, --expect covering the selection is the
// attestation and the generic "preview first if that was unexpected" prompt adds nothing. Without
// --expect the dialog still guards the action.
test("--expect covering the selection skips the TUI confirm; its absence does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-expect-dialog-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousMode = process.env.PI_MODE;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_MODE;
    mkdirSync(join(root, "modes"), { recursive: true });
    const write = (text: string) =>
      writeFileSync(
        join(root, "modes", "review.json"),
        JSON.stringify({
          schemaVersion: 2,
          key: "review",
          label: "Review",
          promptStrategy: "append",
          systemPrompt: text,
        }),
      );

    write("first");
    let confirms = 0;
    const h = harness([], {
      mode: "tui",
      confirm: false,
      onConfirm: () => {
        confirms += 1;
      },
    });
    await h.commands.get("mode")?.handler("review", h.ctx);
    write("second");

    const { modeDefinitionFingerprint } = await import("../src/modes.ts");
    const { readModeFile } = await import("../src/mode-definitions.ts");
    const { definition } = readModeFile(join(root, "modes", "review.json"));
    const digest = modeDefinitionFingerprint({
      ...definition,
      scope: "global",
      path: join(root, "modes", "review.json"),
    }).digest;

    // Without --expect the dialog is offered (and a "no" answer aborts).
    confirms = 0;
    h.confirms.length = 0;
    await h.commands.get("mode-reapprove")?.handler("", h.ctx);
    assert.ok(confirms > 0, "the interactive confirm must still run without --expect");
    // FT-41: the body must name the digest being attested, and it must be the value --expect
    // compares, so it can be copied straight into a headless call.
    const body = h.confirms[0]?.message ?? "";
    assert.match(
      body,
      new RegExp(digest),
      "the confirm body must contain the full attesting digest",
    );
    assert.match(body, /\/mode-reapprove --expect/, "the body must say what the digest is for");
    assert.match(body, /Changed since activation: review/, "the drifted key is still named");
    const beforeAbort = h.entries.length;

    // With --expect covering the selection, no dialog blocks the call and it persists.
    confirms = 0;
    await h.commands.get("mode-reapprove")?.handler(`--expect ${digest}`, h.ctx);
    assert.equal(confirms, 0, "--expect covering the selection must not open the confirm");
    assert.ok(h.entries.length > beforeAbort, "--expect reapproval must persist");
    assert.equal((h.entries.at(-1) as { data: { source: string } }).data.source, "reapprove");
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousMode === undefined) delete process.env.PI_MODE;
    else process.env.PI_MODE = previousMode;
    rmSync(root, { recursive: true, force: true });
  }
});
