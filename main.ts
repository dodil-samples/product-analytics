/**
 * Product Analytics — Ignite (Deno) entrypoint.
 *
 * The Deno runtime invokes the function via the `ignite` SDK's `start(handler)`.
 * All app logic lives in ./lib/handler.ts (SDK-independent, so it can be unit-run
 * with plain `deno run`); this file is only the wiring.
 */

import { start } from "ignite";
import { handle } from "./lib/handler.ts";

start(handle);
