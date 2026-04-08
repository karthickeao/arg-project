const express = require('express')
const router  = express.Router()
const db      = require('../config/database')
const { getAllMemory } = require('../services/memoryService')

// ── POST /clients/sync ────────────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  const { clients } = req.body
  if (!Array.isArray(clients)) return res.status(400).json({ error: 'clients array required.' })

  try {
    for (const c of clients) {
      if (!c.id || !c.name) continue
      await db.execute(
        `INSERT INTO clients (id, name, cin, filing_type, prev_report_available, has_subsidiaries, is_active, added_date)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           cin = VALUES(cin),
           filing_type = VALUES(filing_type),
           prev_report_available = VALUES(prev_report_available),
           is_active = VALUES(is_active)`,
        [
          c.id, c.name, c.cin || '',
          c.filingType || 'first',
          c.prevReportAvailable ? 1 : 0,
          c.hasSubsidiaries ? 1 : 0,
          c.isActive ? 1 : 0,
          c.addedDate ? new Date(c.addedDate) : new Date(),
        ]
      )
      // Sync all FY data entries
      if (c.fyData && typeof c.fyData === 'object') {
        for (const [fy, fyData] of Object.entries(c.fyData)) {
          if (!fy || !fyData) continue
          await db.execute(
            `INSERT INTO client_fy_data (client_id, financial_year, report_status, deadline, notes)
             VALUES (?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
               deadline = VALUES(deadline),
               notes = VALUES(notes)`,
            // Note: report_status intentionally NOT updated on sync —
            // Phase 2 backend owns report_status after first generation
            [
              c.id, fy,
              fyData.reportStatus || 'not-started',
              fyData.deadline ? new Date(fyData.deadline) : null,
              fyData.notes || '',
            ]
          )
        }
      }
    }
    res.json({ success: true, synced: clients.length })
  } catch (err) {
    console.error('Sync error:', err)
    res.status(500).json({ error: err.message })
  }
})

// IMPORTANT: literal routes must come BEFORE parameterised routes
// to prevent 'activity' being matched as :clientId

// ── GET /clients/activity/recent ──────────────────────────────────────────────
router.get('/activity/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  try {
    const [rows] = await db.execute(
      'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?',
      [limit]
    )
    res.json({ activity: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /clients/:clientId/memory ─────────────────────────────────────────────
router.get('/:clientId/memory', async (req, res) => {
  try {
    const memory = await getAllMemory(req.params.clientId)
    res.json({ memory })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /clients/:clientId/fy-status ─────────────────────────────────────────
router.get('/:clientId/fy-status', async (req, res) => {
  const { clientId } = req.params
  try {
    const [fyRows] = await db.execute(
      'SELECT * FROM client_fy_data WHERE client_id = ? ORDER BY financial_year DESC',
      [clientId]
    )

    const status = {}
    for (const row of fyRows) {
      const [uploads] = await db.execute(
        'SELECT upload_type, original_filename, uploaded_at FROM uploads WHERE client_id = ? AND financial_year = ?',
        [clientId, row.financial_year]
      )
      const [cl] = await db.execute(
        'SELECT confirmed, imported_from_excel FROM checklist_data WHERE client_id = ? AND financial_year = ?',
        [clientId, row.financial_year]
      )
      const [reps] = await db.execute(
        'SELECT report_type, status, current_version, is_finalized FROM reports WHERE client_id = ? AND financial_year = ?',
        [clientId, row.financial_year]
      )

      const uploadMap = {}
      for (const u of uploads) uploadMap[u.upload_type] = { filename: u.original_filename, uploadedAt: u.uploaded_at }

      status[row.financial_year] = {
        reportStatus:       row.report_status,
        deadline:           row.deadline,
        notes:              row.notes,
        uploads:            uploadMap,
        checklistConfirmed: cl.length ? !!cl[0].confirmed : false,
        checklistImported:  cl.length ? !!cl[0].imported_from_excel : false,
        reports:            reps.map(r => ({
          type:      r.report_type,
          status:    r.status,
          version:   r.current_version,
          finalized: !!r.is_finalized,
        })),
      }
    }

    res.json({ status })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
