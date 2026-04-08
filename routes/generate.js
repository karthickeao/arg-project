const express       = require('express')
const router        = express.Router()
const db            = require('../config/database')
const { readFinancialStatements } = require('../services/excelReader')
const { generateReport, extractMemory } = require('../services/claudeService')
const { saveMemory, getPreviousYearMemory } = require('../services/memoryService')

// ── Helper: get file path for a given upload type ─────────────────────────────
async function getUploadPath(clientId, financialYear, uploadType) {
  const [rows] = await db.execute(
    'SELECT file_path FROM uploads WHERE client_id = ? AND financial_year = ? AND upload_type = ? ORDER BY uploaded_at DESC LIMIT 1',
    [clientId, financialYear, uploadType]
  )
  return rows.length ? rows[0].file_path : null
}

// ── Helper: get or create report record ──────────────────────────────────────
async function getOrCreateReport(clientId, financialYear, reportType) {
  let [rows] = await db.execute(
    'SELECT * FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
    [clientId, financialYear, reportType]
  )
  if (!rows.length) {
    await db.execute(
      'INSERT INTO reports (client_id, financial_year, report_type, current_version, status) VALUES (?,?,?,0,"draft")',
      [clientId, financialYear, reportType]
    )
    ;[rows] = await db.execute(
      'SELECT * FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
      [clientId, financialYear, reportType]
    )
  }
  return rows[0]
}

// ── POST /generate/:clientId/:financialYear ───────────────────────────────────
// Full report generation (Option A or first time)
router.post('/:clientId/:financialYear', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { reportType = 'standalone' } = req.body

  try {
    // 1. Get client info
    const [clients] = await db.execute('SELECT * FROM clients WHERE id = ?', [clientId])
    if (!clients.length) return res.status(404).json({ error: 'Client not found.' })
    const client = clients[0]

    // 2. Verify checklist is confirmed
    const [clRows] = await db.execute(
      'SELECT answers_json, confirmed FROM checklist_data WHERE client_id = ? AND financial_year = ?',
      [clientId, financialYear]
    )
    if (!clRows.length || !clRows[0].confirmed) {
      return res.status(400).json({ error: 'Checklist not confirmed. Please complete and confirm checklist first.' })
    }
    let checklistAnswers = null
    try { checklistAnswers = JSON.parse(clRows[0].answers_json) } catch {}

    // 3. Get uploaded Schedule III path
    const schedule3Path = await getUploadPath(clientId, financialYear, 'schedule3')
    if (!schedule3Path) {
      return res.status(400).json({ error: 'Schedule III not uploaded. Please upload the Round off Financial Statement Excel.' })
    }

    // 4. Read financial data from Excel
    let financialData = null
    try {
      financialData = await readFinancialStatements(schedule3Path)
    } catch (e) {
      return res.status(400).json({ error: `Could not read financial data: ${e.message}` })
    }

    // 5. Get previous year report path (for memory/reference)
    const prevReportPath = await getUploadPath(clientId, financialYear, 'prev_annual_report')

    // 6. Get previous year memory
    const memory = await getPreviousYearMemory(clientId, financialYear)

    // 7. Generate report via Claude API
    const reportHtml = await generateReport({
      companyName:       client.name,
      financialData,
      checklistAnswers,
      memory,
      mode:              'full',
      prevReportFilePath: prevReportPath,
    })

    // 8. Get or create report record
    const report = await getOrCreateReport(clientId, financialYear, reportType)
    const newVersion = report.current_version + 1

    // 9. Save version
    await db.execute(
      `INSERT INTO report_versions (report_id, version_number, version_label, content, action_type)
       VALUES (?, ?, ?, ?, 'ai_generated')`,
      [report.id, newVersion, `AI Generated — v${newVersion}`, reportHtml]
    )

    // 10. Update report current version
    await db.execute(
      'UPDATE reports SET current_version = ?, status = "draft", updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newVersion, report.id]
    )

    // 11. Update FY status
    await db.execute(
      `INSERT INTO client_fy_data (client_id, financial_year, report_status)
       VALUES (?, ?, 'generated')
       ON DUPLICATE KEY UPDATE report_status = 'generated', last_updated = CURRENT_TIMESTAMP`,
      [clientId, financialYear]
    )

    // 12. Extract and save memory (async — don't block response)
    extractMemory({ companyName: client.name, reportHtml, checklistAnswers, financialData })
      .then(mem => saveMemory(clientId, financialYear, mem))
      .catch(e => console.warn('Memory extraction failed:', e.message))

    // 13. Log activity
    await db.execute(
      'INSERT INTO activity_log (client_id, financial_year, action_text, action_type) VALUES (?,?,?,?)',
      [clientId, financialYear, `${client.name} — Annual report generated`, 'generated']
    )

    res.json({
      success:       true,
      reportId:      report.id,
      versionNumber: newVersion,
      content:       reportHtml,
      message:       'Annual Report generated successfully.',
    })
  } catch (err) {
    console.error('Generation error:', err)
    res.status(500).json({ error: err.message || 'Report generation failed.' })
  }
})

