const ExcelJS = require('exceljs')

// ── Fixed row map for "Checklist for AR" sheet ───────────────────────────────
// These row numbers match the Excel built in build_checklist_v2.py
// Column E (index 5) holds the user answer
const CHECKLIST_ROW_MAP = {
  A1_companyType:        8,
  A2_filingType:         9,
  A3_hasSubsidiaries:   10,
  A4_financialYear:     11,
  A5_roundingUnit:      12,
  A6_balanceSheetDate:  13,
  A7_agmDate:           14,
  A8_boardMeetingsCount:15,
  A9_boardMeetingDates: 16,
  B1_directorChange:    18,
  B2_directorChangeDetails: 19,
  B3_directorRetiring:  20,
  B4_retiringDirectorDetails: 21,
  B5_auditorChange:     22,
  C1_shareTransfer:     24,
  C2_shareTransferDetails: 25,
  C3_newSharesIssued:   26,
  C4_nriShareholder:    27,
  D1_officeChange:      29,
  D2_newAddress:        30,
  D3_objectClauseChange:31,
  D4_loansChargesChange:32,
  D5_cashFlowApplicable:33,
  E1_rptApplicable:     35,
  E2_nonArmLengthCount: 36,
  E3_armLengthCount:    37,
  E4_allRelatedPartiesCovered: 38,
  F1_caroApplicable:    40,
  F2_oavmApplicable:    41,
  F3_objectClauseDetails: 42,
  F4_significantOrders: 43,
  F5_materialChanges:   44,
  G1_fsExcelReady:      46,
  G2_masterDataVerified:47,
  G3_directorDetailsVerified: 48,
  G4_prevYearArStatus:  49,
  G5_cfsReady:          50,
}

// ── Helper: get cell value as trimmed string ─────────────────────────────────
// ExcelJS returns { sharedFormula, result } for formula cells,
// null for secondary cells in a merged region, and a Date for date-formatted cells.
function cellVal(sheet, row, col) {
  const cell = sheet.getRow(row).getCell(col)
  if (!cell) return ''

  let v = cell.value

  // Merged cell secondary tiles: ExcelJS resolves the master automatically
  // when using getCell() — if still null, try the master address
  if (v === null || v === undefined) return ''

  // Formula cell — use result
  if (typeof v === 'object' && v !== null && 'result' in v) {
    v = v.result
  }

  // Shared formula
  if (typeof v === 'object' && v !== null && 'sharedFormula' in v) {
    v = v.result ?? ''
  }

  // Date object
  if (v instanceof Date) {
    const dd   = String(v.getDate()).padStart(2, '0')
    const mm   = String(v.getMonth() + 1).padStart(2, '0')
    const yyyy = v.getFullYear()
    return `${dd}/${mm}/${yyyy}`
  }

  // Rich text
  if (typeof v === 'object' && v !== null && Array.isArray(v.richText)) {
    return v.richText.map(r => r.text || '').join('').trim()
  }

  return String(v).trim()
}

// ── Helper: get numeric value from cell ─────────────────────────────────────
function numVal(sheet, row, col) {
  const cell = sheet.getRow(row).getCell(col)
  if (!cell || cell.value === null || cell.value === undefined) return null
  const v = parseFloat(cell.value)
  return isNaN(v) ? null : v
}

// ════════════════════════════════════════════════════════════════════════════
// 1. READ CHECKLIST ANSWERS FROM "Checklist for AR" SHEET
// ════════════════════════════════════════════════════════════════════════════
async function readChecklistSheet(filePath) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)

  const sheet = wb.getWorksheet('Checklist for AR')
  if (!sheet) {
    throw new Error(
      'Sheet "Checklist for AR" not found in uploaded Excel. ' +
      'Please add this sheet to your Financial Statement Excel and fill it.'
    )
  }

  const answers = {}
  for (const [key, rowNum] of Object.entries(CHECKLIST_ROW_MAP)) {
    answers[key] = cellVal(sheet, rowNum, 5) // Column E
  }

  // Validate critical fields
  if (!answers.A5_roundingUnit) {
    throw new Error('Rounding Unit (A5) is not filled in Checklist for AR sheet.')
  }

  return answers
}

// ════════════════════════════════════════════════════════════════════════════
// 2. READ FINANCIAL STATEMENTS (BS + P&L + Notes + Depreciation)
// ════════════════════════════════════════════════════════════════════════════

// Strategy: Read Column F (current year) and Column G (previous year)
// from BS and P&L sheets. Find rows that have both a label and a numeric value.
// Pass raw data to Claude — Claude understands BS/P&L structure.

