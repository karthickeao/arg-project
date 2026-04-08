const express    = require('express')
const router     = express.Router()
const path       = require('path')
const fs         = require('fs')
const db         = require('../config/database')
const upload     = require('../middleware/upload')
const { readChecklistSheet, readFinancialStatements } = require('../services/excelReader')

// ── Helper: save upload record to DB ─────────────────────────────────────────
async function saveUploadRecord(clientId, financialYear, uploadType, file) {
  // Remove old upload of same type for same client+FY (only keep latest)
  const [old] = await db.execute(
    'SELECT file_path FROM uploads WHERE client_id = ? AND financial_year = ? AND upload_type = ?',
    [clientId, financialYear, uploadType]
  )
  if (old.length && old[0].file_path) {
    try { fs.unlinkSync(old[0].file_path) } catch {}
    await db.execute(
      'DELETE FROM uploads WHERE client_id = ? AND financial_year = ? AND upload_type = ?',
      [clientId, financialYear, uploadType]
    )
  }

  await db.execute(
    `INSERT INTO uploads
     (client_id, financial_year, upload_type, original_filename, stored_filename, file_path, file_size, mime_type)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      clientId, financialYear, uploadType,
      file.originalname, file.filename, file.path,
      file.size, file.mimetype,
    ]
  )
}

// ── Helper: update client_fy_data status ─────────────────────────────────────
async function updateFYStatus(clientId, financialYear, status) {
  await db.execute(
    `INSERT INTO client_fy_data (client_id, financial_year, report_status)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE report_status = VALUES(report_status), last_updated = CURRENT_TIMESTAMP`,
    [clientId, financialYear, status]
  )
}

// ── POST /upload/:clientId/:financialYear/schedule3 ──────────────────────────
// Upload current year Round off Financial Statement Excel
router.post('/:clientId/:financialYear/schedule3', (req, res, next) => {
  req.uploadType = 'schedule3'
  next()
}, upload.single('file'), async (req, res) => {
  const { clientId, financialYear } = req.params
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' })

  try {
    // 1. Save file record
    await saveUploadRecord(clientId, financialYear, 'schedule3', req.file)

    // 2. Attempt to read checklist from Excel
    let checklistAnswers = null
    let checklistImported = false
    if (req.file.mimetype.includes('spreadsheet') || req.file.originalname.endsWith('.xlsx')) {
      try {
        checklistAnswers = await readChecklistSheet(req.file.path)
        checklistImported = true

        // Save checklist answers to DB
        await db.execute(
          `INSERT INTO checklist_data (client_id, financial_year, answers_json, imported_from_excel)
           VALUES (?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE answers_json = VALUES(answers_json), imported_from_excel = 1, last_updated = CURRENT_TIMESTAMP`,
          [clientId, financialYear, JSON.stringify(checklistAnswers)]
        )
      } catch (e) {
        // Checklist sheet not found — not an error, user may fill manually
        checklistAnswers = null
        checklistImported = false
      }

      // 3. Read financial data to validate file structure
      try {
        await readFinancialStatements(req.file.path)
      } catch (e) {
        // File may be valid Excel but unusual structure — log and continue
        console.warn('Financial data read warning:', e.message)
      }
    }

    // 4. Update FY status to uploaded
    await updateFYStatus(clientId, financialYear, 'uploaded')

    // 5. Log activity
    await db.execute(
      'INSERT INTO activity_log (client_id, financial_year, action_text, action_type) VALUES (?,?,?,?)',
      [clientId, financialYear, 'Schedule III uploaded', 'upload']
    )

    res.json({
      success: true,
      filename: req.file.originalname,
      size: req.file.size,
      checklistImported,
      checklistAnswers,
      message: checklistImported
        ? 'File uploaded and Checklist for AR imported successfully.'
        : 'File uploaded. Checklist for AR sheet not found — please fill checklist manually.',
    })
  } catch (err) {
    console.error('Schedule3 upload error:', err)
    res.status(500).json({ error: err.message || 'Upload failed.' })
  }
})

// ── POST /upload/:clientId/:financialYear/prev-report ─────────────────────────
// Upload previous year Annual Report (PDF or Excel)
router.post('/:clientId/:financialYear/prev-report', (req, res, next) => {
  req.uploadType = 'prev_annual_report'
  next()
}, upload.single('file'), async (req, res) => {
  const { clientId, financialYear } = req.params
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' })

  try {
    await saveUploadRecord(clientId, financialYear, 'prev_annual_report', req.file)

    await db.execute(
      'INSERT INTO activity_log (client_id, financial_year, action_text, action_type) VALUES (?,?,?,?)',
      [clientId, financialYear, 'Previous Year Annual Report uploaded', 'upload']
    )

    res.json({
      success: true,
      filename: req.file.originalname,
      size: req.file.size,
      message: 'Previous year annual report uploaded successfully.',
    })
  } catch (err) {
    console.error('Prev report upload error:', err)
    res.status(500).json({ error: err.message || 'Upload failed.' })
  }
})

// ── POST /upload/:clientId/:financialYear/finalized ───────────────────────────
// Upload the final filed Annual Report (after Mark as Complete)
router.post('/:clientId/:financialYear/finalized', (req, res, next) => {
  req.uploadType = 'finalized_report'
  next()
}, upload.single('file'), async (req, res) => {
  const { clientId, financialYear } = req.params
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' })

  try {
    await saveUploadRecord(clientId, financialYear, 'finalized_report', req.file)

    // Mark report as finalized in reports table
    await db.execute(
      `UPDATE reports SET is_finalized = 1, finalized_file_path = ?
       WHERE client_id = ? AND financial_year = ?`,
      [req.file.path, clientId, financialYear]
    )

    // Add version entry for finalized upload
    const [rep] = await db.execute(
      'SELECT id, current_version FROM reports WHERE client_id = ? AND financial_year = ?',
      [clientId, financialYear]
    )
    if (rep.length) {
      const newVer = rep[0].current_version + 1
      await db.execute(
        `INSERT INTO report_versions (report_id, version_number, version_label, action_type)
         VALUES (?, ?, ?, 'finalized_uploaded')`,
        [rep[0].id, newVer, `Finalized Filed Version — ${new Date().toLocaleDateString('en-IN')}`]
      )
      await db.execute(
        'UPDATE reports SET current_version = ? WHERE id = ?',
        [newVer, rep[0].id]
      )
    }

    await db.execute(
      'INSERT INTO activity_log (client_id, financial_year, action_text, action_type) VALUES (?,?,?,?)',
      [clientId, financialYear, 'Finalized filed report uploaded', 'finalized']
    )

    res.json({
      success: true,
      filename: req.file.originalname,
      message: 'Finalized report uploaded. This will be used as memory reference for next year.',
    })
  } catch (err) {
    console.error('Finalized upload error:', err)
    res.status(500).json({ error: err.message || 'Upload failed.' })
  }
})

// ── GET /upload/:clientId/:financialYear/status ───────────────────────────────
// Get all uploaded files for a client+FY
router.get('/:clientId/:financialYear/status', async (req, res) => {
  const { clientId, financialYear } = req.params
  try {
    const [rows] = await db.execute(
      `SELECT upload_type, original_filename, file_size, uploaded_at
       FROM uploads WHERE client_id = ? AND financial_year = ?`,
      [clientId, financialYear]
    )

    const uploads = {}
    for (const row of rows) {
      uploads[row.upload_type] = {
        filename: row.original_filename,
        size:     row.file_size,
        uploadedAt: row.uploaded_at,
      }
    }

    res.json({ uploads })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
