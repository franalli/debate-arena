import { useState, forwardRef, useImperativeHandle, useRef } from 'react'
import { AGENTS } from '../lib/agents.js'
import { computeWildcardScore } from '../lib/graphUtils.js'

const WildcardVerdict = forwardRef(function WildcardVerdict({ claims, verdictText }, ref) {
  const [expanded, setExpanded] = useState(false)
  const divRef = useRef(null)
  const score = computeWildcardScore(claims)

  const _winner = score.advocate > score.critic ? 'advocate'
    : score.critic > score.advocate ? 'critic'
    : null

  // Bar proportions based on rounds won
  const total = score.rounds || 1
  const advPct = Math.round((score.advocate / total) * 100)
  const crtPct = 100 - advPct

  useImperativeHandle(ref, () => ({
    expand: () => setExpanded(true),
    scrollIntoView: (opts) => divRef.current?.scrollIntoView(opts)
  }))

  return (
    <div
      ref={divRef}
      style={{
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
        flexShrink: expanded ? 1 : 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Collapsed header bar — just show verdict toggle */}
      <div
        onClick={() => setExpanded(prev => !prev)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0.7rem 2rem',
          cursor: 'pointer',
          userSelect: 'none'
        }}
      >
        <span style={{
          fontSize: '0.9rem',
          fontWeight: 600,
          background: 'linear-gradient(90deg, var(--advocate), var(--wildcard), var(--critic), var(--wildcard), var(--advocate))',
          backgroundSize: '200% 100%',
          animation: 'border-shimmer 4s linear infinite',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent'
        }}>
          {expanded ? '▲ Hide verdict' : '▼ Show verdict'}
        </span>
      </div>

      {/* Expandable details */}
      {expanded && (
        <div style={{ padding: '0 2rem 2.5rem', overflowY: 'auto', minHeight: 0, flex: 1 }}>
          {/* Round score */}
          <div style={{
            display: 'flex',
            gap: '1.5rem',
            marginBottom: '0.75rem',
            fontSize: '1rem'
          }}>
            <div style={{ color: 'var(--text-secondary)' }}>
              Rounds for <span style={{ color: AGENTS.advocate.color, fontWeight: 600 }}>Advocate</span>: {score.advocate}
            </div>
            <div style={{ color: 'var(--text-secondary)' }}>
              Rounds for <span style={{ color: AGENTS.critic.color, fontWeight: 600 }}>Critic</span>: {score.critic}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              of {score.rounds}
            </div>
          </div>

          {/* Progress bar */}
          <div style={{
            display: 'flex',
            height: 32,
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            marginBottom: '0.75rem',
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

          {/* Verdict details */}
          {verdictText && (
            <div style={{
              fontSize: '1rem',
              lineHeight: 1.6,
              color: 'var(--text-secondary)',
              borderLeft: `4px solid ${AGENTS.wildcard.color}`,
              paddingLeft: '0.75rem'
            }}>
              <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>Key winning arguments:</div>
              <ul style={{ margin: '0 0 0.6rem', paddingLeft: '1.2rem' }}>
                {verdictText.winningArguments.map((arg, i) => (
                  <li key={i} style={{ marginBottom: '0.2rem' }}>{arg}</li>
                ))}
              </ul>
              {verdictText.loserGap && (
                <div>
                  <span style={{ fontWeight: 600 }}>The loser&rsquo;s biggest gap: </span>
                  {verdictText.loserGap}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export default WildcardVerdict
