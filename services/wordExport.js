const htmlDocx = require('html-docx-js')
const fs        = require('fs')
const path      = require('path')

// ── Convert HTML report content to Word document ─────────────────────────────
// html-docx-js wraps the content in a full HTML document and converts to docx
async function exportToWord({ htmlContent, outputDir, filename }) {
  // Wrap content in full HTML with styles matching Annual Report formatting
  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    margin: 0;
    color: #000;
  }
  h1 {
    font-size: 13pt;
    font-weight: bold;
    text-align: center;
    margin-top: 20pt;
    margin-bottom: 6pt;
    text-transform: uppercase;
  }
  h2 {
    font-size: 11pt;
    font-weight: bold;
    margin-top: 14pt;
    margin-bottom: 4pt;
  }
  h3 {
    font-size: 10.5pt;
    font-weight: bold;
    margin-top: 10pt;
    margin-bottom: 3pt;
  }
  p {
    margin-bottom: 6pt;
    text-align: justify;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8pt;
    margin-bottom: 8pt;
    font-size: 10pt;
  }
  th {
    border: 1px solid #000;
    padding: 4pt 6pt;
    background-color: #f2f2f2;
    font-weight: bold;
  }
  td {
    border: 1px solid #000;
    padding: 3pt 6pt;
  }
  td[style*="text-align:right"], th[style*="text-align:right"] {
    text-align: right;
  }
  tr.total-row td {
    font-weight: bold;
    border-top: 2px solid #000;
  }
  ol, ul {
    margin-left: 20pt;
    margin-bottom: 6pt;
  }
  li {
    margin-bottom: 3pt;
  }
  hr {
    border: none;
    border-top: 1px solid #000;
    margin: 12pt 0;
  }
  strong { font-weight: bold; }
</style>
</head>
<body>
${htmlContent}
</body>
</html>`

  const buffer = htmlDocx.asBlob(fullHtml)

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  const filePath = path.join(outputDir, filename)

  // htmlDocx returns a Blob in browser, but in Node.js it returns a Buffer-like object
  // Convert to Buffer if needed
  let finalBuffer
  if (Buffer.isBuffer(buffer)) {
    finalBuffer = buffer
  } else if (buffer && typeof buffer.arrayBuffer === 'function') {
    finalBuffer = Buffer.from(await buffer.arrayBuffer())
  } else {
    // Last resort - treat as Buffer
    finalBuffer = Buffer.from(buffer)
  }

  fs.writeFileSync(filePath, finalBuffer)
  return filePath
}

module.exports = { exportToWord }
