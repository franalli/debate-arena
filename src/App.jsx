import { useState, useCallback, useRef, useMemo } from 'react'
import TopicInput from './components/TopicInput.jsx'
import DebateGraph from './components/DebateGraph.jsx'
import Transcript from './components/Transcript.jsx'
import ThinkingIndicator from './components/ThinkingIndicator.jsx'
import WildcardVerdict from './components/WildcardVerdict.jsx'
import RoundToasts from './components/RoundToasts.jsx'
import { runDebate } from './lib/debate.js'
import { buildGraphData, computeWildcardScore } from './lib/graphUtils.js'
import { AGENTS } from './lib/agents.js'

export default function App() {
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
  const cooldownTimerRef = useRef(null)

  const startDebate = useCallback((debateTopic, selectedMode) => {
    if (selectedMode) setMode(selectedMode)
    const activeMode = selectedMode || mode
    setTopic(debateTopic)
    setStatus('running')
    setCurrentRound(1)
    setAllClaims([])
    setGraphData({ nodes: [], links: [] })
    setSelectedNode(null)
    setVerdictText(null)
    setRoundResults([])
    setError(null)

    let accumulated = []

    const cancel = runDebate(debateTopic, maxRounds, {
      onAgentStart: (agentId, round) => {
        setThinkingAgent(agentId)
        setCurrentRound(round)
      },
      onAgentComplete: (agentId, round, newClaims) => {
        setThinkingAgent(null)
        accumulated = [...accumulated, ...newClaims]
        setAllClaims([...accumulated])
        setGraphData(buildGraphData(accumulated))
      },
      onRoundComplete: (round) => {
        // Determine round winner from Wildcard's agreement
        const wc = accumulated.find(c => c.agentId === 'wildcard' && c.round === round)
        if (wc?.agrees_with) {
          const target = accumulated.find(c => c.id === wc.agrees_with)
          const winnerId = target?.agentId || (wc.agrees_with.startsWith('adv') ? 'advocate' : wc.agrees_with.startsWith('crt') ? 'critic' : null)
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
        setError(err.message)
        // Auto-clear cooldown messages after the wait expires
        const cooldownMatch = err.message.match(/Wait (\d+)s/)
        if (cooldownMatch) {
          if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
          cooldownTimerRef.current = setTimeout(() => setError(null), Number(cooldownMatch[1]) * 1000)
        }
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
        setStatus('complete')
      }
    }, activeMode)

    cancelRef.current = cancel
  }, [mode, maxRounds])

  const handleStop = () => {
    if (cancelRef.current) cancelRef.current()
    cancelRef.current = null
    setThinkingAgent(null)
    setStatus('complete')
  }

  const handleNewDebate = () => {
    if (cancelRef.current) cancelRef.current()
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
    setStatus('idle')
    setTopic('')
    setAllClaims([])
    setGraphData({ nodes: [], links: [] })
    setThinkingAgent(null)
    setVerdictText(null)
    setRoundResults([])
    setError(null)
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
    const leading = score.advocate > score.critic ? 'advocate' : score.critic > score.advocate ? 'critic' : null
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '48px',
        padding: '0 24px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0
      }}>
        {/* Left: Title + Rounds */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h1 style={{
            fontSize: '16px',
            fontWeight: 700,
            background: 'linear-gradient(135deg, var(--advocate), var(--wildcard), var(--critic))',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            margin: 0
          }}>
            ⚔ Debate Arena
          </h1>

          {/* Round dots + label */}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {Array.from({ length: maxRounds }, (_, i) => (
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
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', marginLeft: '4px' }}>
              Round {Math.min(currentRound, maxRounds)}/{maxRounds}
            </span>
          </div>
        </div>

        {/* Center: Score — absolutely centered on the full bar */}
        <div style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          pointerEvents: liveScore?.isComplete ? 'auto' : 'none'
        }}>
          {liveScore && (
            <span
              onClick={liveScore.isComplete ? () => {
                verdictRef.current?.expand()
                setTimeout(() => verdictRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
              } : undefined}
              style={{
                fontSize: '22px',
                fontWeight: 700,
                color: liveScore.color,
                cursor: liveScore.isComplete ? 'pointer' : 'default',
                textDecoration: liveScore.isComplete ? 'underline' : 'none',
                textDecorationStyle: 'dotted',
                textUnderlineOffset: '3px',
                whiteSpace: 'nowrap'
              }}
            >
              {liveScore.label}
            </span>
          )}
        </div>

        {/* Right: Topic + Fast/Deep + New Debate */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{
            fontSize: '13px',
            color: '#fff',
            maxWidth: '350px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}>
            {topic}
          </span>
          {status === 'running' && (
            <button
              onClick={handleStop}
              style={{
                padding: '0.4rem 0.8rem',
                background: 'var(--critic-dim)',
                border: '1px solid var(--critic)',
                borderRadius: 'var(--radius)',
                color: 'var(--critic)',
                fontSize: '13px',
                cursor: 'pointer',
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
          {/* Fast/Deep toggle */}
          <div style={{
            display: 'flex',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            fontSize: '13px',
            marginLeft: '8px',
            opacity: 0.4,
            pointerEvents: 'none'
          }}>
            {['fast', 'deep'].map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  padding: '0.3rem 0.6rem',
                  background: mode === m ? 'var(--wildcard)' : 'transparent',
                  color: mode === m ? '#fff' : 'var(--text-secondary)',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all var(--transition)',
                  textTransform: 'capitalize'
                }}
              >
                {m}
              </button>
            ))}
          </div>

          <div style={{
            borderRadius: 'var(--radius)',
            padding: '1px',
            background: status === 'complete'
              ? 'linear-gradient(90deg, var(--advocate), var(--wildcard), var(--critic), var(--wildcard), var(--advocate))'
              : 'var(--border)',
            backgroundSize: '200% 100%',
            animation: status === 'complete' ? 'border-shimmer 4s linear infinite' : 'none',
          }}>
            <button
              onClick={handleNewDebate}
              style={{
                padding: '0.3rem 0.7rem',
                background: 'var(--bg-card)',
                border: 'none',
                borderRadius: 'calc(var(--radius) - 1px)',
                color: 'white',
                fontSize: '13px',
                cursor: 'pointer',
                display: 'block',
                width: '100%',
              }}
            >
              New Debate
            </button>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: '0.6rem 1.5rem',
          background: 'var(--critic-dim)',
          borderBottom: '1px solid var(--critic)',
          color: 'var(--critic)',
          fontSize: '0.85rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0
        }}>
          <span>{error}</span>
          {status === 'error' && (
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

      {/* Main content — horizontal split */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left: Transcript (35%) */}
        <div style={{
          width: '35%',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--border)',
          overflow: 'hidden'
        }}>
          {thinkingAgent && (
            <div style={{ padding: '0.5rem 1rem', flexShrink: 0 }}>
              <ThinkingIndicator agentId={thinkingAgent} />
            </div>
          )}
          <Transcript
            claims={allClaims}
            onClaimClick={handleClaimClick}
            selectedNode={selectedNode}
          />
        </div>

        {/* Right: Graph + Legend + Verdict (65%) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          {/* Graph area */}
          <div style={{ minHeight: '40vh', flex: 1, position: 'relative' }}>
            <DebateGraph
              graphData={graphData}
              thinkingAgent={thinkingAgent}
              onNodeClick={handleClaimClick}
              selectedNode={selectedNode}
              status={status}
              claims={allClaims}
            />
            {roundResults.length > 0 && <RoundToasts results={roundResults} />}
          </div>

          {/* Legend bar — outside SVG, between graph and verdict */}
          <DebateGraph.Legend />

          {/* Wildcard verdict */}
          {status === 'complete' && allClaims.length > 0 && (
            <WildcardVerdict ref={verdictRef} claims={allClaims} verdictText={verdictText} />
          )}
        </div>
      </div>
    </div>
  )
}
