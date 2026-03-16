import { AGENTS } from '../lib/agents.js'
import { computeWildcardScore } from '../lib/graphUtils.js'

export default function WildcardVerdict({ claims, verdictText }) {
  const score = computeWildcardScore(claims)

  // Points for X = wildcard agreed with X + wildcard rebutted opponent
  const advPoints = score.advocate.agreed + score.critic.rebutted
  const crtPoints = score.critic.agreed + score.advocate.rebutted
  const winner = advPoints > crtPoints ? 'advocate'
    : crtPoints > advPoints ? 'critic'
    : null
  const winnerName = winner ? AGENTS[winner].name : null
  const winnerColor = winner ? AGENTS[winner].color : 'var(--text-muted)'

  // Bar proportions (same points used for winner)
  const total = advPoints + crtPoints || 1
  const advPct = Math.round((advPoints / total) * 100)
  const crtPct = 100 - advPct

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      borderTop: '1px solid var(--border)',
      padding: '1.5rem 2rem'
    }}>
      {/* Title */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        marginBottom: '0.75rem'
      }}>
        <span style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: AGENTS.wildcard.color,
          display: 'inline-block'
        }} />
        <span style={{
          fontSize: '1.1rem',
          fontWeight: 700,
          color: AGENTS.wildcard.color,
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
        }}>
          Wildcard Verdict
        </span>
      </div>

      {/* Tally */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '0.5rem',
        marginBottom: '0.75rem',
        fontSize: '1rem'
      }}>
        <div style={{ color: 'var(--text-secondary)' }}>
          Agreed with <span style={{ color: AGENTS.advocate.color, fontWeight: 600 }}>Advocate</span>: {score.advocate.agreed}
        </div>
        <div style={{ color: 'var(--text-secondary)' }}>
          Agreed with <span style={{ color: AGENTS.critic.color, fontWeight: 600 }}>Critic</span>: {score.critic.agreed}
        </div>
        <div style={{ color: 'var(--text-secondary)' }}>
          Rebutted <span style={{ color: AGENTS.advocate.color, fontWeight: 600 }}>Advocate</span>: {score.advocate.rebutted}
        </div>
        <div style={{ color: 'var(--text-secondary)' }}>
          Rebutted <span style={{ color: AGENTS.critic.color, fontWeight: 600 }}>Critic</span>: {score.critic.rebutted}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        display: 'flex',
        height: 32,
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        marginBottom: '0.5rem',
        border: '1px solid var(--border)'
      }}>
        <div style={{
          width: `${advPct}%`,
          background: AGENTS.advocate.color,
          transition: 'width 0.8s ease',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.9rem',
          fontWeight: 700,
          color: '#fff',
          minWidth: advPct > 10 ? 'auto' : 0
        }}>
          {advPct > 10 && `${advPct}%`}
        </div>
        <div style={{
          width: `${crtPct}%`,
          background: AGENTS.critic.color,
          transition: 'width 0.8s ease',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.9rem',
          fontWeight: 700,
          color: '#fff',
          minWidth: crtPct > 10 ? 'auto' : 0
        }}>
          {crtPct > 10 && `${crtPct}%`}
        </div>
      </div>

      {/* Winner label */}
      <div style={{
        fontSize: '1.35rem',
        fontWeight: 700,
        color: winnerColor,
        marginBottom: verdictText ? '0.6rem' : 0
      }}>
        {winner
          ? `${winnerName} wins`
          : 'Draw — neither side convinced the Wildcard'}
      </div>

      {/* Verdict quote */}
      {verdictText && (
        <div style={{
          fontSize: '1rem',
          lineHeight: 1.5,
          color: 'var(--text-secondary)',
          fontStyle: 'italic',
          borderLeft: `4px solid ${AGENTS.wildcard.color}`,
          paddingLeft: '0.75rem'
        }}>
          &ldquo;{verdictText}&rdquo;
        </div>
      )}
    </div>
  )
}
