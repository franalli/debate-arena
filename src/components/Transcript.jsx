import { useEffect, useMemo, useRef, useState } from 'react'
import { AGENTS, AGENT_ORDER } from '../lib/agents.js'
import { ProviderLogo } from './ProviderLogos.jsx'
import { getCurrentPlaybackTime } from '../lib/audio.js'

// Karaoke renderer: highlights words as the agent speaks them.
// The rAF loop polls currentTime at 60Hz but only triggers a React
// re-render when the active word INDEX transitions (a few Hz at typical
// speech rate), so token-tree diffing doesn't run every frame.
function KaraokeText({ text, words }) {
  // Tokens preserve whitespace ('foo bar' -> ['foo', ' ', 'bar']) so we
  // can match by word index while keeping the spaces in the DOM. Memo
  // so the regex split doesn't repeat across renders.
  const tokens = useMemo(() => text.split(/(\s+)/), [text])
  // Stable ref into latest words array — read inside rAF without
  // re-creating the effect on every chunk.
  const wordsRef = useRef(words)
  wordsRef.current = words
  const [activeIdx, setActiveIdx] = useState(-1)

  useEffect(() => {
    let raf
    let last = -1
    const tick = () => {
      const t = getCurrentPlaybackTime()
      const arr = wordsRef.current
      // Binary scan is unnecessary at <100 words — linear is fine.
      let idx = -1
      for (let i = 0; i < arr.length; i++) {
        if (t < arr[i].start) break
        idx = i
        if (t < arr[i].end) break
      }
      if (idx !== last) {
        last = idx
        setActiveIdx(idx)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  let wordIdx = 0
  return (
    <>
      {tokens.map((tok, i) => {
        if (/^\s+$/.test(tok)) return <span key={i}>{tok}</span>
        const myIdx = wordIdx++
        let cls = 'karaoke-word'
        if (myIdx < activeIdx) cls += ' past'
        else if (myIdx === activeIdx) cls += ' active'
        return <span key={i} className={cls}>{tok}</span>
      })}
    </>
  )
}

export default function Transcript({ claims, onClaimClick, selectedNode, speakingClaimId, claimWords = {} }) {
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
                  {agent.name}{' '}
                  <span style={{
                    fontWeight: 400,
                    opacity: 0.6,
                    fontSize: '0.85rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem'
                  }}>
                    (<ProviderLogo agentId={agentId} size={12} />{agent.model})
                  </span>
                </div>

                {/* Claims list */}
                {agentRoundClaims.map(claim => {
                  const isSelected = selectedNode === claim.id
                  const isSpeaking = speakingClaimId === claim.id
                  const speakingWords = isSpeaking ? (claimWords[claim.id] || []) : null
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
                      rebuttalInfo = { agentName: targetAgent.name, agentColor: targetAgent.color, text: targetText, fullText: target.text }
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
                      agreementInfo = { agentName: targetAgent.name, agentColor: targetAgent.color, text: targetText, fullText: target.text }
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
                    >
                      {isSpeaking && speakingWords
                        ? <KaraokeText text={displayText} words={speakingWords} />
                        : displayText}
                      {rebuttalInfo && (
                        <div title={rebuttalInfo.fullText} style={{
                          fontSize: '0.85rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          paddingLeft: '0.6rem',
                          cursor: 'help'
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
                        <div title={agreementInfo.fullText} style={{
                          fontSize: '0.85rem',
                          color: '#4ade80',
                          marginTop: '0.15rem',
                          paddingLeft: '0.6rem',
                          cursor: 'help'
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
