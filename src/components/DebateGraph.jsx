import { useRef, useEffect, useState, useMemo } from 'react'
import { select } from 'd3-selection'
import 'd3-transition'
import { AGENTS, AGENT_ORDER } from '../lib/agents.js'
import { getWinner, computeWildcardScore } from '../lib/graphUtils.js'

// ── Arena geometry (viewBox 0 0 800 700) ──
const VB_W = 800, VB_H = 700
const CENTROID = { x: 400, y: 380 }

const LAYOUT = {
  advocate: { anchor: { x: 400, y: 80 },  claimAngle: 90 },   // claims radiate DOWN into arena
  critic:   { anchor: { x: 100, y: 600 }, claimAngle: -45 },   // claims radiate UP-RIGHT into arena
  wildcard: { anchor: { x: 700, y: 600 }, claimAngle: -135 }   // claims radiate UP-LEFT into arena
}

const ROUND_DIST = { 1: 80, 2: 160, 3: 240 }

function claimPos(agentId, round) {
  const a = LAYOUT[agentId]
  const dist = ROUND_DIST[round] || ROUND_DIST[3]
  const rad = (a.claimAngle * Math.PI) / 180
  return {
    x: a.anchor.x + dist * Math.cos(rad),
    y: a.anchor.y + dist * Math.sin(rad)
  }
}

// Shorthand for anchor coords
const ANCHOR = {
  advocate: LAYOUT.advocate.anchor,
  critic: LAYOUT.critic.anchor,
  wildcard: LAYOUT.wildcard.anchor
}

