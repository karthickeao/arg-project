const express = require('express')
const router  = express.Router()
const db      = require('../config/database')

// ── GET /reports/:clientId/:financialYear ─────────────────────────────────────
// Get current report content and metadata
router.get('/:clientId/:financialYear', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { reportType = 'standalone' } = req.query

  try {
    const [reports] = await db.execute(
      'SELECT * FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
      [clientId, financialYear, reportType]
    )
    if (!reports.length) {
      return res.json({ report: null, currentVersion: null, versions: [] })
    }
    const report = reports[0]

    // Get current version content
    const [versions] = await db.execute(
      'SELECT * FROM report_versions WHERE report_id = ? ORDER BY version_number DESC',
      [report.id]
    )

    // Current version is latest
    const currentVersion = versions.find(v => v.version_number === report.current_version)

    res.json({
      report: {
        id:              report.id,
        status:          report.status,
        isFinalized:     !!report.is_finalized,
        currentVersion:  report.current_version,
        reportType:      report.report_type,
        updatedAt:       report.updated_at,
      },
      content:        currentVersion?.content || null,
      currentVersion: currentVersion ? {
        id:            currentVersion.id,
        versionNumber: currentVersion.version_number,
        label:         currentVersion.version_label,
        actionType:    currentVersion.action_type,
        createdAt:     currentVersion.created_at,
      } : null,
      versions: versions.map(v => ({
        id:            v.id,
        versionNumber: v.version_number,
        label:         v.version_label,
        actionType:    v.action_type,
        hasWord:       !!v.word_file_path,
        hasPdf:        !!v.pdf_file_path,
        createdAt:     v.created_at,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /reports/:clientId/:financialYear/version/:versionId ──────────────────
// Get specific version content
router.get('/:clientId/:financialYear/version/:versionId', async (req, res) => {
  const { clientId, financialYear, versionId } = req.params
  try {
    const [rows] = await db.execute(
      `SELECT rv.* FROM report_versions rv
       JOIN reports r ON rv.report_id = r.id
       WHERE r.client_id = ? AND r.financial_year = ? AND rv.id = ?`,
      [clientId, financialYear, versionId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Version not found.' })
    res.json({ content: rows[0].content, version: rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /reports/:clientId/:financialYear/save ───────────────────────────────
// Save draft (manual edit)
router.post('/:clientId/:financialYear/save', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { content, reportType = 'standalone' } = req.body

  if (!content) return res.status(400).json({ error: 'content required.' })

  try {
    // Get report
    const [reports] = await db.execute(
      'SELECT * FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
      [clientId, financialYear, reportType]
    )
    if (!reports.length) return res.status(404).json({ error: 'Report not found. Generate first.' })
    const report = reports[0]

    // Check if report is complete (locked)
    if (report.status === 'complete') {
      return res.status(400).json({ error: 'Report is marked as complete. Reopen for revision to edit.' })
    }

    const newVersion = report.current_version + 1
    await db.execute(
      `INSERT INTO report_versions (report_id, version_number, version_label, content, action_type)
       VALUES (?, ?, ?, ?, 'manual_edit')`,
      [report.id, newVersion, `Draft Saved — v${newVersion}`, content]
    )
    await db.execute(
      'UPDATE reports SET current_version = ?, status = "draft", updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newVersion, report.id]
    )
    await db.execute(
      `UPDATE client_fy_data SET report_status = 'draft', last_updated = CURRENT_TIMESTAMP
       WHERE client_id = ? AND financial_year = ?`,
      [clientId, financialYear]
    )

    res.json({ success: true, versionNumber: newVersion, message: 'Draft saved.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /reports/:clientId/:financialYear/mark-complete ──────────────────────
router.post('/:clientId/:financialYear/mark-complete', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { reportType = 'standalone' } = req.body

  try {
    const [reports] = await db.execute(
      'SELECT * FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
      [clientId, financialYear, reportType]
    )
    if (!reports.length) return res.status(404).json({ error: 'Report not found.' })
    const report = reports[0]

    // Save a version record for the mark-complete action
    const newVersion = report.current_version + 1
    const [latestVer] = await db.execute(
      'SELECT content FROM report_versions WHERE report_id = ? ORDER BY version_number DESC LIMIT 1',
      [report.id]
    )
    const content = latestVer[0]?.content || ''

    await db.execute(
      `INSERT INTO report_versions (report_id, version_number, version_label, content, action_type)
       VALUES (?, ?, ?, ?, 'marked_complete')`,
      [report.id, newVersion, `Marked Complete — ${new Date().toLocaleDateString('en-IN')}`, content]
    )
    await db.execute(
      'UPDATE reports SET current_version = ?, status = "complete", updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newVersion, report.id]
    )
    await db.execute(
      `UPDATE client_fy_data SET report_status = 'complete', last_updated = CURRENT_TIMESTAMP
       WHERE client_id = ? AND financial_year = ?`,
      [clientId, financialYear]
    )

    const [clients] = await db.execute('SELECT name FROM clients WHERE id = ?', [clientId])
    await db.execute(
      'INSERT INTO activity_log (client_id, financial_year, action_text, action_type) VALUES (?,?,?,?)',
      [clientId, financialYear, `${clients[0]?.name} — Report marked as complete`, 'complete']
    )

    res.json({ success: true, message: 'Report marked as complete.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /reports/:clientId/:financialYear/reopen ─────────────────────────────
router.post('/:clientId/:financialYear/reopen', async (req, res) => {
  const { clientId, financialYear } = req.params
  const { reportType = 'standalone' } = req.body

  try {
    const [reports] = await db.execute(
      'SELECT * FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
      [clientId, financialYear, reportType]
    )
    if (!reports.length) return res.status(404).json({ error: 'Report not found.' })
    const report = reports[0]

    const newVersion = report.current_version + 1
    const [latestVer] = await db.execute(
      'SELECT content FROM report_versions WHERE report_id = ? ORDER BY version_number DESC LIMIT 1',
      [report.id]
    )
    const content = latestVer[0]?.content || ''

    await db.execute(
      `INSERT INTO report_versions (report_id, version_number, version_label, content, action_type)
       VALUES (?, ?, ?, ?, 'reopened')`,
      [report.id, newVersion, `Reopened for Revision — ${new Date().toLocaleDateString('en-IN')}`, content]
    )
    await db.execute(
      'UPDATE reports SET current_version = ?, status = "draft", updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newVersion, report.id]
    )
    await db.execute(
      `UPDATE client_fy_data SET report_status = 'draft', last_updated = CURRENT_TIMESTAMP
       WHERE client_id = ? AND financial_year = ?`,
      [clientId, financialYear]
    )

    const [clients] = await db.execute('SELECT name FROM clients WHERE id = ?', [clientId])
    await db.execute(
      'INSERT INTO activity_log (client_id, financial_year, action_text, action_type) VALUES (?,?,?,?)',
      [clientId, financialYear, `${clients[0]?.name} — Report reopened for revision`, 'reopen']
    )

    res.json({ success: true, message: 'Report reopened for revision.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /reports/:clientId/:financialYear/restore/:versionId ─────────────────
// Restore a previous version
router.post('/:clientId/:financialYear/restore/:versionId', async (req, res) => {
  const { clientId, financialYear, versionId } = req.params
  const { reportType = 'standalone' } = req.body

  try {
    const [verRows] = await db.execute(
      `SELECT rv.* FROM report_versions rv
       JOIN reports r ON rv.report_id = r.id
       WHERE r.client_id = ? AND r.financial_year = ? AND rv.id = ?`,
      [clientId, financialYear, versionId]
    )
    if (!verRows.length) return res.status(404).json({ error: 'Version not found.' })

    const [reports] = await db.execute(
      'SELECT * FROM reports WHERE client_id = ? AND financial_year = ? AND report_type = ?',
      [clientId, financialYear, reportType]
    )
    if (!reports.length) return res.status(404).json({ error: 'Report not found.' })
    const report = reports[0]

    if (report.status === 'complete') {
      return res.status(400).json({ error: 'Cannot restore version while report is complete. Reopen first.' })
    }

    const newVersion = report.current_version + 1
    await db.execute(
      `INSERT INTO report_versions (report_id, version_number, version_label, content, action_type)
       VALUES (?, ?, ?, ?, 'manual_edit')`,
      [report.id, newVersion, `Restored from v${verRows[0].version_number} — v${newVersion}`, verRows[0].content]
    )
    await db.execute(
      'UPDATE reports SET current_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newVersion, report.id]
    )

    res.json({ success: true, content: verRows[0].content, versionNumber: newVersion })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
