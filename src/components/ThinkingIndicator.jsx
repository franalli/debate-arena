import { AGENTS } from '../lib/agents.js'

export default function ThinkingIndicator({ agentId }) {
  if (!agentId) return null
  const agent = AGENTS[agentId]

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '0.75rem 1rem',
      background: agent.dimColor,
      borderRadius: 'var(--radius)',
      borderLeft: `3px solid ${agent.color}`
    }}>
      <span style={{ color: agent.color, fontWeight: 600, fontSize: '0.9rem' }}>
        {agent.name}
      </span>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
        ({agent.model})
      </span>
      <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        is thinking
      </span>
      <span style={{ display: 'flex', gap: '4px' }}>
        {[0, 1, 2].map(i => (
          <span
            key={i}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: agent.color,
              animation: `thinking-dot 1.4s infinite`,
              animationDelay: `${i * 0.2}s`
            }}
          />
        ))}
      </span>
    </div>
  )
}