export default function DebateGraph({ graphData, thinkingAgent, onNodeClick, selectedNode, status, claims }) {
  const svgRef = useRef(null)
  const [tooltip, setTooltip] = useState(null)
  const containerRef = useRef(null)
  const onNodeClickRef = useRef(onNodeClick)
  onNodeClickRef.current = onNodeClick
  const prevNodeCount = useRef(0)

  const winner = useMemo(() => {
    if (status !== 'complete' || !claims?.length) return null
    return getWinner(claims)
  }, [status, claims])

  const liveScore = useMemo(() => {
    if (!claims?.length) return null
    const score = computeWildcardScore(claims)
    const advPts = score.advocate.agreed + score.critic.rebutted
    const crtPts = score.critic.agreed + score.advocate.rebutted
    return { advPts, crtPts }
  }, [claims])

  // Build position map for all nodes
  const posMap = useMemo(() => {
    const m = new Map()
    for (const n of graphData.nodes) {
      m.set(n.id, claimPos(n.agentId, n.round))
    }
    return m
  }, [graphData.nodes])

  // ── Main render ──
  useEffect(() => {
    const svg = select(svgRef.current)

    // Clear everything and re-render
    svg.selectAll('*').remove()

    // ── Defs ──
    const defs = svg.append('defs')

    // Arrow markers per agent
    for (const id of AGENT_ORDER) {
      defs.append('marker')
        .attr('id', `arrow-${id}`)
        .attr('viewBox', '0 0 10 6')
        .attr('refX', 10).attr('refY', 3)
        .attr('markerWidth', 10).attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path').attr('d', 'M0,0 L10,3 L0,6 Z')
        .attr('fill', AGENTS[id].color)
    }

    // Glow filters per agent
    for (const id of AGENT_ORDER) {
      const filter = defs.append('filter').attr('id', `glow-${id}`)
        .attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%')
      filter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', 10)
        .attr('result', 'blur')
      const merge = filter.append('feMerge')
      merge.append('feMergeNode').attr('in', 'blur')
      merge.append('feMergeNode').attr('in', 'SourceGraphic')
    }

    // Agreement glow filter (green)
    const agreeFilter = defs.append('filter').attr('id', 'glow-agree')
      .attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%')
    agreeFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', 10)
      .attr('result', 'blur')
    const agreeMerge = agreeFilter.append('feMerge')
    agreeMerge.append('feMergeNode').attr('in', 'blur')
    agreeMerge.append('feMergeNode').attr('in', 'SourceGraphic')

    // ── Layer 1: Arena background ──
    const bg = svg.append('g').attr('class', 'arena-bg')

    // Concentric circles from centroid
    for (const r of [80, 160, 240]) {
      bg.append('circle')
        .attr('cx', CENTROID.x).attr('cy', CENTROID.y).attr('r', r)
        .attr('fill', 'none').attr('stroke', '#ffffff').attr('stroke-opacity', 0.03)
        .attr('stroke-width', 1)
    }

    // Triangle connecting anchors
    const pts = AGENT_ORDER.map(id => `${LAYOUT[id].anchor.x},${LAYOUT[id].anchor.y}`).join(' ')
    bg.append('polygon')
      .attr('points', pts)
      .attr('fill', 'none')
      .attr('stroke', '#ffffff').attr('stroke-opacity', 0.08)
      .attr('stroke-width', 1)

    // Center diamond
    const cx = CENTROID.x, cy = CENTROID.y, ds = 6
    bg.append('polygon')
      .attr('points', `${cx},${cy - ds} ${cx + ds},${cy} ${cx},${cy + ds} ${cx - ds},${cy}`)
      .attr('fill', '#ffffff').attr('fill-opacity', 0.1)

    // ── Layer 2: Rebuttal edges (curved) ──
    const rebuttalGroup = svg.append('g').attr('class', 'rebuttal-edges')
    const rebuttalLinks = graphData.links.filter(l => l.type === 'rebuttal')

    // Group by target so we can spread overlapping edges
    const rebuttalsByTarget = {}
    for (const l of rebuttalLinks) {
      if (!rebuttalsByTarget[l.target]) rebuttalsByTarget[l.target] = []
      rebuttalsByTarget[l.target].push(l)
    }

    // Build a radius lookup from nodes
    const nodeRadiusMap = new Map(graphData.nodes.map(n => [n.id, n.radius]))

    for (const l of rebuttalLinks) {
      const src = posMap.get(l.source)
      const tgt = posMap.get(l.target)
      if (!src || !tgt) continue

      const tgtRadius = nodeRadiusMap.get(l.target) || 24
      const srcRadius = nodeRadiusMap.get(l.source) || 24

      // Spread: vary bulge for multiple edges targeting the same node
      const siblings = rebuttalsByTarget[l.target]
      const idx = siblings.indexOf(l)
      const count = siblings.length

      const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2
      const dx = tgt.x - src.x, dy = tgt.y - src.y
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const px = -dy / len, py = dx / len
      const toCenter = (CENTROID.x - mx) * px + (CENTROID.y - my) * py
      const sign = toCenter >= 0 ? 1 : -1
      const spreadOffset = count > 1 ? (idx - (count - 1) / 2) * 30 : 0
      const baseBulge = Math.min(len * 0.25, 60) * sign
      const bulge = baseBulge + spreadOffset
      const cpx = mx + px * bulge, cpy = my + py * bulge

      // Shorten start: pull src along start tangent by source radius
      const stx = cpx - src.x, sty = cpy - src.y
      const stLen = Math.sqrt(stx * stx + sty * sty) || 1
      const startX = src.x + (stx / stLen) * (srcRadius + 2)
      const startY = src.y + (sty / stLen) * (srcRadius + 2)

      // Shorten end: pull tgt back along end tangent by target radius + gap for arrowhead
      const etx = tgt.x - cpx, ety = tgt.y - cpy
      const etLen = Math.sqrt(etx * etx + ety * ety) || 1
      const endX = tgt.x - (etx / etLen) * (tgtRadius + 6)
      const endY = tgt.y - (ety / etLen) * (tgtRadius + 6)

      rebuttalGroup.append('path')
        .attr('d', `M${startX},${startY} Q${cpx},${cpy} ${endX},${endY}`)
        .attr('fill', 'none')
        .attr('stroke', l.color)
        .attr('stroke-width', 2.5).attr('stroke-dasharray', '8,5')
        .attr('marker-end', `url(#arrow-${l.sourceAgentId})`)
        .attr('stroke-opacity', 0)
        .transition().duration(600)
        .attr('stroke-opacity', 0.7)
    }

    // ── Layer 3: Agreement edges (glowing) ──
    const agreeGroup = svg.append('g').attr('class', 'agreement-edges')
    const agreementLinks = graphData.links.filter(l => l.type === 'agreement')
    for (const l of agreementLinks) {
      const src = posMap.get(l.source)
      const tgt = posMap.get(l.target)
      if (!src || !tgt) continue

      agreeGroup.append('line')
        .attr('x1', src.x).attr('y1', src.y)
        .attr('x2', tgt.x).attr('y2', tgt.y)
        .attr('stroke', '#22c55e').attr('stroke-width', 4)
        .attr('filter', 'url(#glow-agree)')
        .attr('stroke-opacity', 0)
        .transition().duration(400)
        .attr('stroke-opacity', 0.7)
        .on('end', function () {
          select(this).style('animation', 'agree-pulse 2s ease-in-out infinite')
        })

      // Small circles at both ends
      for (const p of [src, tgt]) {
        agreeGroup.append('circle')
          .attr('cx', p.x).attr('cy', p.y).attr('r', 6)
          .attr('fill', '#22c55e').attr('fill-opacity', 0.6)
          .attr('filter', 'url(#glow-agree)')
      }
    }

    // ── Layer 5: Claim nodes ──
    const claimGroup = svg.append('g').attr('class', 'claim-nodes')

    // Determine which nodes are new (for entrance animation)
    const isNew = graphData.nodes.length > prevNodeCount.current
    prevNodeCount.current = graphData.nodes.length

    for (const node of graphData.nodes) {
      const pos = posMap.get(node.id)
      if (!pos) continue

      const g = claimGroup.append('g')
        .attr('class', `claim claim-${node.agentId}`)
        .attr('transform', `translate(${pos.x},${pos.y})`)
        .attr('cursor', 'pointer')
        .datum(node)

      // Circle — animate radius from 0 on new nodes
      const circle = g.append('circle')
        .attr('r', isNew ? 0 : node.radius)
        .attr('fill', node.color).attr('fill-opacity', 0.7)
        .attr('stroke', node.color).attr('stroke-width', 2.5)

      if (isNew) {
        circle.transition().duration(500)
          .attrTween('r', () => {
            const target = node.radius
            return (t) => {
              // Elastic overshoot: goes to 1.15x then settles
              const ease = t < 0.6
                ? (t / 0.6) * 1.15
                : 1.15 - (t - 0.6) / 0.4 * 0.15
              return target * Math.min(ease, 1.15)
            }
          })
      }

      // Round label inside
      g.append('text')
        .attr('text-anchor', 'middle').attr('dy', '0.35em')
        .attr('fill', '#ffffff').attr('font-size', '14px').attr('font-weight', 700)
        .text(node.round)

      // Selection highlight
      if (node.id === selectedNode) {
        g.select('circle')
          .attr('stroke-width', 3).attr('fill-opacity', 0.9)
          .attr('filter', `url(#glow-${node.agentId})`)
      }

      // Interactions
      g.on('click', (event) => {
        event.stopPropagation()
        onNodeClickRef.current?.(node.id)
      })

      g.on('mouseenter', function () {
        select(this).select('circle')
          .attr('fill-opacity', 1)
          .attr('filter', `url(#glow-${node.agentId})`)
          .attr('transform', 'scale(1.3)')
        const circle = this.querySelector('circle')
        if (circle) {
          const ctm = circle.getScreenCTM()
          if (ctm) setTooltip({ node, x: ctm.e, y: ctm.f })
        }
      })

      g.on('mouseleave', function () {
        const isSelected = node.id === selectedNode
        select(this).select('circle')
          .attr('fill-opacity', isSelected ? 0.9 : 0.7)
          .attr('filter', isSelected ? `url(#glow-${node.agentId})` : null)
          .attr('transform', null)
        setTooltip(null)
      })
    }

    // ── Layer 6: Agent anchors ──
    const anchorGroup = svg.append('g').attr('class', 'agent-anchors')
    for (const agentId of AGENT_ORDER) {
      const a = LAYOUT[agentId].anchor
      const agent = AGENTS[agentId]
      const isWinner = winner === agentId
      const isLoser = winner && winner !== agentId && agentId !== 'wildcard'
      const r = isWinner ? 48 : 40

      const g = anchorGroup.append('g')
        .attr('transform', `translate(${a.x},${a.y})`)

      g.append('circle')
        .attr('r', r)
        .attr('fill', agent.color).attr('fill-opacity', isLoser ? 0.3 : 0.9)
        .attr('stroke', '#ffffff').attr('stroke-width', 3)
        .attr('filter', `url(#glow-${agentId})`)

      g.append('text')
        .attr('text-anchor', 'middle').attr('dy', '-0.15em')
        .attr('fill', '#ffffff').attr('font-size', '16px').attr('font-weight', 700)
        .attr('opacity', isLoser ? 0.4 : 1)
        .text(agent.name)

      g.append('text')
        .attr('text-anchor', 'middle').attr('dy', '1.1em')
        .attr('fill', '#ffffff').attr('font-size', '11px').attr('font-weight', 400)
        .attr('opacity', isLoser ? 0.3 : 0.7)
        .text(agent.model)
    }


  }, [graphData, selectedNode, posMap, winner, status])

  // Thinking pulse on agent anchors
  useEffect(() => {
    if (!thinkingAgent) return
    const svg = select(svgRef.current)
    svg.selectAll('.agent-anchors g circle')
      .each(function () {
        const parent = select(this.parentNode)
        const t = parent.attr('transform') || ''
        const a = LAYOUT[thinkingAgent]?.anchor
        if (a && t.includes(`${a.x},${a.y}`)) {
          select(this)
            .style('--glow-color', AGENTS[thinkingAgent].color)
            .style('animation', 'node-pulse 1.5s ease-in-out infinite')
        }
      })
    return () => {
      svg.selectAll('.agent-anchors circle').style('animation', null)
    }
  }, [thinkingAgent])

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          width: '100%',
          height: '100%',
          background: '#0a0a0a'
        }}
      />

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'fixed',
          left: tooltip.x,
          top: tooltip.y,
          transform: 'translate(-50%, -100%)',
          marginTop: -20,
          background: '#1a1a1a',
          border: `1px solid ${AGENTS[tooltip.node.agentId].color}`,
          borderRadius: 'var(--radius)',
          padding: '0.6rem 0.8rem',
          maxWidth: 280,
          zIndex: 1000,
          pointerEvents: 'none',
          boxShadow: '0 4px 20px rgba(0,0,0,0.6)'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            marginBottom: '0.3rem',
            fontSize: '0.75rem'
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: AGENTS[tooltip.node.agentId].color,
              display: 'inline-block'
            }} />
            <span style={{ color: AGENTS[tooltip.node.agentId].color, fontWeight: 600 }}>
              {AGENTS[tooltip.node.agentId].name}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>
              Round {tooltip.node.round}
            </span>
          </div>
          <p style={{ fontSize: '0.8rem', lineHeight: 1.4, color: 'var(--text-primary)' }}>
            {tooltip.node.text}
          </p>
          {tooltip.node.rebuttalsReceived > 0 && (
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
              Rebutted {tooltip.node.rebuttalsReceived} time{tooltip.node.rebuttalsReceived > 1 ? 's' : ''}
            </p>
          )}
        </div>
      )}

    </div>
  )
}

