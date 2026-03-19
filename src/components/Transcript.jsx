import { useEffect, useRef } from 'react'
import { AGENTS, AGENT_ORDER } from '../lib/agents.js'

export default function Transcript({ claims, onClaimClick, selectedNode }) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [claims.length])

  // Group claims by round, then by agent within each round
  const rounds = {}
  for (const c of claims) {
    if (!rounds[c.round]) rounds[c.round] = {}
    if (!rounds[c.round][c.agentId]) rounds[c.round][c.agentId] = []
    rounds[c.round][c.agentId].push(c)
  }

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      padding: '1rem 1.25rem',
      overflowY: 'auto',
      flex: 1,
      minHeight: 0
    }}>
      {Object.entries(rounds).map(([round, agentClaims]) => (
        <div key={round} style={{ marginBottom: '0.5rem' }}>
          {/* Round divider */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            margin: '1.5rem 0 1rem',
          }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            <span style={{
              fontSize: '0.9rem',
              fontWeight: 700,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              whiteSpace: 'nowrap'
            }}>
              Round {round}
            </span>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>

          {/* Agent groups within round */}
          {AGENT_ORDER.map(agentId => {
            const agentRoundClaims = agentClaims[agentId]
            if (!agentRoundClaims) return null
            const agent = AGENTS[agentId]

            return (
              <div key={agentId} style={{
                marginBottom: '0.75rem',
                borderLeft: `4px solid ${agent.color}`,
                paddingLeft: '0.75rem',
              }}>
                {/* Agent header — shown once per agent per round */}
                <div style={{
                  color: agent.color,
                  fontWeight: 700,
                  fontSize: '1.1rem',
                  marginBottom: '0.25rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.03em'
                }}>
                  {agent.name} <span style={{ fontWeight: 400, opacity: 0.6, fontSize: '0.85rem' }}>({agent.model})</span>
                </div>

                {/* Claims list */}
                {agentRoundClaims.map(claim => {
                  const isSelected = selectedNode === claim.id
                  const displayText = claim.text

                  // Resolve rebuttal target to human-readable form
                  let rebuttalInfo = null
                  if (claim.rebuts) {
                    const target = claims.find(c => c.id === claim.rebuts)
                    if (target) {
                      const targetAgent = AGENTS[target.agentId]
                      const targetText = target.text.length > 50
                        ? target.text.slice(0, 47) + '...'
                        : target.text
                      rebuttalInfo = { agentName: targetAgent.name, agentColor: targetAgent.color, text: targetText }
                    }
                  }

                  // Resolve agreement target
                  let agreementInfo = null
                  if (claim.agrees_with) {
                    const target = claims.find(c => c.id === claim.agrees_with)
                    if (target) {
                      const targetAgent = AGENTS[target.agentId]
                      const targetText = target.text.length > 50
                        ? target.text.slice(0, 47) + '...'
                        : target.text
                      agreementInfo = { agentName: targetAgent.name, agentColor: targetAgent.color, text: targetText }
                    }
                  }

                  return (
                    <div
                      key={claim.id}
                      onClick={() => onClaimClick?.(claim.id)}
                      style={{
                        padding: '0.5rem 0.6rem',
                        marginBottom: '0.35rem',
                        background: isSelected ? agent.dimColor : 'transparent',
                        borderRadius: 'var(--radius)',
                        cursor: 'pointer',
                        transition: 'background var(--transition)',
                        fontSize: '1rem',
                        lineHeight: 1.5,
                        color: 'var(--text-primary)'
                      }}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)' }}
                      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                      title={claim.text}
                    >
                      {displayText}
                      {rebuttalInfo && (
                        <div style={{
                          fontSize: '0.85rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          paddingLeft: '0.6rem'
                        }}>
                          <span style={{ opacity: 0.7 }}>{'\u21A9'}</span>{' '}
                          responding to{' '}
                          <span style={{ color: rebuttalInfo.agentColor, fontWeight: 600 }}>
                            {rebuttalInfo.agentName}
                          </span>
                          : {rebuttalInfo.text}
                        </div>
                      )}
                      {agreementInfo && (
                        <div style={{
                          fontSize: '0.85rem',
                          color: '#4ade80',
                          marginTop: '0.15rem',
                          paddingLeft: '0.6rem'
                        }}>
                          <span style={{ opacity: 0.7 }}>&#10003;</span>{' '}
                          agrees with{' '}
                          <span style={{ color: agreementInfo.agentColor, fontWeight: 600 }}>
                            {agreementInfo.agentName}
                          </span>
                          : {agreementInfo.text}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
