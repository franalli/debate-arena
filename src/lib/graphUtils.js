import { AGENTS } from './agents.js'

export function buildGraphData(claims) {
  // Count rebuttals received per claim
  const rebuttalCounts = {}
  for (const c of claims) {
    if (c.rebuts) {
      rebuttalCounts[c.rebuts] = (rebuttalCounts[c.rebuts] || 0) + 1
    }
  }

  const nodes = claims.map(c => {
    const agent = AGENTS[c.agentId]
    return {
      id: c.id,
      agentId: c.agentId,
      text: c.text,
      round: c.round,
      color: agent.color,
      dimColor: agent.dimColor,
      radius: 24 + (rebuttalCounts[c.id] || 0) * 5,
      rebuttalsReceived: rebuttalCounts[c.id] || 0
    }
  })

  const claimIds = new Set(claims.map(c => c.id))

  // Rebuttal links — Wildcard attacks only (Advocate↔Critic attacks are predictable, add no info)
  const rebuttalLinks = claims
    .filter(c => c.agentId === 'wildcard' && c.rebuts && claimIds.has(c.rebuts))
    .map(c => ({
      source: c.id,
      target: c.rebuts,
      id: `${c.id}->${c.rebuts}`,
      sourceAgentId: c.agentId,
      color: AGENTS[c.agentId].color,
      type: 'rebuttal'
    }))

  // Agreement links (Wildcard only)
  const agreementLinks = claims
    .filter(c => c.agrees_with && claimIds.has(c.agrees_with))
    .map(c => ({
      source: c.id,
      target: c.agrees_with,
      id: `${c.id}~>${c.agrees_with}`,
      sourceAgentId: c.agentId,
      color: '#22c55e',
      type: 'agreement'
    }))

  return { nodes, links: [...rebuttalLinks, ...agreementLinks] }
}

// Compute Wildcard's round-by-round scoring.
// Each round is ONE decision — the agree determines who wins the round.
// Returns { advocate: roundsWon, critic: roundsWon, rounds: total }
export function computeWildcardScore(claims) {
  const claimMap = new Map(claims.map(c => [c.id, c]))
  let advRounds = 0
  let crtRounds = 0
  let totalRounds = 0

  // Group wildcard claims by round, use agreement to determine who won each round
  const roundDecisions = new Map()
  for (const c of claims) {
    if (c.agentId !== 'wildcard') continue
    if (!c.agrees_with || roundDecisions.has(c.round)) continue

    // Try exact match first
    let target = claimMap.get(c.agrees_with)

    // Fallback: infer side from the claim ID prefix (e.g. "adv_r1_1" → advocate)
    if (!target) {
      const id = c.agrees_with
      if (id.startsWith('adv')) target = { agentId: 'advocate' }
      else if (id.startsWith('crt')) target = { agentId: 'critic' }
    }

    if (target && (target.agentId === 'advocate' || target.agentId === 'critic')) {
      roundDecisions.set(c.round, target.agentId)
    }
  }

  for (const [, side] of roundDecisions) {
    totalRounds++
    if (side === 'advocate') advRounds++
    else crtRounds++
  }

  return { advocate: advRounds, critic: crtRounds, rounds: totalRounds }
}

// Determine winner from wildcard round scoring
export function getWinner(claims) {
  const score = computeWildcardScore(claims)
  if (score.advocate > score.critic) return 'advocate'
  if (score.critic > score.advocate) return 'critic'
  return null
}
