import { expect, test } from '@playwright/test'

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 845 }]) {
  test(`sign-in dot field scales to ${viewport.width}px without browser errors`, async ({ page }, testInfo) => {
    const browserErrors: string[] = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    page.on('response', (response) => {
      if (response.status() >= 400) browserErrors.push(`${response.status()} ${response.url()}`)
    })
    page.on('requestfailed', (request) => browserErrors.push(`${request.failure()?.errorText} ${request.url()}`))
    await page.route('http://127.0.0.1:4174/api/**', (route) => route.fulfill({ json: {} }))
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in' }), browserErrors.join('\n')).toBeVisible()

    const canvas = page.locator('canvas.auth-wave')
    const scale = viewport.width <= 640 ? 0.65 : 1
    await expect.poll(() => canvas.evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext('2d')
      return context?.getTransform().a
    })).toBeCloseTo(scale)
    const geometry = await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      const bounds = canvas.getBoundingClientRect()
      const context = canvas.getContext('2d')
      return {
        width: bounds.width,
        height: bounds.height,
        bitmapWidth: canvas.width,
        bitmapHeight: canvas.height,
        drawn: context ? context.getImageData(0, 0, canvas.width, canvas.height).data.some((channel) => channel > 0) : false,
        scrollWidth: document.documentElement.scrollWidth,
      }
    })
    expect(geometry).toEqual({
      width: viewport.width,
      height: viewport.height,
      bitmapWidth: viewport.width,
      bitmapHeight: viewport.height,
      drawn: true,
      scrollWidth: viewport.width,
    })
    await page.screenshot({ path: testInfo.outputPath(`auth-${viewport.width}.png`) })

    // A static reduced-motion canvas must remain visible when switching breakpoints.
    await page.setViewportSize({ width: viewport.width <= 640 ? 1280 : 390, height: viewport.height })
    await expect.poll(() => canvas.evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext('2d')
      return context?.getTransform().a
    })).toBeCloseTo(scale === 1 ? 0.65 : 1)
    expect(await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data.some((channel) => channel > 0)
    })).toBe(true)
    expect(browserErrors).toEqual([])
  })
}
