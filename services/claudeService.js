const Anthropic = require('@anthropic-ai/sdk')
const fs        = require('fs')
const path      = require('path')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ════════════════════════════════════════════════════════════════════════════
// BUILD FINANCIAL DATA SUMMARY STRING
// ════════════════════════════════════════════════════════════════════════════
function buildFinancialSummary(financialData) {
  if (!financialData) return 'Financial data not available.'

  const lines = []
  const unit  = financialData.balanceSheet?.unit ||
                financialData.profitAndLoss?.unit || 'as per uploaded Excel'

  lines.push(`ROUNDING UNIT: ${unit}`)
  lines.push(`NOTE: All figures below are already in the above unit as extracted from the Round off Excel.`)
  lines.push('')

  const formatSheet = (sheetData, title) => {
    if (!sheetData || !sheetData.rows.length) return
    lines.push(`=== ${title} ===`)
    for (const row of sheetData.rows) {
      if (row.isHeader) {
        lines.push(`\n[${row.label}]`)
      } else {
        const note = row.noteNo ? ` (Note ${row.noteNo})` : ''
        const curr = row.currentYear !== null ? row.currentYear : '-'
        const prev = row.previousYear !== null ? row.previousYear : '-'
        lines.push(`  ${row.label}${note} | Current: ${curr} | Previous: ${prev}`)
      }
    }
    lines.push('')
  }

  formatSheet(financialData.balanceSheet,  'BALANCE SHEET')
  formatSheet(financialData.profitAndLoss, 'PROFIT & LOSS')
  formatSheet(financialData.notes,         'NOTES TO ACCOUNTS')
  formatSheet(financialData.fixedAssets,   'FIXED ASSETS / PROPERTY PLANT & EQUIPMENT')

  return lines.join('\n')
}

// ── Build master data summary ─────────────────────────────────────────────────
function buildMasterDataSummary(masterData, directorDetails) {
  if (!masterData) return ''
  const lines = ['=== COMPANY MASTER DATA (from MasterData sheet) ===']
  for (const [k, v] of Object.entries(masterData)) {
    if (v && v !== '-' && v !== 'null') lines.push(`${k}: ${v}`)
  }
  if (directorDetails && directorDetails.length) {
    lines.push('\n=== DIRECTOR DETAILS ===')
    for (const d of directorDetails) {
      const cessation = d.cessation && d.cessation !== '-' ? ` | Ceased: ${d.cessation}` : ''
      lines.push(`${d.name} | DIN: ${d.din} | ${d.designation} | ${d.category} | Appointed: ${d.appointed}${cessation}`)
    }
  }
  return lines.join('\n')
}

