/**
 * The action registry — one flat name → function map, grouped by domain file.
 *
 * Tiers are declared in lib/gate.ts (PUBLIC_ACTIONS); this module only says what
 * exists. actions/ = WHAT the product does, lib/ = HOW it talks to the world.
 */

import { K3 } from "../lib/k3.ts";
import type { Json } from "./common.ts";
import * as gate from "../lib/gate.ts";
import { identify, track, trackBatch } from "./ingest.ts";
import { activeUsers, breakdown, exportReport, funnel, publicOverview, retention, topEvents } from "./reports.ts";
import { catalogSearch, registerEvent } from "./catalog.ts";

export const ACTIONS: Record<string, (k3: K3, p: Json) => Promise<Json>> = {
  // -- PUBLIC (anon-safe) --
  track,
  track_batch: trackBatch,
  identify,
  catalog_search: catalogSearch,
  public_overview: publicOverview,
  // -- PRIVATE (admin key) --
  funnel,
  retention,
  active_users: activeUsers,
  top_events: topEvents,
  breakdown,
  register_event: registerEvent,
  export: exportReport,
  create_key: gate.createKey,
  list_keys: gate.listKeys,
  revoke_key: gate.revokeKey,
};
