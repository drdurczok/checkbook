import { useEffect, useRef } from 'react'

/**
 * A field of dots that drift in a slow, layered sine wave. Rendered on a canvas
 * behind the sign-in card. Honours prefers-reduced-motion by drawing a single
 * static frame.
 */
export function AuthWaveBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const spacing = 46
    let width = 0
    let height = 0
    let cols = 0
    let rows = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      // Zoom the entire field out on mobile, including wave displacement and dots.
      const scale = rect.width <= 640 ? 0.65 : 1
      width = rect.width / scale
      height = rect.height / scale
      canvas.width = Math.floor(rect.width * dpr)
      canvas.height = Math.floor(rect.height * dpr)
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)
      cols = Math.ceil(width / spacing) + 2
      rows = Math.ceil(height / spacing) + 2
    }
    resize()

    const styles = getComputedStyle(document.documentElement)
    const accent = styles.getPropertyValue('--accent').trim() || '37 99 235'
    const start = performance.now()
    let raf = 0

    const draw = (now: number) => {
      const t = (now - start) / 1000
      ctx.clearRect(0, 0, width, height)
      for (let i = 0; i < cols; i += 1) {
        for (let j = 0; j < rows; j += 1) {
          const baseX = i * spacing
          const baseY = j * spacing
          const wave = Math.sin(baseX * 0.012 + t * 0.6) + Math.cos(baseY * 0.014 - t * 0.5)
          const x = baseX + Math.cos(baseY * 0.01 + t * 0.4) * 10
          const y = baseY + wave * 10
          const intensity = (wave + 2) / 4
          const radius = 1 + intensity * 2.2
          const alpha = 0.08 + intensity * 0.3
          ctx.beginPath()
          ctx.arc(x, y, radius, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${accent}, ${alpha.toFixed(3)})`
          ctx.fill()
        }
      }
      if (!reduceMotion) {
        raf = requestAnimationFrame(draw)
      }
    }

    const handleResize = () => {
      resize()
      if (reduceMotion) {
        draw(start)
      }
    }

    raf = requestAnimationFrame(draw)
    window.addEventListener('resize', handleResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return <canvas ref={canvasRef} className="auth-wave" aria-hidden="true" />
}
