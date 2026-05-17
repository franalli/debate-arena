import { useState } from 'react'
import { primeAudio, primeTTS, primeStream } from '../lib/audio.js'
import { GoogleLogo, OpenAILogo, AnthropicLogo, ElevenLabsLogo } from './ProviderLogos.jsx'
import { useIsMobile } from '../lib/useMediaQuery.js'

const POWERED_BY = [
  { name: 'Anthropic',  url: 'https://www.anthropic.com',   Logo: AnthropicLogo },
  { name: 'OpenAI',     url: 'https://openai.com',          Logo: OpenAILogo },
  { name: 'Gemini',     url: 'https://deepmind.google/technologies/gemini', Logo: GoogleLogo },
  { name: 'ElevenLabs', url: 'https://elevenlabs.io',       Logo: ElevenLabsLogo }
]

const SUGGESTIONS = [
  ['AI will replace most software engineers within 5 years', 'Space colonization should be humanity\'s top priority'],
  ['Social media does more harm than good', 'Universal basic income is inevitable'],
  ['Pineapple belongs on pizza', 'Remote work is better than office work']
]

function ShimmerButton({ text, onClick, allowWrap = false }) {
  const [hovered, setHovered] = useState(false)

  // When wrapping is allowed (mobile), the wrapper must be free to shrink
  // below the text's intrinsic width so the text can wrap. Without wrapping
  // (desktop), the wrapper should hug the text so the pill border stays
  // flush with the label.
  const wrapperFlex = allowWrap
    ? { flex: '1 1 auto', minWidth: 0, maxWidth: '100%' }
    : {}

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: '2rem',
        padding: '1px',
        background: 'var(--shimmer-gradient)',
        backgroundSize: '200% 100%',
        animation: 'border-shimmer 4s linear infinite',
        cursor: 'pointer',
        opacity: hovered ? 1 : 0.7,
        transition: 'opacity 0.3s',
        ...wrapperFlex
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
          whiteSpace: allowWrap ? 'normal' : 'nowrap',
          lineHeight: 1.3,
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
  const isMobile = useIsMobile()

  const handleSubmit = (e) => {
    e.preventDefault()
    if (topic.trim()) {
      primeAudio()
      primeTTS()
      primeStream()
      onStart(topic.trim(), mode)
    }
  }

  return (
    <div style={{
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      minHeight: '100vh',
      padding: isMobile ? '1.25rem 1rem' : '2rem',
      overflow: 'hidden'
    }}>
      {/* Topographic backdrop — fades toward the center so the headline
          and input remain the focal point. Pointer-events off so it never
          intercepts clicks on the suggestion buttons. */}
      <div
        aria-hidden="true"
        className="topo-backdrop"
        style={{
          position: 'absolute',
          inset: '-100px',
          backgroundImage: 'url(/assets/contours.svg)',
          backgroundSize: '900px 900px',
          backgroundRepeat: 'repeat',
          opacity: 0.07,
          WebkitMaskImage: 'radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.35) 35%, #000 75%)',
          maskImage: 'radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.35) 35%, #000 75%)',
          pointerEvents: 'none',
          zIndex: 0,
          willChange: 'background-position'
        }}
      />
      <div style={{
        position: 'relative',
        zIndex: 1,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '2rem',
        width: '100%'
      }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{
          fontSize: isMobile ? '1.9rem' : '2.5rem',
          fontWeight: 700,
          marginBottom: '0.5rem',
          background: 'var(--title-gradient)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent'
        }}>
          ⚔ Debate Arena
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: isMobile ? '0.95rem' : '1.1rem' }}>
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
          <div
            key={i}
            style={{
              display: 'flex',
              gap: '0.5rem',
              justifyContent: 'center',
              flexDirection: isMobile ? 'column' : 'row',
              alignItems: isMobile ? 'stretch' : 'center'
            }}
          >
            {row.map((s) => (
              <ShimmerButton key={s} text={s} onClick={() => setTopic(s)} allowWrap={isMobile} />
            ))}
          </div>
        ))}
      </div>
      </div>

      <div style={{
        position: 'relative',
        zIndex: 1,
        paddingTop: '2rem',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.75rem'
      }}>
        <span style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.15em'
        }}>
          Powered by
        </span>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1.75rem',
          flexWrap: 'wrap',
          justifyContent: 'center'
        }}>
          {POWERED_BY.map((item) => (
            <a
              key={item.name}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                color: 'var(--text-secondary)',
                textDecoration: 'none',
                fontSize: '0.85rem',
                opacity: 0.7,
                transition: 'opacity var(--transition)'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7' }}
            >
              <item.Logo size={18} />
              <span>{item.name}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
