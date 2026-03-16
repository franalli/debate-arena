import { useState, useCallback, useRef } from 'react'
import TopicInput from './components/TopicInput.jsx'
import DebateGraph from './components/DebateGraph.jsx'
import Transcript from './components/Transcript.jsx'
import ThinkingIndicator from './components/ThinkingIndicator.jsx'
import WildcardVerdict from './components/WildcardVerdict.jsx'
import { runDebate } from './lib/debate.js'
import { buildGraphData } from './lib/graphUtils.js'

export default function App() {
  const [topic, setTopic] = useState('')
  const [status, setStatus] = useState('idle') // idle | running | complete | error
  const [currentRound, setCurrentRound] = useState(0)
  const maxRounds = 3
  const [thinkingAgent, setThinkingAgent] = useState(null)
  const [allClaims, setAllClaims] = useState([])
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [selectedNode, setSelectedNode] = useState(null)
  const [verdictText, setVerdictText] = useState(null)
  const [error, setError] = useState(null)
  const cancelRef = useRef(null)

  const startDebate = useCallback((debateTopic) => {
    setTopic(debateTopic)
    setStatus('running')
    setCurrentRound(1)
    setAllClaims([])
    setGraphData({ nodes: [], links: [] })
    setSelectedNode(null)
    setVerdictText(null)
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
        setCurrentRound(round + 1)
      },
      onError: (err, agentId) => {
        setThinkingAgent(null)
        setError(err.message)
        if (err.message.includes('401')) {
          setStatus('error')
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
    })

    cancelRef.current = cancel
  }, [])

  const handleStop = () => {
    if (cancelRef.current) cancelRef.current()
    cancelRef.current = null
    setThinkingAgent(null)
    setStatus('complete')
  }

  const handleNewDebate = () => {
    if (cancelRef.current) cancelRef.current()
    setStatus('idle')
    setTopic('')
    setAllClaims([])
    setGraphData({ nodes: [], links: [] })
    setThinkingAgent(null)
    setVerdictText(null)
    setError(null)
  }

  const handleClaimClick = useCallback((claimId) => {
    setSelectedNode(prev => prev === claimId ? null : claimId)
  }, [])

  if (status === 'idle') {
    return <TopicInput onStart={startDebate} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.75rem 1.5rem',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 style={{
            fontSize: '1.2rem',
            fontWeight: 700,
            background: 'linear-gradient(135deg, var(--advocate), var(--wildcard), var(--critic))',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent'
          }}>
            Debate Arena
          </h1>

          {/* Round dots */}
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
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
              R{Math.min(currentRound, maxRounds)}/{maxRounds}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <span style={{
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            maxWidth: 400,
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
                fontSize: '0.8rem',
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
          <button
            onClick={handleNewDebate}
            style={{
              padding: '0.4rem 0.8rem',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: 'var(--text-secondary)',
              fontSize: '0.8rem',
              transition: 'all var(--transition)'
            }}
            onMouseEnter={(e) => {
              e.target.style.borderColor = 'var(--text-muted)'
              e.target.style.color = 'var(--text-primary)'
            }}
            onMouseLeave={(e) => {
              e.target.style.borderColor = 'var(--border)'
              e.target.style.color = 'var(--text-secondary)'
            }}
          >
            New Debate
          </button>
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
          {/* Graph area — never shrinks below 55vh */}
          <div style={{ minHeight: '55vh', flex: 1, position: 'relative' }}>
            <DebateGraph
              graphData={graphData}
              thinkingAgent={thinkingAgent}
              onNodeClick={handleClaimClick}
              selectedNode={selectedNode}
              status={status}
              claims={allClaims}
            />
          </div>

          {/* Legend bar — outside SVG, between graph and verdict */}
          <DebateGraph.Legend claims={allClaims} />

          {/* Wildcard verdict */}
          {status === 'complete' && allClaims.length > 0 && (
            <WildcardVerdict claims={allClaims} verdictText={verdictText} />
          )}
        </div>
      </div>
    </div>
  )
}
