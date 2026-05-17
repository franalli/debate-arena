import { memo } from 'react'
import { Swords } from 'lucide-react'
import { useIsMobile } from '../lib/useMediaQuery.js'

// Brand wordmark used in two places: the landing page (variant='hero')
// and the in-debate header (variant='header'). Both render the Swords
// icon with vertical-align next to a gradient-clipped span. inline-flow
// (not inline-flex) avoids an iOS WebKit repaint bug with background-clip.
// Memoized: the in-debate header re-renders on every streamed word; with
// a stable `variant` prop the memo bails the whole subtree.
function BrandTitle({ variant = 'hero' }) {
  const isMobile = useIsMobile()
  const isHeader = variant === 'header'

  const fontSize = isHeader
    ? (isMobile ? '13px' : '16px')
    : (isMobile ? '1.9rem' : '2.5rem')
  const iconSize = isHeader
    ? (isMobile ? 14 : 18)
    : (isMobile ? 26 : 34)

  return (
    <h1 style={{
      fontSize,
      fontWeight: 700,
      margin: 0,
      marginBottom: isHeader ? 0 : '0.5rem',
      whiteSpace: isHeader ? 'nowrap' : undefined
    }}>
      <Swords
        size={iconSize}
        color="var(--advocate)"
        style={{ verticalAlign: '-0.17em', marginRight: '0.4em' }}
      />
      <span className="gradient-text gradient-text--title">Debate Arena</span>
    </h1>
  )
}

export default memo(BrandTitle)
