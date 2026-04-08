require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const path    = require('path')
const fs      = require('fs')

const app = express()

// ── Ensure uploads directory exists ─────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads'
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin:         process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials:    true,
  exposedHeaders: ['Content-Disposition'], // required for frontend to read download filename
}))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// Serve uploaded files (for finalized reports etc.)
app.use('/files', express.static(path.resolve(UPLOAD_DIR)))

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/clients',   require('./routes/clients'))
app.use('/api/upload',    require('./routes/upload'))
app.use('/api/checklist', require('./routes/checklist'))
app.use('/api/generate',  require('./routes/generate'))
app.use('/api/reports',   require('./routes/reports'))
app.use('/api/export',    require('./routes/export'))

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' })
})

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message)
  // Multer file type error
  if (err.message && err.message.includes('File type not allowed')) {
    return res.status(400).json({ error: err.message })
  }
  // File too large
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum 20MB allowed.' })
  }
  res.status(500).json({ error: err.message || 'Internal server error.' })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`✅ ARG Backend running on port ${PORT}`)
  console.log(`   Frontend: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`)
  console.log(`   Upload dir: ${path.resolve(UPLOAD_DIR)}`)
})
