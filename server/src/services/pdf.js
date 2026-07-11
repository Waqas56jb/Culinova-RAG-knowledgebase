const pdf = require("pdf-parse");

/**
 * Extract text from a PDF buffer, page by page (order preserved).
 * Returns { pages: string[], numpages, info }.
 */
async function extractPages(buffer) {
  const pages = [];

  function renderPage(pageData) {
    return pageData
      .getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
      .then((tc) => {
        let text = "";
        let lastY;
        for (const item of tc.items) {
          if (lastY === undefined || lastY === item.transform[5]) {
            text += item.str;
          } else {
            text += "\n" + item.str;
          }
          lastY = item.transform[5];
        }
        pages.push(text.trim());
        return text;
      });
  }

  const data = await pdf(buffer, { pagerender: renderPage });
  return { pages, numpages: data.numpages || pages.length, info: data.info || {} };
}

/**
 * Build a single page-tagged string for the LLM, capped to maxChars.
 */
function buildTaggedText(pages, maxChars = 60000) {
  let out = "";
  for (let i = 0; i < pages.length; i++) {
    const block = `\n=== PAGE ${i + 1} ===\n${pages[i]}\n`;
    if (out.length + block.length > maxChars) {
      out += `\n[... truncated at page ${i + 1} due to length ...]\n`;
      break;
    }
    out += block;
  }
  return out.trim();
}

module.exports = { extractPages, buildTaggedText };
