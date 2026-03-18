---
name: graph-edges-wildcard-only
description: Only Wildcard edges shown in debate graph — Advocate/Critic mutual attacks are noise
type: feedback
---

Only show Wildcard edges in the debate arena graph. Advocate↔Critic attacks are predictable (they always attack each other) and add zero information.

**Edges allowed:**
- Purple dashed = Wildcard attacks (someone)
- Green solid = Wildcard agrees (with someone)

**Why:** The graph should tell ONE clear story: where does the Wildcard land each round? 9 nodes, 6 edges max. Clean, readable, meaningful.

**How to apply:** Never add Advocate↔Critic attack edges back. If new edge types are introduced, they should pass the "does this add information?" bar.