// ── POST /generate/:clientId/:financialYear/regenerate ────────────────────────
// Regenerate — Option A (full) or Option B (figures only)
router.post('/:clientId/:financialYear/regenerate', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { mode = 'full', reportType = 'standalone', currentContent } = req.body

  // mode = 'full' (Option A) or 'figures_only' (Option B)
  if (!['full', 'figures_only'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "full" or "figures_only"' })
  }
  if (mode === 'figures_only' && !currentContent) {
    return res.status(400).json({ error: 'currentContent required for figures_only mode.' })
  }

  try {
    const [clients] = await db.execute('SELECT * FROM clients WHERE id = ?', [clientId])
    if (!clients.length) return res.status(404).json({ error: 'Client not found.' })
    const client = clients[0]

    const [clRows] = await db.execute(
      'SELECT answers_json FROM checklist_data WHERE client_id = ? AND financial_year = ?',
      [clientId, financialYear]
    )
    let checklistAnswers = null
    try { checklistAnswers = JSON.parse(clRows[0]?.answers_json) } catch {}

    const schedule3Path = await getUploadPath(clientId, financialYear, 'schedule3')
    if (!schedule3Path) return res.status(400).json({ error: 'Schedule III not found.' })

    let financialData = null
    try { financialData = await readFinancialStatements(schedule3Path) } catch (e) {
      return res.status(400).json({ error: `Cannot read financials: ${e.message}` })
    }

    const prevReportPath = await getUploadPath(clientId, financialYear, 'prev_annual_report')
    const memory = await getPreviousYearMemory(clientId, financialYear)

    const reportHtml = await generateReport({
      companyName:       client.name,
      financialData,
      checklistAnswers,
      memory,
      mode,
      existingContent:   currentContent,
      prevReportFilePath: prevReportPath,
    })

    const report = await getOrCreateReport(clientId, financialYear, reportType)
    const newVersion = report.current_version + 1
    const actionType = mode === 'full' ? 'regenerated_full' : 'regenerated_figures'
    const label = mode === 'full'
      ? `Regenerated Full — v${newVersion}`
      : `Regenerated Figures Only — v${newVersion}`

    await db.execute(
      `INSERT INTO report_versions (report_id, version_number, version_label, content, action_type)
       VALUES (?, ?, ?, ?, ?)`,
      [report.id, newVersion, label, reportHtml, actionType]
    )
    await db.execute(
      'UPDATE reports SET current_version = ?, status = "draft", updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newVersion, report.id]
    )

    await db.execute(
      `UPDATE client_fy_data SET report_status = 'generated', last_updated = CURRENT_TIMESTAMP
       WHERE client_id = ? AND financial_year = ?`,
      [clientId, financialYear]
    )

    // Update memory after full regeneration
    if (mode === 'full') {
      extractMemory({ companyName: client.name, reportHtml, checklistAnswers, financialData })
        .then(mem => saveMemory(clientId, financialYear, mem))
        .catch(e => console.warn('Memory update failed:', e.message))
    }

    await db.execute(
      'INSERT INTO activity_log (client_id, financial_year, action_text, action_type) VALUES (?,?,?,?)',
      [clientId, financialYear, `${client.name} — Report regenerated (${mode === 'full' ? 'Option A: Full' : 'Option B: Figures only'})`, 'generated']
    )

    res.json({ success: true, versionNumber: newVersion, content: reportHtml })
  } catch (err) {
    console.error('Regeneration error:', err)
    res.status(500).json({ error: err.message || 'Regeneration failed.' })
  }
})

module.exports = router
