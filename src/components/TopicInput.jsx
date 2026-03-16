import { useState } from 'react'

const SUGGESTIONS = [
  'AI will create more jobs than it destroys',
  'Space colonization should be humanity\'s top priority',
  'Social media does more harm than good',
  'Universal basic income is inevitable'
]

export default function TopicInput({ onStart }) {
  const [topic, setTopic] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (topic.trim()) onStart(topic.trim())
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
          Debate Arena
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
          3 AI agents. 3 rounds. One topic.
        </p>
      </div>

      <form onSubmit={handleSubmit} style={{
        display: 'flex',
        gap: '0.75rem',
        width: '100%',
        maxWidth: '600px'
      }}>
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
      </form>

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        justifyContent: 'center',
        maxWidth: '600px'
      }}>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setTopic(s)}
            style={{
              padding: '0.5rem 1rem',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: '2rem',
              color: 'var(--text-secondary)',
              fontSize: '0.85rem',
              transition: 'all var(--transition)'
            }}
            onMouseEnter={(e) => {
              e.target.style.borderColor = 'var(--wildcard)'
              e.target.style.color = 'var(--text-primary)'
            }}
            onMouseLeave={(e) => {
              e.target.style.borderColor = 'var(--border)'
              e.target.style.color = 'var(--text-secondary)'
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