// Legend as a separate horizontal bar (rendered outside the graph)
function Legend({ claims }) {
  const liveScore = useMemo(() => {
    if (!claims?.length) return null
    const score = computeWildcardScore(claims)
    const advPts = score.advocate.agreed + score.critic.rebutted
    const crtPts = score.critic.agreed + score.advocate.rebutted
    return { advPts, crtPts }
  }, [claims])

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '1.5rem',
      background: 'var(--bg-secondary)',
      borderTop: '1px solid var(--border)',
      padding: '0.5rem 1.2rem',
      fontSize: '0.9rem',
      flexShrink: 0
    }}>
      {AGENT_ORDER.map(id => (
        <span key={id} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: AGENTS[id].color, display: 'inline-block' }} />
          <span style={{ color: AGENTS[id].color, fontWeight: 600 }}>{AGENTS[id].name}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>({AGENTS[id].model})</span>
        </span>
      ))}
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: 'var(--text-muted)' }}>
        <span style={{ width: 24, height: 0, borderTop: '2px dashed var(--text-muted)', display: 'inline-block' }} />
        <span>&#9656;</span>
        <span>attacks</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
        <span style={{ width: 24, height: 0, borderTop: '3px solid #22c55e', display: 'inline-block' }} />
        <span style={{ color: '#22c55e' }}>agrees</span>
      </span>
      {liveScore && (liveScore.advPts > 0 || liveScore.crtPts > 0) && (() => {
        const { advPts, crtPts } = liveScore
        const leading = advPts > crtPts ? 'advocate' : crtPts > advPts ? 'critic' : null
        const label = leading
          ? `Leaning: ${AGENTS[leading].name} ${Math.max(advPts, crtPts)}-${Math.min(advPts, crtPts)}`
          : `Tied ${advPts}-${crtPts}`
        const color = leading ? AGENTS[leading].color : 'var(--text-muted)'
        return (
          <span style={{ color, fontWeight: 600 }}>
            {label}
          </span>
        )
      })()}
    </div>
  )
}

DebateGraph.Legend = Legend
