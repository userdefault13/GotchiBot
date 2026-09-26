/**
 * Classify cAavegotchi hero ids for roster / crew rules.
 *
 * Roster = all of the user's minted cAavegotchis on the GotchiBot cartridge:
 *   - wallet gotchis bound via bindOwned → hero ids `owned-<tokenId>` (free)
 *   - base collateral gotchis bound via bindStarter → `starter-<collateral>-h<haunt>-<n>` ($5 USDC)
 *
 * Crew = the gotchis assigned to one project (`sessions/pstack/<slug>/roster.json`).
 *
 * Rules (documented for callers):
 *   - owned-*  = wallet gotchi; may be in MANY project crews at once.
 *   - starter-* = base collateral gotchi; only ONE project crew at a time.
 *   - unknown kinds: conservative = warn and allow.
 *
 * "gotchi" / "owned-954" are the orchestrator identity, but owned-954 is still
 * kind "owned" for crew purposes (prefix wins). Use isOrchestratorHero() when
 * you need the orch exclusion (apply gate / sandbox).
 */

/**
 * @param {string} heroId
 * @param {{ bindType?: string } | null} [meta]
 * @returns {"owned"|"starter"|"orchestrator"|"unknown"}
 */
export function heroKind(heroId, meta = null) {
  const id = String(heroId || "").trim();
  if (!id) return "unknown";

  // Alias for the gotchi orchestrator seat (not a prefix-owned id).
  if (id === "gotchi") return "orchestrator";

  if (id.startsWith("owned-")) return "owned";
  if (id.startsWith("starter-")) return "starter";

  // Prefix ambiguous/unknown — fall back to bind metadata when present.
  const raw = String(meta?.bindType || meta?.bind || "").toLowerCase();
  if (raw === "owned" || raw === "bindowned" || raw === "bind-owned") return "owned";
  if (raw === "starter" || raw === "bindstarter" || raw === "bind-starter") return "starter";

  return "unknown";
}

/** Orchestrator seat: owned-954 or alias "gotchi". Still kind "owned" for crew multi-project rules. */
export function isOrchestratorHero(heroId) {
  const id = String(heroId || "").trim();
  return id === "owned-954" || id === "gotchi";
}
