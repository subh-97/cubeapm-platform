/**
 * Minimal inline SVG sparkline, no Recharts dependency for this one.
 * Falls back cleanly when data is missing.
 *
 * Straight segments and a flat fill, same as every Recharts chart on the
 * platform - see components/charts/chartDefaults.js for why.
 */
export default function Sparkline({ data = [], color = '#3B82F6', height = 32 }) {
  if (!data.length) return null

  const width = 120
  const values = data.map(d => d.v ?? d.value ?? 0)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  }).join(' ')

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-full"
      preserveAspectRatio="none"
    >
      <polygon
        points={`0,${height} ${points} ${width},${height}`}
        fill={color}
        fillOpacity="0.16"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
