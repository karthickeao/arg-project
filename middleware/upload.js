const multer = require('multer')
const path   = require('path')
const fs     = require('fs')

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads'

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Organise by clientId/FY
    const { clientId, financialYear } = req.params
    const dir = path.join(UPLOAD_DIR, clientId, financialYear || 'general')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    // uploadType is set on req by the route before calling multer
    const type = req.uploadType || 'file'
    const ext  = path.extname(file.originalname)
    const ts   = Date.now()
    cb(null, `${type}_${ts}${ext}`)
  },
})

function fileFilter(req, file, cb) {
  const allowed = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.ms-excel',                                           // xls
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv',
  ]
  if (allowed.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}`), false)
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
})

module.exports = upload
