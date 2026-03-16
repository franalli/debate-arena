import { AGENTS, AGENT_ORDER } from '../lib/agents.js'

export default function VoteBar({ votes, onVote, hasVoted }) {
  const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0)

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      borderTop: '1px solid var(--border)',
      padding: '1.5rem 2rem'
    }}>
      <div style={{
        fontSize: '1.1rem',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        marginBottom: '0.75rem'
      }}>
        {hasVoted ? 'Results' : 'Who made the best arguments?'}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {AGENT_ORDER.map(agentId => {
          const agent = AGENTS[agentId]
          const count = votes[agentId] || 0
          const pct = totalVotes > 0 ? (count / totalVotes) * 100 : 0

          return (
            <button
              key={agentId}
              onClick={() => !hasVoted && onVote(agentId)}
              disabled={hasVoted}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '0.75rem 1.25rem',
                position: 'relative',
                overflow: 'hidden',
                cursor: hasVoted ? 'default' : 'pointer',
                transition: 'border-color var(--transition)'
              }}
              onMouseEnter={(e) => { if (!hasVoted) e.currentTarget.style.borderColor = agent.color }}
              onMouseLeave={(e) => { if (!hasVoted) e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              {/* Bar fill */}
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${pct}%`,
                background: agent.dimColor,
                transition: 'width 0.6s ease',
                borderRadius: 'var(--radius)'
              }} />

              <span style={{
                color: agent.color,
                fontWeight: 600,
                fontSize: '1.1rem',
                position: 'relative',
                zIndex: 1,
                minWidth: 100
              }}>
                {agent.name}
              </span>

              {hasVoted && (
                <span style={{
                  color: 'var(--text-muted)',
                  fontSize: '1rem',
                  position: 'relative',
                  zIndex: 1
                }}>
                  {count} vote{count !== 1 ? 's' : ''} ({Math.round(pct)}%)
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