// ── Build checklist summary ───────────────────────────────────────────────────
function buildChecklistSummary(answers) {
  if (!answers) return ''
  return `=== CHECKLIST ANSWERS ===
Company Type: ${answers.A1_companyType || 'Pvt Ltd'}
Filing Type: ${answers.A2_filingType || 'First Time Filing'}
Has Subsidiaries: ${answers.A3_hasSubsidiaries || 'No'}
Financial Year: ${answers.A4_financialYear || '2024-25'}
Rounding Unit: ${answers.A5_roundingUnit || 'Figures in Lakhs'}
Date of Balance Sheet: ${answers.A6_balanceSheetDate || '31/03/2025'}
AGM Date: ${answers.A7_agmDate || ''}
Number of Board Meetings: ${answers.A8_boardMeetingsCount || '4'}
Board Meeting Dates: ${answers.A9_boardMeetingDates || ''}

Director Change: ${answers.B1_directorChange || 'No'}
Director Change Details: ${answers.B2_directorChangeDetails || 'NA'}
Director Retiring by Rotation: ${answers.B3_directorRetiring || 'No'}
Retiring Director Details: ${answers.B4_retiringDirectorDetails || 'NA'}
Auditor Change: ${answers.B5_auditorChange || 'No'}

Share Transfer: ${answers.C1_shareTransfer || 'No'}
Share Transfer Details: ${answers.C2_shareTransferDetails || 'NA'}
New Shares Issued: ${answers.C3_newSharesIssued || 'No'}
NRI Shareholder: ${answers.C4_nriShareholder || 'No'}

Registered Office Change: ${answers.D1_officeChange || 'No'}
New Address: ${answers.D2_newAddress || 'NA'}
Object Clause Change: ${answers.D3_objectClauseChange || 'No'}
Loans/Charges Change: ${answers.D4_loansChargesChange || 'No'}
Cash Flow Applicable: ${answers.D5_cashFlowApplicable || 'No'}

Related Party Transactions: ${answers.E1_rptApplicable || 'No'}
Non Arm's Length Transactions: ${answers.E2_nonArmLengthCount || '0'}
Arm's Length Transactions: ${answers.E3_armLengthCount || '0'}

CARO Applicable: ${answers.F1_caroApplicable || 'No'}
OAVM Applicable: ${answers.F2_oavmApplicable || 'No'}
Significant Orders by Regulators: ${answers.F4_significantOrders || 'No'}
Material Changes after Balance Sheet: ${answers.F5_materialChanges || 'No'}`
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN GENERATION PROMPT
// ════════════════════════════════════════════════════════════════════════════
function buildGenerationPrompt({
  companyName,
  financialData,
  checklistAnswers,
  memory,
  mode, // 'full' or 'figures_only'
  existingContent, // for mode='figures_only'
}) {
  const isOPC         = (companyName || '').toUpperCase().includes('OPC') ||
                        (checklistAnswers?.A1_companyType || '').toUpperCase() === 'OPC'
  const isFirstTime   = (checklistAnswers?.A2_filingType || '').toLowerCase().includes('first')
  const cashFlow      = (checklistAnswers?.D5_cashFlowApplicable || '').toLowerCase() === 'yes'
  const caroApplicable= (checklistAnswers?.F1_caroApplicable || '').toLowerCase() === 'yes'
  const oavmApplicable= (checklistAnswers?.F2_oavmApplicable || '').toLowerCase() === 'yes'
  const rptApplicable = (checklistAnswers?.E1_rptApplicable || '').toLowerCase() === 'yes'
  const fy            = checklistAnswers?.A4_financialYear || '2024-25'
  const roundingUnit  = checklistAnswers?.A5_roundingUnit || financialData?.balanceSheet?.unit || 'Figures in Lakhs'
  const agmDate       = checklistAnswers?.A7_agmDate || ''
  const boardCount    = checklistAnswers?.A8_boardMeetingsCount || '4'
  const boardDates    = checklistAnswers?.A9_boardMeetingDates || ''
  const balanceSheetDate = checklistAnswers?.A6_balanceSheetDate || '31/03/2025'

  const financialSummary = buildFinancialSummary(financialData)
  const masterSummary    = buildMasterDataSummary(
    financialData?.masterData,
    financialData?.directorDetails
  )
  const checklistSummary = buildChecklistSummary(checklistAnswers)
  const memorySummary    = memory
    ? `\n=== PREVIOUS YEAR MEMORY (use for context and comparative references) ===\n${JSON.stringify(memory, null, 2)}`
    : ''

  if (mode === 'figures_only') {
    return `You are an expert Chartered Accountant and Annual Report drafter for Indian companies.

TASK: Update ONLY the financial figures and tables in the existing Annual Report below.
- Keep all narrative text, headings, and structure exactly as is
- Only update: Balance Sheet table, P&L table, Notes to Accounts tables, Fixed Assets table, financial figures mentioned in Directors Report narrative
- Do NOT change any words, sentences, or paragraphs that are not financial figures
- Apply rounding unit: ${roundingUnit}

EXISTING REPORT CONTENT TO UPDATE:
${existingContent}

NEW FINANCIAL DATA:
${financialSummary}

${checklistSummary}

OUTPUT: Return the complete updated report in the same HTML format. Do not add any explanation before or after the HTML.`
  }

  // Full generation prompt
  return `You are an expert Chartered Accountant and Annual Report drafter for Indian companies under Companies Act 2013.

TASK: Generate a complete, professional Annual Report for the company below. Output must be in HTML format suitable for a web editor.

COMPANY: ${companyName}
FINANCIAL YEAR: ${fy}
${masterSummary}

${checklistSummary}

${financialSummary}
${memorySummary}

GENERATION RULES:
1. All figures must use exactly ${roundingUnit} — use figures exactly as provided, do not recalculate
2. ${isFirstTime ? 'This is a FIRST TIME FILING — Previous year columns show NIL or 0 where no previous year data exists' : 'Include previous year comparative figures from the financial data provided'}
3. ${isOPC ? 'This is an OPC (One Person Company) — Apply OPC specific rules: minimum 2 board meetings per year (one per half year), nominee member details required, no requirement for remuneration ratio disclosure' : 'Standard Pvt Ltd rules apply'}
4. ${oavmApplicable ? 'INCLUDE OAVM provisions in AGM Notice — company has NRI/foreign shareholders' : 'Standard AGM Notice format — no OAVM provisions needed'}
5. ${caroApplicable ? 'INCLUDE CARO Report section at the end of the report' : 'Do NOT include CARO Report section'}
6. ${cashFlow ? 'INCLUDE Cash Flow Statement' : 'Do NOT include Cash Flow Statement (not applicable for this company)'}
7. ${rptApplicable ? 'INCLUDE AOC-2 annexure for Related Party Transactions in Directors Report' : 'No AOC-2 annexure needed'}
8. Do NOT include Auditors Report — leave a clearly marked placeholder: [AUDITORS REPORT TO BE INSERTED HERE]
9. AGM Date: ${agmDate} — use this exact date in Notice
10. Board Meetings: ${boardCount} meetings held on ${boardDates}
11. Balance Sheet date: ${balanceSheetDate}
12. Use formal, professional language consistent with Companies Act 2013 compliance

REPORT STRUCTURE — Generate in this exact order:
1. Notice of Annual General Meeting
2. Directors Report (with all applicable sub-sections)
3. Annexure I to Directors Report (if applicable)
4. Annexure II — AOC-2 (only if RPT applicable)
5. [AUDITORS REPORT PLACEHOLDER]
6. Balance Sheet (as at ${balanceSheetDate})
7. Profit and Loss Statement (for the year ended ${balanceSheetDate})
8. ${cashFlow ? 'Cash Flow Statement' : ''}
9. Notes to Accounts (all notes with complete details)
10. ${caroApplicable ? 'CARO Report' : ''}

HTML FORMAT RULES:
- Use <h1> for main section titles (e.g., "NOTICE OF ANNUAL GENERAL MEETING")
- Use <h2> for sub-sections (e.g., "1. FINANCIAL RESULTS")
- Use <h3> for sub-sub-sections
- Use <p> for paragraphs
- Use <table> with <thead><tbody> for all financial tables
- Table headers: <th style="text-align:left">Particulars</th> <th style="text-align:right">FY ${fy} (${roundingUnit})</th> ${isFirstTime ? '' : `<th style="text-align:right">Previous Year (${roundingUnit})</th>`}
- All financial figures in <td style="text-align:right">
- Total rows: <tr class="total-row">
- Use <hr> between major sections
- Use <strong> for important terms
- Use <ol> <li> for numbered items in AGM Notice
- DO NOT include any CSS, style tags, or HTML head/body tags — output body content only

OUTPUT: Start directly with the HTML content. No preamble, no explanation.`
}

// ════════════════════════════════════════════════════════════════════════════
// CALL CLAUDE API
// ════════════════════════════════════════════════════════════════════════════
async function generateReport({
  companyName,
  financialData,
  checklistAnswers,
  memory,
  mode = 'full',
  existingContent = null,
  prevReportFilePath = null,
}) {
  const prompt = buildGenerationPrompt({
    companyName,
    financialData,
    checklistAnswers,
    memory,
    mode,
    existingContent,
  })

  const messages = []

  // If previous year PDF is available, include it as a document
  if (prevReportFilePath && prevReportFilePath.endsWith('.pdf') && mode === 'full') {
    try {
      const pdfData = fs.readFileSync(prevReportFilePath)
      const base64  = pdfData.toString('base64')
      messages.push({
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          {
            type: 'text',
            text: `This is the previous year's Annual Report for reference. Use it to understand the company's narrative style, director composition, and any carry-forward context. Then complete this task:\n\n${prompt}`,
          },
        ],
      })
    } catch {
      // PDF read failed — proceed without it
      messages.push({ role: 'user', content: prompt })
    }
  } else {
    messages.push({ role: 'user', content: prompt })
  }

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 8000,
    messages,
  })

  const content = response.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type from Claude API')

  return content.text
}

