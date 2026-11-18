// A very small PDF writer — enough for the allocation report: Helvetica text, rules, and pages.
// Written by hand so the report downloads as a real file with no extra library and no network.
//
//   const doc = pdfDoc({ size: LANDSCAPE_A4 });
//   doc.page(); doc.text('Hello', 40, 40, { size: 14, bold: true }); download(doc, 'report.pdf');
//
// Coordinates are in points (72 per inch) measured from the TOP-LEFT of the page.

export const LANDSCAPE_A4 = [841.89, 595.28];
export const PORTRAIT_A4 = [595.28, 841.89];

// Character widths (1/1000 of the font size) for the two built-in fonts we use.
const ASCII_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const ASCII_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// The few non-ASCII characters the app actually produces, as WinAnsi byte + width.
const EXTRA = {
  '–': [0x96, 556, 556], '—': [0x97, 1000, 1000], '‘': [0x91, 222, 278], '’': [0x92, 222, 278],
  '“': [0x93, 333, 500], '”': [0x94, 333, 500], '•': [0x95, 350, 350], '·': [0xb7, 278, 278],
  '…': [0x85, 1000, 1000], ' ': [0x20, 278, 278],
};

const charWidth = (ch, bold) => {
  const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return (bold ? ASCII_BOLD : ASCII_REG)[c - 32];
  if (EXTRA[ch]) return EXTRA[ch][bold ? 2 : 1];
  if (c >= 161 && c <= 255) return bold ? 556 : 500;
  return bold ? 556 : 500;
};

// Width of a string at a given font size, in points.
export function textWidth(str, size = 10, bold = false) {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch, bold);
  return (w * size) / 1000;
}

// Shorten a string with an ellipsis so it fits.
export function fitText(str, maxWidth, size = 10, bold = false) {
  const s = String(str == null ? '' : str);
  if (textWidth(s, size, bold) <= maxWidth) return s;
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch + '…', size, bold) > maxWidth) break;
    out += ch;
  }
  return out.replace(/[\s,]+$/, '') + '…';
}

// Split a string into lines that each fit, breaking at spaces. Anything past `maxLines`
// is crammed into the last line and truncated, so nothing is silently dropped.
export function wrapText(str, maxWidth, size = 10, bold = false, maxLines = 3) {
  const words = String(str == null ? '' : str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (!line || textWidth(next, size, bold) <= maxWidth) { line = next; continue; }
    if (lines.length === maxLines - 1) return [...lines, fitText([line, ...words.slice(i)].join(' '), maxWidth, size, bold)];
    lines.push(line);
    line = words[i];
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// Text in a PDF string: escape the three special characters and turn the handful of
// non-ASCII characters we use into their WinAnsi bytes.
const esc = str => [...String(str == null ? '' : str)].map(ch => {
  if (ch === '\\' || ch === '(' || ch === ')') return '\\' + ch;
  const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return ch;
  if (EXTRA[ch]) return '\\' + EXTRA[ch][0].toString(8).padStart(3, '0');
  if (c >= 161 && c <= 255) return '\\' + c.toString(8).padStart(3, '0');
  return '?';
}).join('');

const n2 = v => (Math.round(v * 100) / 100).toString();

export function pdfDoc({ size = LANDSCAPE_A4, title = '' } = {}) {
  const [W, H] = size;
  const pages = [];
  let ops = null;
  const api = {
    width: W,
    height: H,
    get pageCount() { return pages.length; },
    page() { ops = []; pages.push(ops); return api; },
    select(i) { ops = pages[i]; return api; },          // go back to a finished page (to add a footer)
    // x, y are from the top-left; y is the text baseline.
    text(str, x, y, { size: fs = 10, bold = false, grey = 0 } = {}) {
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${n2(fs)} Tf ${n2(grey)} g ${n2(x)} ${n2(H - y)} Td (${esc(str)}) Tj ET`);
      return api;
    },
    line(x1, y1, x2, y2, { width = 0.5, grey = 0.75 } = {}) {
      ops.push(`${n2(grey)} G ${n2(width)} w ${n2(x1)} ${n2(H - y1)} m ${n2(x2)} ${n2(H - y2)} l S`);
      return api;
    },
    bytes() { return build(pages, size, title); },
    blob() { return new Blob([api.bytes()], { type: 'application/pdf' }); },
  };
  return api;
}

function build(pages, [W, H], title) {
  const objs = [];                                   // objs[i] is object number i + 1
  const add = body => { objs.push(body); return objs.length; };
  const kidsNo = 2;                                  // the Pages object, filled in below
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');                                           // placeholder for Pages
  const fontReg = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageNos = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const contents = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageNos.push(add(`<< /Type /Page /Parent ${kidsNo} 0 R /MediaBox [0 0 ${n2(W)} ${n2(H)}] `
      + `/Resources << /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contents} 0 R >>`));
  }
  objs[kidsNo - 1] = `<< /Type /Pages /Count ${pageNos.length} /Kids [${pageNos.map(n => `${n} 0 R`).join(' ')}] >>`;
  const info = add(`<< /Title (${esc(title)}) /Producer (Third Umpire) >>`);

  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

// Hand the finished file to the browser as a download.
export function downloadPdf(doc, filename) {
  const url = URL.createObjectURL(doc.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
