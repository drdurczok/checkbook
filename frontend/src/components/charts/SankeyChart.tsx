import { sankey, sankeyJustify, sankeyLinkHorizontal } from 'd3-sankey'
import type { SankeyGraph, SankeyLink, SankeyNode } from 'd3-sankey'
import type { BreakdownPoint } from '../../contracts/dashboard'
import { formatCurrency } from './shared'
import type { SankeyLinkDatum, SankeyNodeDatum } from './shared'

export function SankeyChart({
  incomes,
  expenses,
  cashFlow,
  currency,
}: {
  incomes: BreakdownPoint[]
  expenses: BreakdownPoint[]
  cashFlow: Array<{ period: string; value: number }>
  currency: string
}) {
  const expenseTotal = expenses.reduce((sum, item) => sum + item.value, 0)
  const incomeTotal = incomes.reduce((sum, item) => sum + item.value, 0)
  const cashFlowNet = cashFlow.reduce((sum, item) => sum + item.value, 0)
  const inferredIncome = incomeTotal || Math.max(expenseTotal + cashFlowNet, 0)
  const retained = Math.max(inferredIncome - expenseTotal, 0)
  const gap = Math.max(expenseTotal - inferredIncome, 0)
  const sourceItems = [
    ...(inferredIncome > 0 ? [{ label: 'Total Income', value: inferredIncome, share: 1 }] : []),
    ...(gap > 0 ? [{ label: 'Funding gap', value: gap, share: gap / expenseTotal }] : []),
  ]
  const destinationItems = [
    ...expenses,
    ...(retained > 0 ? [{ label: 'Retained', value: retained, share: retained / inferredIncome }] : []),
  ]

  if (sourceItems.length === 0 || destinationItems.length === 0 || sourceItems.every((item) => item.value <= 0)) {
    return <div className="chart-empty">No flow data yet</div>
  }

  const palette = ['#1e6fd6', '#12946f', '#e88936', '#7c5cff', '#d5476a', '#64748b', '#0f766e', '#be5a19']
  const width = 920
  const positiveSources = sourceItems.filter((item) => item.value > 0)
  const positiveDestinations = destinationItems.filter((item) => item.value > 0)
  const height = Math.max(360, Math.max(positiveSources.length, positiveDestinations.length) * 58 + 80)
  const sourceNodes: Array<SankeyNode<SankeyNodeDatum, SankeyLinkDatum>> = positiveSources
    .map((item, index) => ({
      id: `source-${index}-${item.label}`,
      label: item.label,
      kind: item.label === 'Funding gap' ? 'result' : 'income',
      color: item.label === 'Funding gap' ? '#d5476a' : palette[index % palette.length],
    }))
  const destinationNodes: Array<SankeyNode<SankeyNodeDatum, SankeyLinkDatum>> = positiveDestinations
    .map((item, index) => ({
      id: `destination-${index}-${item.label}`,
      label: item.label,
      kind: item.label === 'Retained' ? 'result' : 'expense',
      color: item.label === 'Retained' ? '#12946f' : palette[index % palette.length],
    }))
  const nodes: SankeyNode<SankeyNodeDatum, SankeyLinkDatum>[] = [
    ...sourceNodes,
    ...destinationNodes,
  ]
  const incomeNode = sourceNodes.find((node) => node.label === 'Total Income')
  const gapNode = sourceNodes.find((node) => node.label === 'Funding gap')
  let incomeRemaining = inferredIncome
  const links: SankeyLink<SankeyNodeDatum, SankeyLinkDatum>[] = destinationNodes.flatMap((destinationNode, destinationIndex) => {
    const destination = positiveDestinations[destinationIndex]
    if (destination.label === 'Retained') {
      return incomeNode
        ? [{
            source: incomeNode.id,
            target: destinationNode.id,
            value: destination.value,
            color: destinationNode.color,
            label: destination.label,
          }]
        : []
    }

    const incomeValue = Math.min(destination.value, Math.max(incomeRemaining, 0))
    incomeRemaining -= incomeValue
    const gapValue = Math.max(destination.value - incomeValue, 0)
    return [
      ...(incomeNode && incomeValue > 0
        ? [{
            source: incomeNode.id,
            target: destinationNode.id,
            value: incomeValue,
            color: destinationNode.color,
            label: destination.label,
          }]
        : []),
      ...(gapNode && gapValue > 0
        ? [{
            source: gapNode.id,
            target: destinationNode.id,
            value: gapValue,
            color: gapNode.color,
            label: destination.label,
          }]
        : []),
    ]
  })
  const graph: SankeyGraph<SankeyNodeDatum, SankeyLinkDatum> = sankey<SankeyNodeDatum, SankeyLinkDatum>()
    .nodeId((node) => node.id)
    .nodeAlign(sankeyJustify)
    .nodeWidth(18)
    .nodePadding(24)
    .nodeSort(null)
    .linkSort(null)
    .extent([[18, 34], [width - 18, height - 34]])
    .iterations(32)({ nodes: nodes.map((node) => ({ ...node })), links: links.map((link) => ({ ...link })) })
  const path = sankeyLinkHorizontal<SankeyNodeDatum, SankeyLinkDatum>()
  const linkEndpoint = (node: string | number | SankeyNode<SankeyNodeDatum, SankeyLinkDatum>) =>
    typeof node === 'object' ? node.label : String(node)

  return (
    <div className="sankey-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Money flow Sankey diagram">
        <g className="sankey-links">
          {graph.links.map((link, index) => (
            <path
              d={path(link) ?? undefined}
              key={`${link.label}-${index}`}
              stroke={link.color}
              strokeWidth={Math.max(link.width ?? 1, 1)}
            >
              <title>
                {`${linkEndpoint(link.source)} -> ${linkEndpoint(link.target)}: ${formatCurrency(link.value, currency)}`}
              </title>
            </path>
          ))}
        </g>

        {graph.nodes.map((node) => {
          const x0 = node.x0 ?? 0
          const x1 = node.x1 ?? x0
          const y0 = node.y0 ?? 0
          const y1 = node.y1 ?? y0
          const isLeft = (node.depth ?? 0) === 0
          const labelX = isLeft ? x1 + 10 : x0 - 10
          const textAnchor = isLeft ? 'start' : 'end'
          const labelY = (y0 + y1) / 2 - 3
          const valueY = (y0 + y1) / 2 + 13
          const value = node.value ?? 0
          return (
            <g className="sankey-node" key={node.id}>
              <rect fill={node.color} height={Math.max(y1 - y0, 1)} rx="4" width={x1 - x0} x={x0} y={y0} />
              <text className="sankey-label" textAnchor={textAnchor} x={labelX} y={labelY}>
                {node.label}
              </text>
              <text className="sankey-value" textAnchor={textAnchor} x={labelX} y={valueY}>
                {formatCurrency(value, currency)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

