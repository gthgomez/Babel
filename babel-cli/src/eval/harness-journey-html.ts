/** Optional browser oracle over supplied HTML bytes; no arbitrary URL loading. */
import type { JourneyHtmlObservation } from './harness-journey-oracle.js'

export async function renderJourneyHtml(html: string): Promise<JourneyHtmlObservation> {
  if (Buffer.byteLength(html, 'utf8') > 1_048_576) throw new Error('HTML oracle input exceeds limit')
  const { chromium } = await import('playwright')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' &&
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key.toUpperCase())) env[key] = value
  const browser = await chromium.launch({ headless: true, timeout: 10_000, env })
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 800, height: 600 } })
    await context.route('**/*', route => route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(2000)
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 5000 })
    const heading = page.getByRole('heading', { level: 1 }).first()
    const table = page.getByRole('table', { includeHidden: true }).first()
    const rows: string[][] = []
    if (await table.count()) {
      for (const row of await table.getByRole('row').all()) {
        const cells = await row.getByRole('cell').or(row.getByRole('rowheader')).allTextContents()
        if (cells.length) rows.push(cells.map(cell => cell.trim()))
      }
    }
    const conclusionHeading = page.getByRole('heading', { name: /conclusion/i }).first()
    const conclusion = await conclusionHeading.count() && await conclusionHeading.isVisible()
      ? await conclusionHeading.locator('..').innerText() : ''
    return {
      title: await page.title(), heading: await heading.count() ? await heading.innerText() : '',
      columnHeaders: await table.count() ? (await table.getByRole('columnheader').allTextContents()).map(text => text.trim()) : [],
      rows, conclusion, visible: !!(await heading.count()) && await heading.isVisible() && !!(await table.count()) && await table.isVisible(),
    }
  } finally { await browser.close() }
}
