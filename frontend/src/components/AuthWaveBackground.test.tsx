import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthWaveBackground } from './AuthWaveBackground'

const context = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  fillStyle: '',
}
const requestFrame = vi.fn<typeof requestAnimationFrame>()
const cancelFrame = vi.fn<typeof cancelAnimationFrame>()
let bounds: DOMRect
let reduceMotion: boolean

function drawFrame(now = 1000) {
  const callback = requestFrame.mock.calls.at(-1)?.[0]
  if (!callback) {
    throw new Error('Expected a scheduled animation frame')
  }
  act(() => callback(now))
}

function resize(width: number, height: number) {
  bounds = new DOMRect(0, 0, width, height)
  act(() => window.dispatchEvent(new Event('resize')))
}

describe('AuthWaveBackground', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bounds = new DOMRect(0, 0, 1280, 800)
    reduceMotion = false
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => bounds)
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    vi.stubGlobal('devicePixelRatio', 3)
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({ matches: reduceMotion })))
    vi.stubGlobal('requestAnimationFrame', requestFrame.mockReturnValue(7))
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('preserves desktop geometry, caps pixel density, and keeps animating', () => {
    const { container, unmount } = render(<AuthWaveBackground />)
    const canvas = container.querySelector('canvas')
    expect(canvas).toHaveAttribute('aria-hidden', 'true')
    expect(canvas).toHaveAttribute('width', '2560')
    expect(canvas).toHaveAttribute('height', '1600')
    expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0)

    drawFrame()
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 1280, 800)
    expect(context.arc).toHaveBeenCalledTimes((Math.ceil(1280 / 46) + 2) * (Math.ceil(800 / 46) + 2))
    expect(context.arc).toHaveBeenNthCalledWith(1, 10, 10, expect.closeTo(2.65), 0, Math.PI * 2)
    expect(requestFrame).toHaveBeenCalledTimes(2)

    context.arc.mockClear()
    drawFrame(2000)
    expect(context.arc.mock.calls[0]?.[0]).not.toBe(10)
    expect(requestFrame).toHaveBeenCalledTimes(3)
    unmount()
    expect(cancelFrame).toHaveBeenCalledWith(7)
  })

  it('fits more dots on mobile by proportionally scaling the whole field', () => {
    bounds = new DOMRect(0, 0, 390, 845)
    const { container } = render(<AuthWaveBackground />)
    const canvas = container.querySelector('canvas')
    expect(canvas).toHaveAttribute('width', '780')
    expect(canvas).toHaveAttribute('height', '1690')
    expect(context.setTransform).toHaveBeenLastCalledWith(1.3, 0, 0, 1.3, 0, 0)

    drawFrame()
    const expectedDots = (Math.ceil(600 / 46) + 2) * (Math.ceil(1300 / 46) + 2)
    const originalDots = (Math.ceil(390 / 46) + 2) * (Math.ceil(845 / 46) + 2)
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 600, 1300)
    expect(context.arc).toHaveBeenCalledTimes(expectedDots)
    expect(expectedDots).toBeGreaterThan(originalDots * 2)
    // Unchanged world geometry plus the canvas transform scales waves and radii together.
    expect(context.arc).toHaveBeenNthCalledWith(1, 10, 10, expect.closeTo(2.65), 0, Math.PI * 2)
  })

  it('updates the mobile scale across the breakpoint and cleans up its resize listener', () => {
    const { unmount } = render(<AuthWaveBackground />)
    resize(640, 800)
    expect(context.setTransform).toHaveBeenLastCalledWith(1.3, 0, 0, 1.3, 0, 0)
    drawFrame()
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 640 / 0.65, 800 / 0.65)

    resize(641, 800)
    expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0)
    drawFrame()
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 641, 800)
    unmount()
    context.setTransform.mockClear()
    resize(390, 845)
    expect(context.setTransform).not.toHaveBeenCalled()
  })

  it('draws one reduced-motion frame and redraws it after resizing without animation', () => {
    reduceMotion = true
    render(<AuthWaveBackground />)
    drawFrame()
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(context.clearRect).toHaveBeenCalledTimes(1)

    context.arc.mockClear()
    resize(390, 845)
    expect(context.setTransform).toHaveBeenLastCalledWith(1.3, 0, 0, 1.3, 0, 0)
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 600, 1300)
    expect(context.arc).toHaveBeenCalled()
    expect(context.arc).toHaveBeenNthCalledWith(1, 10, 10, expect.closeTo(2.65), 0, Math.PI * 2)
    expect(requestFrame).toHaveBeenCalledTimes(1)
  })
})
