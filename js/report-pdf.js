// Lays the allocation report out as a PDF the officer can save and attach to an email.
// Same content as the report on screen: one table per section, grade / teams / ground / umpires.

import { pdfDoc, downloadPdf, LANDSCAPE_A4, fitText, wrapText } from './pdf.js';
import { gradeShort, umpireText, fmtRange } from './logic.js';

const M = 36;                                        // page margin
const COLS = [
  { head: 'GRADE', w: 70, get: g => gradeShort(g.grade), lines: 2 },
  { head: 'HOME TEAM', w: 165, get: g => g.home.name.toUpperCase(), lines: 2 },
  { head: 'AWAY TEAM', w: 165, get: g => g.away.name.toUpperCase(), lines: 2 },
  { head: 'GROUND', w: 160, get: g => (g.ground || '').toUpperCase(), lines: 2 },
  { head: 'UMPIRES', w: 209, get: g => umpireText(g), lines: 3 },
];
const BODY = 9, HEAD = 8, LINE = 11.5, PAD = 5;

export function buildReportPdf({ heading, dates = [], sections = [], generated = new Date() }) {
  const doc = pdfDoc({ size: LANDSCAPE_A4, title: heading });
  const right = doc.width - M;
  const bottom = doc.height - M - 18;
  let y = 0;

  const header = () => {
    doc.page();
    doc.text(heading, M, M + 14, { size: 15, bold: true });
    const when = fmtRange(dates);
    if (when) doc.text(when, right - 200, M + 14, { size: 10, grey: 0.35 });
    doc.line(M, M + 22, right, M + 22, { width: 1, grey: 0.6 });
    y = M + 46;
  };
  const columnHeads = () => {
    let x = M;
    for (const c of COLS) { doc.text(c.head, x, y, { size: HEAD, bold: true, grey: 0.4 }); x += c.w; }
    y += 6;
    doc.line(M, y, right, y, { width: 0.7, grey: 0.6 });
    y += PAD + BODY;
  };

  header();
  for (const [i, s] of sections.entries()) {
    if (i > 0) y += 14;
    if (y > bottom - 60) header();                    // never leave a heading alone at the foot of a page
    doc.text(`${s.label}${s.dates && s.dates.length ? ` – ${fmtRange(s.dates)}` : ''}`, M, y, { size: 12, bold: true });
    y += 12;
    columnHeads();

    for (const g of s.games) {
      const cells = COLS.map(c => wrapText(c.get(g), c.w - 8, BODY, false, c.lines));
      const rows = Math.max(...cells.map(l => l.length));
      if (y + (rows - 1) * LINE > bottom) { header(); columnHeads(); }
      let x = M;
      cells.forEach((lines, ci) => {
        lines.forEach((ln, li) => doc.text(fitText(ln, COLS[ci].w - 8, BODY), x, y + li * LINE, { size: BODY }));
        x += COLS[ci].w;
      });
      y += (rows - 1) * LINE + LINE + PAD;
      doc.line(M, y - LINE + 3, right, y - LINE + 3, { width: 0.4, grey: 0.85 });
    }
  }

  const stamp = `Generated ${generated.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  for (let i = 0; i < doc.pageCount; i++) {
    doc.select(i);
    doc.text(stamp, M, doc.height - M + 4, { size: 8, grey: 0.45 });
    doc.text(`Page ${i + 1} of ${doc.pageCount}`, right - 60, doc.height - M + 4, { size: 8, grey: 0.45 });
  }
  return doc;
}

export const reportFileName = heading =>
  `${(heading || 'umpire-allocations').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}.pdf`;

export function saveReportPdf(opts) {
  downloadPdf(buildReportPdf(opts), reportFileName(opts.heading));
}
