import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { setAudioMuted } from './lib/audio.js'
import TopicInput from './components/TopicInput.jsx'
import DebateGraph from './components/DebateGraph.jsx'
import Transcript, { KaraokeText } from './components/Transcript.jsx'
import ThinkingIndicator from './components/ThinkingIndicator.jsx'
import WildcardVerdict from './components/WildcardVerdict.jsx'
import RoundToasts from './components/RoundToasts.jsx'
import { runDebate, buildVerdictTtsString, VERDICT_SPEAKING_ID } from './lib/debate.js'
import { buildGraphData, computeWildcardScore, getWinner } from './lib/graphUtils.js'
import { AGENTS, AGENT_ORDER, PREFIX_TO_AGENT } from './lib/agents.js'
import { useIsMobile } from './lib/useMediaQuery.js'

const RATE_LIMIT_LABELS = {
  cooldown: 'Cooldown',
  ip_daily: 'Daily limit',
  global_daily: 'Service over capacity'
}

export default function App() {
  const isMobile = useIsMobile()
  const [topic, setTopic] = useState('')
  const [status, setStatus] = useState('idle') // idle | running | complete | error
  const [mode, setMode] = useState('fast')
  const [currentRound, setCurrentRound] = useState(0)
  const maxRounds = 3
  const [thinkingAgent, setThinkingAgent] = useState(null)
  const [allClaims, setAllClaims] = useState([])
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [selectedNode, setSelectedNode] = useState(null)
  const [verdictText, setVerdictText] = useState(null)
  const [roundResults, setRoundResults] = useState([])
  const [error, setError] = useState(null)
  const cancelRef = useRef(null)
  const selectionTimerRef = useRef(null)
  const verdictRef = useRef(null)
  const [muted, setMuted] = useState(false)
  const mutedRef = useRef(false)
  // True after the user clicks Stop on an incomplete debate; gates the
  // Resume button. Cleared on New Debate, on Resume, or when starting fresh.
  const [wasStopped, setWasStopped] = useState(false)
  const [speakingAgent, setSpeakingAgent] = useState(null)
  // Karaoke state: which claim is being spoken, and per-claim word
  // timings ({ [claimId]: [{ word, start, end }] }). currentTime is
  // polled via getCurrentPlaybackTime() in Transcript on rAF so we
  // don't push 60 setStates/sec through the App tree.
  const [speakingClaimId, setSpeakingClaimId] = useState(null)
  const [claimWords, setClaimWords] = useState({})

  useEffect(() => {
    mutedRef.current = muted
    setAudioMuted(muted)
  }, [muted])

  const startDebate = useCallback((debateTopic, selectedMode, options = {}) => {
    const { resumeFrom = null } = options
    if (selectedMode) setMode(selectedMode)
    const activeMode = selectedMode || mode
    setStatus('running')
    setWasStopped(false)
    setError(null)
    if (!resumeFrom) {
      setTopic(debateTopic)
      setCurrentRound(1)
      setAllClaims([])
      setGraphData({ nodes: [], links: [] })
      setSelectedNode(null)
      setVerdictText(null)
      setRoundResults([])
    }

    // On resume, seed accumulated with the finalized claims so the upsert-by-id
    // path in onAgentComplete continues to dedupe correctly when the next
    // claim arrives.
    let accumulated = resumeFrom ? [...resumeFrom.claims] : []

    const cancel = runDebate(debateTopic, maxRounds, {
      onAgentStart: (agentId, round) => {
        setThinkingAgent(agentId)
        setCurrentRound(round)
      },
      onAgentComplete: (agentId, round, newClaims) => {
        setThinkingAgent(null)
        if (newClaims.length === 0) return
        // Upsert by id. The streaming pipeline calls this multiple times
        // per claim — once with each incremental chunk_meta arrival
        // (partial text, null meta) and once at claim_complete with the
        // finalized text + rebuts/agrees_with. The legacy non-streaming
        // path calls it once per claim with the final claim; the upsert
        // is a no-op insert in that case.
        for (const nc of newClaims) {
          const idx = accumulated.findIndex(c => c.id === nc.id)
          if (idx >= 0) {
            accumulated = accumulated.map((c, i) => i === idx ? nc : c)
          } else {
            accumulated = [...accumulated, nc]
          }
        }
        setAllClaims([...accumulated])
        setGraphData(buildGraphData(accumulated))
      },
      onRoundComplete: (round) => {
        // Determine round winner from Wildcard's agreement
        const wc = accumulated.find(c => c.agentId === 'wildcard' && c.round === round)
        if (wc?.agrees_with) {
          const target = accumulated.find(c => c.id === wc.agrees_with)
          const winnerId = target?.agentId || PREFIX_TO_AGENT[wc.agrees_with.slice(0, 3)] || null
          if (winnerId && AGENTS[winnerId]) {
            setRoundResults(prev => [...prev, {
              round,
              label: AGENTS[winnerId].name,
              color: AGENTS[winnerId].color
            }])
          }
        }
        setCurrentRound(round + 1)
      },
      onError: (err, agentId, round) => {
        setThinkingAgent(null)
        setError({ message: err.message, code: err.code, retryAfter: err.retryAfter })
        // Terminal errors: auth failures, or any error before debate has claims (e.g. rate limit)
        if (err.message.includes('401') || accumulated.length === 0) {
          cancelRef.current?.()
          setStatus('error')
        }
        // Failure toast for API errors mid-debate
        if (agentId && accumulated.length > 0) {
          setRoundResults(prev => [...prev, {
            type: 'error',
            round,
            label: AGENTS[agentId]?.model || agentId,
            color: '#ef4444'
          }])
        }
      },
      onVerdictStart: () => {
        setThinkingAgent('wildcard')
      },
      onVerdict: (text) => {
        setVerdictText(text)
        setThinkingAgent(null)
      },
      onComplete: () => {
        setThinkingAgent(null)
        setSpeakingAgent(null)
        setStatus('complete')
      },
      onSpeakingStart: (agentId, claimId) => {
        setSpeakingAgent(agentId)
        setSpeakingClaimId(claimId)
      },
      onSpeakingEnd: () => {
        setSpeakingAgent(null)
        setSpeakingClaimId(null)
      },
      onSpeakingWords: (claimId, words) => {
        setClaimWords(prev => ({ ...prev, [claimId]: words }))
      },
      getMuted: () => mutedRef.current,
      // ?fresh=1 on the URL bypasses both cache layers (debate text and
      // TTS audio). Off by default; opt-in for admin/regen flows.
      fresh: new URLSearchParams(window.location.search).get('fresh') === '1'
    }, activeMode, resumeFrom ? { resumeFrom } : undefined)

    cancelRef.current = cancel
  }, [mode, maxRounds])

  const handleStop = () => {
    if (cancelRef.current) cancelRef.current()
    cancelRef.current = null
    setThinkingAgent(null)
    setSpeakingAgent(null)
    setSpeakingClaimId(null)
    setStatus('complete')
    setWasStopped(true)
  }

  const handleResume = () => {
    // Drop the partial trailing claim (mid-stream chunk_meta placeholder
    // that never reached claim_complete). The orchestrator computes the
    // next slot from claims.length, so the dropped slot is regenerated.
    const finalClaims = allClaims.filter(c => !c.partial)
    setAllClaims(finalClaims)
    setGraphData(buildGraphData(finalClaims))
    startDebate(topic, mode, { resumeFrom: { claims: finalClaims } })
  }

  const handleNewDebate = () => {
    if (cancelRef.current) cancelRef.current()
    setStatus('idle')
    setTopic('')
    setAllClaims([])
    setGraphData({ nodes: [], links: [] })
    setThinkingAgent(null)
    setSpeakingAgent(null)
    setSpeakingClaimId(null)
    setClaimWords({})
    setVerdictText(null)
    setRoundResults([])
    setError(null)
    setWasStopped(false)
  }

  const handleClaimClick = useCallback((claimId) => {
    // Clear any existing auto-deselect timer
    if (selectionTimerRef.current) {
      clearTimeout(selectionTimerRef.current)
      selectionTimerRef.current = null
    }
    setSelectedNode(prev => {
      if (prev === claimId) return null
      // Auto-deselect after 3 seconds
      selectionTimerRef.current = setTimeout(() => {
        setSelectedNode(null)
        selectionTimerRef.current = null
      }, 3000)
      return claimId
    })
  }, [])

  const liveScore = useMemo(() => {
    if (!allClaims?.length) return null
    const score = computeWildcardScore(allClaims)
    if (score.advocate === 0 && score.critic === 0) return null
    const leading = getWinner(allClaims)
    const isComplete = status === 'complete'
    const label = leading
      ? `${AGENTS[leading].name}${isComplete ? ' wins' : ''} ${Math.max(score.advocate, score.critic)}-${Math.min(score.advocate, score.critic)}`
      : `Draw ${score.advocate}-${score.critic}`
    const color = leading ? AGENTS[leading].color : '#ffffff'
    return { label, color, isComplete }
  }, [allClaims, status])

  if (status === 'idle') {
    return <TopicInput onStart={startDebate} />
  }

  const scoreEl = liveScore && (
    <span
      onClick={liveScore.isComplete ? () => {
        verdictRef.current?.expand()
        setTimeout(() => verdictRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
      } : undefined}
      style={{
        fontSize: isMobile ? '15px' : '22px',
        fontWeight: 700,
        color: liveScore.color,
        cursor: liveScore.isComplete ? 'pointer' : 'default',
        textDecoration: liveScore.isComplete ? 'underline' : 'none',
        textDecorationStyle: 'dotted',
        textUnderlineOffset: '3px',
        whiteSpace: 'nowrap',
        pointerEvents: liveScore.isComplete ? 'auto' : 'none'
      }}
    >
      {liveScore.label}
    </span>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header — desktop is a 3-column grid (centered score); mobile
          drops the title text + ElevenLabs link and tightens spacing
          so the controls fit on a 390px viewport. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? 'auto 1fr auto' : '1fr auto 1fr',
        alignItems: 'center',
        gap: isMobile ? '8px' : '16px',
        height: '48px',
        padding: isMobile ? '0 12px' : '0 24px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0
      }}>
        {/* Left: Title + Rounds */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? '8px' : '12px',
          minWidth: 0,
          justifySelf: 'start'
        }}>
          <h1 style={{
            fontSize: isMobile ? '13px' : '16px',
            fontWeight: 700,
            background: 'var(--title-gradient)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            margin: 0,
            whiteSpace: 'nowrap'
          }}>
            ⚔ Debate Arena
          </h1>

          {/* Round dots + label — drop dots on mobile, keep "1/3" */}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {!isMobile && Array.from({ length: maxRounds }, (_, i) => (
              <span
                key={i}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: i + 1 < currentRound
                    ? 'var(--wildcard)'
                    : i + 1 === currentRound
                      ? 'var(--text-primary)'
                      : 'var(--border)',
                  transition: 'background 0.3s'
                }}
              />
            ))}
            <span style={{
              fontSize: isMobile ? '12px' : '13px',
              color: 'var(--text-secondary)',
              marginLeft: isMobile ? 0 : '4px',
              whiteSpace: 'nowrap'
            }}>
              {isMobile
                ? `R${Math.min(currentRound, maxRounds)}/${maxRounds}`
                : `Round ${Math.min(currentRound, maxRounds)}/${maxRounds}`}
            </span>
          </div>
        </div>

        {/* Center: Score — desktop only. Mobile renders the score in
            its own band below to give it room to breathe. */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          {!isMobile && scoreEl}
        </div>

        {/* Right: voice attribution (desktop) + Mute + Stop + New Debate */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? '6px' : '16px',
          minWidth: 0,
          justifySelf: 'end'
        }}>
          {!isMobile && (
            <a
              href="https://elevenlabs.io"
              target="_blank"
              rel="noopener noreferrer"
              title="Voice powered by ElevenLabs"
              style={{
                fontSize: '11px',
                color: 'var(--text-muted)',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                opacity: 0.7,
                transition: 'opacity var(--transition)',
                letterSpacing: '0.02em'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7' }}
            >
              Voice by ElevenLabs
            </a>
          )}
          <button
            onClick={() => setMuted(m => !m)}
            aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute' : 'Mute'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: isMobile ? '0.3rem' : '0.35rem',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
              cursor: 'pointer',
              flexShrink: 0,
              transition: 'all var(--transition)'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--text-primary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
          >
            {muted ? <VolumeX size={isMobile ? 14 : 16} /> : <Volume2 size={isMobile ? 14 : 16} />}
          </button>
          {status === 'running' && (
            <button
              onClick={handleStop}
              style={{
                padding: isMobile ? '0.3rem 0.6rem' : '0.4rem 0.8rem',
                background: 'var(--critic-dim)',
                border: '1px solid var(--critic)',
                borderRadius: 'var(--radius)',
                color: 'var(--critic)',
                fontSize: isMobile ? '12px' : '13px',
                cursor: 'pointer',
                flexShrink: 0,
                whiteSpace: 'nowrap',
                transition: 'all var(--transition)'
              }}
              onMouseEnter={(e) => {
                e.target.style.background = 'var(--critic)'
                e.target.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.target.style.background = 'var(--critic-dim)'
                e.target.style.color = 'var(--critic)'
              }}
            >
              Stop
            </button>
          )}
          {status === 'complete' && wasStopped && allClaims.length < maxRounds * AGENT_ORDER.length && (
            <button
              onClick={handleResume}
              style={{
                padding: isMobile ? '0.3rem 0.6rem' : '0.4rem 0.8rem',
                background: 'var(--advocate-dim)',
                border: '1px solid var(--advocate)',
                borderRadius: 'var(--radius)',
                color: 'var(--advocate)',
                fontSize: isMobile ? '12px' : '13px',
                cursor: 'pointer',
                flexShrink: 0,
                whiteSpace: 'nowrap',
                transition: 'all var(--transition)'
              }}
              onMouseEnter={(e) => {
                e.target.style.background = 'var(--advocate)'
                e.target.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.target.style.background = 'var(--advocate-dim)'
                e.target.style.color = 'var(--advocate)'
              }}
            >
              Resume
            </button>
          )}

          <div style={{
            borderRadius: 'var(--radius)',
            padding: '1px',
            background: status === 'complete'
              ? 'var(--shimmer-gradient)'
              : 'var(--border)',
            backgroundSize: '200% 100%',
            animation: status === 'complete' ? 'border-shimmer 4s linear infinite' : 'none',
            flexShrink: 0
          }}>
            <button
              onClick={handleNewDebate}
              style={{
                padding: isMobile ? '0.25rem 0.55rem' : '0.3rem 0.7rem',
                background: 'var(--bg-card)',
                border: 'none',
                borderRadius: 'calc(var(--radius) - 1px)',
                color: 'white',
                fontSize: isMobile ? '12px' : '13px',
                cursor: 'pointer',
                display: 'block',
                width: '100%',
                whiteSpace: 'nowrap'
              }}
            >
              {isMobile ? 'New' : 'New Debate'}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile-only score band — gives the score its own row so it
          doesn't have to compete with controls for header width. */}
      {isMobile && liveScore && (
        <div style={{
          padding: '0.4rem 12px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          flexShrink: 0
        }}>
          {scoreEl}
        </div>
      )}

      {/* Topic band — own row below the header so the centered score
          can never clash with it. Single line with ellipsis truncation. */}
      <div style={{
        padding: isMobile ? '0.4rem 12px' : '0.5rem 24px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        fontSize: '13px',
        color: 'var(--text-secondary)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        overflow: 'hidden'
      }}>
        <span style={{
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          flexShrink: 0
        }}>
          Topic
        </span>
        <span style={{
          color: '#fff',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0
        }}>
          {topic}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: isMobile ? '0.5rem 12px' : '0.6rem 1.5rem',
          background: 'var(--critic-dim)',
          borderBottom: '1px solid var(--critic)',
          color: 'var(--critic)',
          fontSize: '0.85rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.5rem',
          flexShrink: 0
        }}>
          <span>
            <strong style={{ marginRight: 8, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.75rem' }}>
              {RATE_LIMIT_LABELS[error.code] || 'Error'}
            </strong>
            {error.message}
          </span>
          {status === 'error' && error.code !== 'ip_daily' && error.code !== 'global_daily' && (
            <button
              onClick={() => { setError(null); startDebate(topic) }}
              style={{
                padding: '0.3rem 0.6rem',
                background: 'var(--critic)',
                color: '#fff',
                borderRadius: 'var(--radius)',
                fontSize: '0.8rem'
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Main content — desktop: horizontal split (transcript left,
          graph right). Mobile: vertical stack (graph on top, transcript
          below) so the transcript gets full width and doesn't wrap
          one word per line. */}
      <div style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        flexDirection: isMobile ? 'column' : 'row'
      }}>
        {/* Graph + Legend + Verdict — first on mobile, second on desktop */}
        <div style={{
          flex: isMobile ? '0 0 auto' : 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          order: isMobile ? 1 : 2
        }}>
          {/* Graph area */}
          <div style={{
            minHeight: isMobile ? '38vh' : '40vh',
            height: isMobile ? '38vh' : 'auto',
            flex: isMobile ? '0 0 auto' : 1,
            position: 'relative'
          }}>
            <DebateGraph
              graphData={graphData}
              thinkingAgent={thinkingAgent}
              speakingAgent={speakingAgent}
              onNodeClick={handleClaimClick}
              selectedNode={selectedNode}
              status={status}
              claims={allClaims}
            />
            {roundResults.length > 0 && <RoundToasts results={roundResults} />}
          </div>

          {/* Legend bar — outside SVG, between graph and verdict */}
          <DebateGraph.Legend />

          {/* Wildcard verdict — on mobile, render under transcript instead */}
          {!isMobile && status === 'complete' && allClaims.length > 0 && (
            <WildcardVerdict ref={verdictRef} claims={allClaims} verdictText={verdictText} />
          )}
        </div>

        {/* Transcript — second on mobile (below graph), first on desktop (left) */}
        <div style={{
          width: isMobile ? '100%' : '35%',
          flex: isMobile ? 1 : '0 0 35%',
          flexShrink: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: isMobile ? 'none' : '1px solid var(--border)',
          borderTop: isMobile ? '1px solid var(--border)' : 'none',
          overflow: 'hidden',
          order: isMobile ? 2 : 1
        }}>
          {/* During verdict TTS we show (a) the "reading verdict" indicator
              and (b) a karaoke render of the exact TTS text so the user can
              follow word-by-word. Reuses the same KaraokeText component the
              transcript uses for regular claims — the synthetic
              VERDICT_SPEAKING_ID lets per-word timings key into claimWords
              identically to claim TTS. */}
          {(thinkingAgent || speakingClaimId === VERDICT_SPEAKING_ID) && (
            <div style={{ padding: '0.5rem 1rem', flexShrink: 0 }}>
              <ThinkingIndicator
                agentId={thinkingAgent || 'wildcard'}
                label={thinkingAgent ? 'is thinking' : 'is reading debate verdict'}
              />
              {!thinkingAgent && verdictText && (
                <div style={{
                  marginTop: '0.6rem',
                  fontSize: '0.95rem',
                  lineHeight: 1.55,
                  color: 'var(--text-primary)',
                  borderLeft: `3px solid ${AGENTS.wildcard.color}`,
                  paddingLeft: '0.75rem'
                }}>
                  <KaraokeText
                    text={buildVerdictTtsString(verdictText)}
                    words={claimWords[VERDICT_SPEAKING_ID] || []}
                  />
                </div>
              )}
            </div>
          )}
          <Transcript
            claims={allClaims}
            onClaimClick={handleClaimClick}
            selectedNode={selectedNode}
            speakingClaimId={speakingClaimId}
            claimWords={claimWords}
          />
          {isMobile && status === 'complete' && allClaims.length > 0 && (
            <WildcardVerdict ref={verdictRef} claims={allClaims} verdictText={verdictText} />
          )}
        </div>
      </div>
    </div>
  )
}
