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

  // Rebuttal links
  const rebuttalLinks = claims
    .filter(c => c.rebuts && claimIds.has(c.rebuts))
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

// Compute Wildcard's scoring tally
export function computeWildcardScore(claims) {
  const score = {
    advocate: { agreed: 0, rebutted: 0 },
    critic: { agreed: 0, rebutted: 0 }
  }

  const claimMap = new Map(claims.map(c => [c.id, c]))

  for (const c of claims) {
    if (c.agentId !== 'wildcard') continue

    if (c.rebuts) {
      const target = claimMap.get(c.rebuts)
      if (target && score[target.agentId]) {
        score[target.agentId].rebutted++
      }
    }
    if (c.agrees_with) {
      const target = claimMap.get(c.agrees_with)
      if (target && score[target.agentId]) {
        score[target.agentId].agreed++
      }
    }
  }

  return score
}

// Determine winner from wildcard scoring
// Points for X = wildcard agreed with X + wildcard rebutted opponent
export function getWinner(claims) {
  const score = computeWildcardScore(claims)
  const advPoints = score.advocate.agreed + score.critic.rebutted
  const crtPoints = score.critic.agreed + score.advocate.rebutted
  if (advPoints > crtPoints) return 'advocate'
  if (crtPoints > advPoints) return 'critic'
  return null
}