// ════════════════════════════════════════════════════════════════════════════
// EXTRACT MEMORY FROM GENERATED REPORT
// Store key facts AI should remember for next year
// ════════════════════════════════════════════════════════════════════════════
async function extractMemory({ companyName, reportHtml, checklistAnswers, financialData }) {
  const prompt = `Extract key facts from this Annual Report for future reference. Return ONLY a JSON object with these fields:

{
  "companyName": "",
  "cin": "",
  "registeredAddress": "",
  "financialYear": "",
  "roundingUnit": "",
  "directors": [{"name":"","din":"","designation":""}],
  "auditorFirm": "",
  "auditorFRN": "",
  "shareCapital": {"authorised": 0, "paidUp": 0, "numberOfShares": 0, "faceValue": 0},
  "keyFigures": {
    "revenue": 0,
    "totalIncome": 0,
    "profitBeforeTax": 0,
    "profitAfterTax": 0,
    "totalAssets": 0,
    "netWorth": 0,
    "borrowings": 0
  },
  "accountingPolicies": "",
  "agmDate": "",
  "boardMeetingCount": 0,
  "filingType": "",
  "hasSubsidiaries": false,
  "caroApplicable": false,
  "cashFlowApplicable": false
}

Return ONLY the JSON object. No explanation.

Report content:
${reportHtml.substring(0, 6000)}

Checklist:
${JSON.stringify(checklistAnswers)}`

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    })

    const text = response.content[0].text.trim()
    // Strip any markdown fences if present
    const clean = text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim()
    return JSON.parse(clean)
  } catch {
    // Memory extraction failed — return basic info
    return {
      companyName,
      financialYear: checklistAnswers?.A4_financialYear || '',
      roundingUnit:  checklistAnswers?.A5_roundingUnit || '',
      filingType:    checklistAnswers?.A2_filingType || '',
    }
  }
}

module.exports = { generateReport, extractMemory }
