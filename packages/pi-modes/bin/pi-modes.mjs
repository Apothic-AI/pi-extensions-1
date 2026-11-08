#!/usr/bin/env node
/**
 * Installed entry point for the pi-modes CLI.
 *
 * Node refuses to strip TypeScript types for files under `node_modules`, so an installed package
 * cannot run its `.ts` sources directly. The shipped bin loads the TypeScript CLI through jiti (the
 * same loader Pi uses for extensions). In this repo you can run `scripts/mode-cli.ts` directly;
 * both paths share the one TS graph.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
await jiti.import("../scripts/mode-cli.ts");
