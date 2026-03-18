import { useState, useEffect } from 'react'

export default function RoundToasts({ results }) {
  return (
    <div style={{
      position: 'absolute',
      top: '1rem',
      left: '1rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
      zIndex: 10,
      pointerEvents: 'none'
    }}>
      {results.map((r, i) => (
        <Toast key={i} result={r} />
      ))}
    </div>
  )
}

function Toast({ result }) {
  const [phase, setPhase] = useState('enter') // enter → visible → exit → gone
  const isError = result.type === 'error'

  useEffect(() => {
    const enterTimer = requestAnimationFrame(() => setPhase('visible'))
    const exitTimer = setTimeout(() => setPhase('exit'), isError ? 4000 : 800)
    const goneTimer = setTimeout(() => setPhase('gone'), isError ? 4400 : 1200)
    return () => {
      cancelAnimationFrame(enterTimer)
      clearTimeout(exitTimer)
      clearTimeout(goneTimer)
    }
  }, [isError])

  if (phase === 'gone') return null

  return (
    <div style={{
      padding: '0.5rem 1rem',
      borderRadius: 'var(--radius)',
      background: 'var(--bg-card)',
      border: `1px solid ${result.color}`,
      boxShadow: `0 2px 12px ${result.color}33`,
      fontSize: '0.85rem',
      fontWeight: 600,
      color: result.color,
      opacity: phase === 'visible' ? 1 : 0,
      transform: phase === 'enter' ? 'translateX(-1rem)' : 'translateX(0)',
      transition: phase === 'exit'
        ? 'opacity 0.35s ease'
        : 'opacity 0.2s ease, transform 0.2s ease',
      whiteSpace: 'nowrap'
    }}>
      {isError
        ? `${result.label} failed — contact admin`
        : `${result.label} wins round ${result.round}`}
    </div>
  )
}
