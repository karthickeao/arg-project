const express  = require('express')
const router   = express.Router()
const path     = require('path')
const fs       = require('fs')
const db       = require('../config/database')
const { exportToWord } = require('../services/wordExport')

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads'

// ── POST /export/:clientId/:financialYear/word ────────────────────────────────
router.post('/:clientId/:financialYear/word', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { reportType = 'standalone', content } = req.body

  try {
    let htmlContent = content
    if (!htmlContent) {
      const [reports] = await db.execute(
        'SELECT id, current_version FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
        [clientId, financialYear, reportType]
      )
      if (!reports.length) return res.status(404).json({ error: 'Report not found.' })
      const [versions] = await db.execute(
        'SELECT content FROM report_versions WHERE report_id = ? AND version_number = ?',
        [reports[0].id, reports[0].current_version]
      )
      if (!versions.length) return res.status(404).json({ error: 'No content found.' })
      htmlContent = versions[0].content
    }

    const [clients] = await db.execute('SELECT name FROM clients WHERE id = ?', [clientId])
    const companyName = clients[0]?.name || 'Company'
    const safeName    = companyName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40)
    const filename    = `${safeName}_Annual_Report_${financialYear}.docx`
    const outputDir   = path.join(UPLOAD_DIR, clientId, financialYear, 'exports')

    const filePath = await exportToWord({ htmlContent, outputDir, filename })

    // Save word file path in DB
    const [reports] = await db.execute(
      'SELECT id, current_version FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
      [clientId, financialYear, reportType]
    )
    if (reports.length) {
      await db.execute(
        'UPDATE report_versions SET word_file_path = ? WHERE report_id = ? AND version_number = ?',
        [filePath, reports[0].id, reports[0].current_version]
      )
    }

    res.download(filePath, filename, err => {
      if (err && !res.headersSent) res.status(500).json({ error: 'File download failed.' })
    })
  } catch (err) {
    console.error('Word export error:', err)
    res.status(500).json({ error: err.message || 'Word export failed.' })
  }
})

// ── POST /export/:clientId/:financialYear/pdf ─────────────────────────────────
// Uses puppeteer with system chromium.
// If chromium is not installed, returns 503 with instructions.
router.post('/:clientId/:financialYear/pdf', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { reportType = 'standalone', content } = req.body

  try {
    let htmlContent = content
    if (!htmlContent) {
      const [reports] = await db.execute(
        'SELECT id, current_version FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
        [clientId, financialYear, reportType]
      )
      if (!reports.length) return res.status(404).json({ error: 'Report not found.' })
      const [versions] = await db.execute(
        'SELECT content FROM report_versions WHERE report_id = ? AND version_number = ?',
        [reports[0].id, reports[0].current_version]
      )
      if (!versions.length) return res.status(404).json({ error: 'No content found.' })
      htmlContent = versions[0].content
    }

    const [clients] = await db.execute('SELECT name FROM clients WHERE id = ?', [clientId])
    const companyName = clients[0]?.name || 'Company'
    const safeName    = companyName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40)
    const filename    = `${safeName}_Annual_Report_${financialYear}.pdf`
    const outputDir   = path.join(UPLOAD_DIR, clientId, financialYear, 'exports')
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
    const filePath = path.join(outputDir, filename)

    let puppeteer
    try {
      puppeteer = require('puppeteer')
    } catch {
      return res.status(503).json({
        error: 'PDF export requires Chromium. Run: apt-get install chromium-browser  then restart the server.'
      })
    }

    // Try system chromium paths (common on Linux servers)
    const chromePaths = [
      process.env.CHROME_PATH,
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/local/bin/chromium',
    ].filter(Boolean)

    let browser
    for (const execPath of chromePaths) {
      if (execPath && fs.existsSync(execPath)) {
        browser = await puppeteer.launch({
          executablePath: execPath,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        }).catch(() => null)
        if (browser) break
      }
    }

    // Try default (works if Chrome was downloaded via puppeteer on dev)
    if (!browser) {
      browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      }).catch(e => { throw new Error(`Chromium not found. Set CHROME_PATH env var. ${e.message}`) })
    }

    const page = await browser.newPage()
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  @page { margin: 25mm 20mm; size: A4; }
  body { font-family: Arial, sans-serif; font-size: 10.5pt; line-height: 1.6; color: #000; }
  h1 { font-size: 12pt; font-weight: bold; text-align: center; margin: 16pt 0 6pt; text-transform: uppercase; }
  h2 { font-size: 11pt; font-weight: bold; margin: 12pt 0 4pt; }
  h3 { font-size: 10.5pt; font-weight: bold; margin: 8pt 0 3pt; }
  p  { margin-bottom: 5pt; text-align: justify; }
  table { width: 100%; border-collapse: collapse; margin: 6pt 0; font-size: 9.5pt; }
  th { border: 0.5pt solid #333; padding: 3pt 5pt; background: #f2f2f2; font-weight: bold; }
  td { border: 0.5pt solid #666; padding: 2.5pt 5pt; }
  tr.total-row td { font-weight: bold; border-top: 1.5pt solid #000; }
  ol, ul { margin-left: 18pt; margin-bottom: 5pt; }
  li { margin-bottom: 2pt; }
  hr { border: none; border-top: 0.5pt solid #333; margin: 10pt 0; }
</style></head><body>${htmlContent}</body></html>`

    await page.setContent(fullHtml, { waitUntil: 'networkidle0' })
    await page.pdf({ path: filePath, format: 'A4', printBackground: true })
    await browser.close()

    // Save pdf path
    const [reports] = await db.execute(
      'SELECT id, current_version FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
      [clientId, financialYear, reportType]
    )
    if (reports.length) {
      await db.execute(
        'UPDATE report_versions SET pdf_file_path = ? WHERE report_id = ? AND version_number = ?',
        [filePath, reports[0].id, reports[0].current_version]
      )
    }

    res.download(filePath, filename, err => {
      if (err && !res.headersSent) res.status(500).json({ error: 'PDF download failed.' })
    })
  } catch (err) {
    console.error('PDF export error:', err)
    res.status(500).json({ error: err.message || 'PDF export failed.' })
  }
})

// ── GET /export/:clientId/:financialYear/version/:versionId/word ──────────────
router.get('/:clientId/:financialYear/version/:versionId/word', async (req, res) => {
  const { clientId, financialYear, versionId } = req.params
  try {
    const [rows] = await db.execute(
      'SELECT word_file_path, version_label FROM report_versions WHERE id = ?',
      [versionId]
    )
    if (!rows.length || !rows[0].word_file_path) {
      return res.status(404).json({ error: 'Word file not generated for this version.' })
    }
    if (!fs.existsSync(rows[0].word_file_path)) {
      return res.status(404).json({ error: 'File not found on server.' })
    }
    res.download(rows[0].word_file_path)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
