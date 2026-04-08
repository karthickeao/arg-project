const express = require('express')
const router  = express.Router()
const db      = require('../config/database')

// ── GET /checklist/:clientId/:financialYear ───────────────────────────────────
// Get current checklist answers (imported from Excel or manually saved)
router.get('/:clientId/:financialYear', async (req, res) => {
  const { clientId, financialYear } = req.params
  try {
    const [rows] = await db.execute(
      'SELECT answers_json, imported_from_excel, confirmed, last_updated FROM checklist_data WHERE client_id = ? AND financial_year = ?',
      [clientId, financialYear]
    )
    if (!rows.length) {
      return res.json({ answers: null, importedFromExcel: false, confirmed: false })
    }
    let answers = null
    try { answers = JSON.parse(rows[0].answers_json) } catch {}
    res.json({
      answers,
      importedFromExcel: !!rows[0].imported_from_excel,
      confirmed:         !!rows[0].confirmed,
      lastUpdated:       rows[0].last_updated,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /checklist/:clientId/:financialYear ──────────────────────────────────
// Save checklist answers (manual entry or after reviewing imported answers)
router.post('/:clientId/:financialYear', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { answers } = req.body
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object required.' })
  }

  try {
    await db.execute(
      `INSERT INTO checklist_data (client_id, financial_year, answers_json, imported_from_excel, confirmed)
       VALUES (?, ?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE answers_json = VALUES(answers_json), last_updated = CURRENT_TIMESTAMP`,
      [clientId, financialYear, JSON.stringify(answers)]
    )
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /checklist/:clientId/:financialYear/confirm ─────────────────────────
// Confirm checklist — user has reviewed all answers, ready to generate
router.post('/:clientId/:financialYear/confirm', async (req, res) => {
  const { clientId, financialYear } = req.params
  try {
    const [rows] = await db.execute(
      'SELECT id FROM checklist_data WHERE client_id = ? AND financial_year = ?',
      [clientId, financialYear]
    )
    if (!rows.length) {
      return res.status(400).json({ error: 'No checklist found. Please upload Excel or fill checklist first.' })
    }

    await db.execute(
      'UPDATE checklist_data SET confirmed = 1, last_updated = CURRENT_TIMESTAMP WHERE client_id = ? AND financial_year = ?',
      [clientId, financialYear]
    )

    // Update FY status to checklist-done
    await db.execute(
      `INSERT INTO client_fy_data (client_id, financial_year, report_status)
       VALUES (?, ?, 'checklist-done')
       ON DUPLICATE KEY UPDATE report_status = 'checklist-done', last_updated = CURRENT_TIMESTAMP`,
      [clientId, financialYear]
    )

    await db.execute(
      'INSERT INTO activity_log (client_id, financial_year, action_text, action_type) VALUES (?,?,?,?)',
      [clientId, financialYear, 'Pre-generation checklist confirmed', 'checklist']
    )

    res.json({ success: true, message: 'Checklist confirmed. Generate button is now unlocked.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