function extractSheetData(sheet, sheetName) {
  if (!sheet) return { sheetName, rows: [], unit: '' }

  const rows = []
  let unit = ''

  sheet.eachRow((row, rowIndex) => {
    if (rowIndex < 3) return // Skip first 2 rows (title rows)

    // Look for rounding unit in early rows
    if (rowIndex <= 8) {
      for (let c = 1; c <= 10; c++) {
        const v = cellVal(sheet, rowIndex, c).toLowerCase()
        if (v.includes('lakh') || v.includes("'000") || v.includes('crore') || v.includes('thousand')) {
          unit = cellVal(sheet, rowIndex, c)
        }
      }
    }

    // Get label from column B or C (whichever has more text)
    const labelB = cellVal(sheet, rowIndex, 2)
    const labelC = cellVal(sheet, rowIndex, 3)
    const label  = labelC.length > labelB.length ? labelC : labelB

    // Get note number from column D or E
    const noteNo = cellVal(sheet, rowIndex, 4) || cellVal(sheet, rowIndex, 5)

    // Get current and previous year figures from F and G
    const currentYear  = numVal(sheet, rowIndex, 6)
    const previousYear = numVal(sheet, rowIndex, 7)

    // Only include rows that have a meaningful label
    if (!label || label.length < 2) return
    // Skip pure header rows with no numbers
    if (currentYear === null && previousYear === null) {
      // Include section headers for structure
      if (label.length > 2 && !label.match(/^(Rs|Amount|Rupees|Note|Sl\.?\s*No)/i)) {
        rows.push({ label, noteNo, currentYear: null, previousYear: null, isHeader: true })
      }
      return
    }

    rows.push({ label, noteNo, currentYear, previousYear, isHeader: false })
  })

  return { sheetName, rows, unit }
}

async function readFinancialStatements(filePath) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)

  const result = {
    balanceSheet:    null,
    profitAndLoss:   null,
    notes:           null,
    fixedAssets:     null,
    masterData:      null,
    directorDetails: null,
    allSheetNames:   wb.worksheets.map(s => s.name),
  }

  // Balance Sheet
  const bsSheet = wb.getWorksheet('BS') || wb.getWorksheet('Balance Sheet') || wb.getWorksheet('B/S')
  if (bsSheet) result.balanceSheet = extractSheetData(bsSheet, 'Balance Sheet')

  // P&L
  const plSheet = wb.getWorksheet('P&L') || wb.getWorksheet('P & L') ||
                  wb.getWorksheet('Profit & Loss') || wb.getWorksheet('PL')
  if (plSheet) result.profitAndLoss = extractSheetData(plSheet, 'Profit & Loss')

  // Notes to Accounts
  const notesSheet = wb.getWorksheet('Notes to Accounts') ||
                     wb.getWorksheet('Notes') ||
                     wb.getWorksheet('Notes to accounts')
  if (notesSheet) result.notes = extractSheetData(notesSheet, 'Notes to Accounts')

  // Fixed Assets / Depreciation
  const faSheet = wb.getWorksheet('Companies act depn') ||
                  wb.getWorksheet('Fixed Assets') ||
                  wb.getWorksheet('PPE')
  if (faSheet) result.fixedAssets = extractSheetData(faSheet, 'Fixed Assets')

  // MasterData (Annual Report Excel)
  const mdSheet = wb.getWorksheet('MasterData') || wb.getWorksheet('Master Data')
  if (mdSheet) result.masterData = readMasterData(mdSheet)

  // Director Details (Annual Report Excel)
  const ddSheet = wb.getWorksheet('Director Details') || wb.getWorksheet('Directors')
  if (ddSheet) result.directorDetails = readDirectorDetails(ddSheet)

  return result
}

// ── Read MasterData sheet ─────────────────────────────────────────────────────
function readMasterData(sheet) {
  const data = {}
  sheet.eachRow((row, rowIndex) => {
    const key   = cellVal(sheet, rowIndex, 1)
    const val   = cellVal(sheet, rowIndex, 2)
    const val2  = cellVal(sheet, rowIndex, 3)
    if (key && val) data[key] = val2 || val
  })
  return data
}

// ── Read Director Details sheet ───────────────────────────────────────────────
function readDirectorDetails(sheet) {
  const directors = []
  let headerFound = false
  sheet.eachRow((row, rowIndex) => {
    const cell1 = cellVal(sheet, rowIndex, 1)
    // Skip header row
    if (cell1 === 'Sr. No' || cell1 === 'S.No' || cell1 === '#') { headerFound = true; return }
    if (!headerFound) return
    const din         = cellVal(sheet, rowIndex, 2)
    const name        = cellVal(sheet, rowIndex, 3)
    const designation = cellVal(sheet, rowIndex, 4)
    const category    = cellVal(sheet, rowIndex, 5)
    const appointed   = cellVal(sheet, rowIndex, 6)
    const cessation   = cellVal(sheet, rowIndex, 7)
    if (name && din) {
      directors.push({ din, name, designation, category, appointed, cessation })
    }
  })
  return directors
}

// ════════════════════════════════════════════════════════════════════════════
// 3. READ PREVIOUS YEAR ANNUAL REPORT EXCEL (for memory context)
// ════════════════════════════════════════════════════════════════════════════
async function readPreviousYearReport(filePath) {
  // For PDF files, return null (Claude cannot read PDF in this service)
  // PDF handling is done by passing base64 to Claude directly
  if (filePath.endsWith('.pdf')) return null

  try {
    const financials = await readFinancialStatements(filePath)
    return financials
  } catch {
    return null
  }
}

module.exports = {
  readChecklistSheet,
  readFinancialStatements,
  readPreviousYearReport,
}
