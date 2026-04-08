const db = require('../config/database')

// Save AI memory for a client after report generation
async function saveMemory(clientId, financialYear, memoryData) {
  await db.execute(
    `INSERT INTO client_memory (client_id, financial_year, memory_json)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE memory_json = VALUES(memory_json), updated_at = CURRENT_TIMESTAMP`,
    [clientId, financialYear, JSON.stringify(memoryData)]
  )
}

// Get memory for previous year (to use as context when generating current year report)
async function getPreviousYearMemory(clientId, currentFY) {
  // Parse current FY e.g. "2024-25" → get previous "2023-24"
  const prevFY = getPreviousFY(currentFY)
  if (!prevFY) return null

  const [rows] = await db.execute(
    'SELECT memory_json FROM client_memory WHERE client_id = ? AND financial_year = ?',
    [clientId, prevFY]
  )
  if (!rows.length) return null
  try {
    return JSON.parse(rows[0].memory_json)
  } catch {
    return null
  }
}

// Get all memory for a client (all years)
async function getAllMemory(clientId) {
  const [rows] = await db.execute(
    'SELECT financial_year, memory_json, updated_at FROM client_memory WHERE client_id = ? ORDER BY financial_year DESC',
    [clientId]
  )
  return rows.map(r => {
    let parsed = null
    try { parsed = JSON.parse(r.memory_json) } catch {}
    return { financialYear: r.financial_year, memory: parsed, updatedAt: r.updated_at }
  })
}

// Helper: derive previous FY string
// "2024-25" → "2023-24"
// "2024-2025" → "2023-2024"
function getPreviousFY(fy) {
  if (!fy) return null
  // Format: YYYY-YY (e.g. 2024-25)
  const match = fy.match(/^(\d{4})-(\d{2,4})$/)
  if (!match) return null
  const startYear = parseInt(match[1])
  const endSuffix = match[2]
  const prevStart = startYear - 1
  // If endSuffix is 2 digits, derive previous
  if (endSuffix.length === 2) {
    const prevEnd = String(prevStart + 1).slice(2) // e.g. 2023 → "23" for "23-24"
    return `${prevStart}-${prevEnd}`
  } else {
    return `${prevStart}-${prevStart + 1}`
  }
}

module.exports = { saveMemory, getPreviousYearMemory, getAllMemory }
