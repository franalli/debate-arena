import { useState } from 'react'

const SUGGESTIONS = [
  ['AI will replace most software engineers within 5 years', 'Space colonization should be humanity\'s top priority'],
  ['Social media does more harm than good', 'Universal basic income is inevitable'],
  ['Pineapple belongs on pizza', 'Remote work is better than office work']
]

function ShimmerButton({ text, onClick }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: '2rem',
        padding: '1px',
        background: 'linear-gradient(90deg, var(--advocate), var(--wildcard), var(--critic), var(--wildcard), var(--advocate))',
        backgroundSize: '200% 100%',
        animation: 'border-shimmer 4s linear infinite',
        cursor: 'pointer',
        opacity: hovered ? 1 : 0.7,
        transition: 'opacity 0.3s'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <button
        style={{
          display: 'block',
          width: '100%',
          padding: '0.5rem 1rem',
          background: 'var(--bg-card)',
          borderRadius: '2rem',
          color: '#ffffff',
          fontSize: '0.85rem',
          whiteSpace: 'nowrap',
          transition: 'color 0.3s',
          border: 'none',
          cursor: 'pointer'
        }}
      >
        {text}
      </button>
    </div>
  )
}

export default function TopicInput({ onStart }) {
  const [topic, setTopic] = useState('')
  const [mode, setMode] = useState('fast')
  const rounds = 3

  const handleSubmit = (e) => {
    e.preventDefault()
    if (topic.trim()) onStart(topic.trim(), mode)
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '2rem',
      gap: '2rem'
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{
          fontSize: '2.5rem',
          fontWeight: 700,
          marginBottom: '0.5rem',
          background: 'linear-gradient(135deg, var(--advocate), var(--wildcard), var(--critic))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent'
        }}>
          ⚔ Debate Arena
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
          3 AI agents. {rounds} rounds. One topic.
        </p>
      </div>

      <form onSubmit={handleSubmit} style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
        width: '100%',
        maxWidth: '800px'
      }}>
        {/* Input + Start row */}
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Enter a debate topic..."
            autoFocus
            style={{
              flex: 1,
              padding: '0.85rem 1.2rem',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: 'var(--text-primary)',
              fontSize: '1rem',
              outline: 'none',
              transition: 'border-color var(--transition)'
            }}
            onFocus={(e) => e.target.style.borderColor = 'var(--wildcard)'}
            onBlur={(e) => e.target.style.borderColor = 'var(--border)'}
          />
          <button
            type="submit"
            disabled={!topic.trim()}
            style={{
              padding: '0.85rem 1.5rem',
              background: topic.trim() ? 'var(--wildcard)' : 'var(--bg-card)',
              color: topic.trim() ? '#fff' : 'var(--text-muted)',
              borderRadius: 'var(--radius)',
              fontWeight: 600,
              transition: 'all var(--transition)'
            }}
          >
            Start
          </button>
        </div>

        {/* Fast/Deep toggle row */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{
            display: 'flex',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            fontSize: '0.85rem'
          }}>
            {['fast', 'deep'].map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  padding: '0.4rem 1.2rem',
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
        </div>
      </form>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        maxWidth: '700px',
        width: '100%'
      }}>
        {SUGGESTIONS.map((row, i) => (
          <div key={i} style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
            {row.map((s) => (
              <ShimmerButton key={s} text={s} onClick={() => setTopic(s)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
