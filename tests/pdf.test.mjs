import test from 'node:test';
import './pdca-groups.mjs';
import assert from 'node:assert/strict';
import { textWidth, fitText, wrapText, pdfDoc } from '../js/pdf.js';
import { buildReportPdf, reportFileName } from '../js/report-pdf.js';

const dec = bytes => Buffer.from(bytes).toString('latin1');

test('text measuring, truncating and wrapping', () => {
  assert.ok(textWidth('iii', 10) < textWidth('WWW', 10), 'narrow letters measure less than wide ones');
  assert.equal(Math.round(textWidth("Hello", 10) * 100) / 100, 22.78);
  assert.ok(textWidth('abc', 20) > textWidth('abc', 10));

  assert.equal(fitText('short', 100), 'short');
  const cut = fitText('BALMORAL ROAD SPORTS HUB - OVAL 1', 60, 9);
  assert.ok(cut.endsWith('…') && textWidth(cut, 9) <= 60, `"${cut}" fits with an ellipsis`);

  assert.deepEqual(wrapText('DEMO UMPIRE 6 (DAY 1)', 90, 9), ['DEMO UMPIRE 6', '(DAY 1)']);
  assert.deepEqual(wrapText('DEMO UMPIRE 6 (DAY 1)', 60, 9), ['DEMO', 'UMPIRE 6', '(DAY 1)']);
  assert.deepEqual(wrapText('', 60, 9), ['']);
  const three = wrapText('one two three four five six seven eight nine ten', 40, 9, false, 3);
  assert.equal(three.length, 3);
  assert.ok(three[2].endsWith('…'), 'the last allowed line is truncated rather than dropping words silently');
  assert.equal(wrapText('Supercalifragilistic', 20, 9)[0], 'Supercalifragilistic', 'a word longer than the column is kept, not lost');
});

test('a document is a valid PDF with one object per page', () => {
  const doc = pdfDoc({ title: 'T' });
  doc.page().text('Hello (world)\\ok', 40, 40);
  doc.page().line(10, 10, 100, 10);
  const s = dec(doc.bytes());
  assert.ok(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF'));
  assert.equal(doc.pageCount, 2);
  assert.equal((s.match(/\/Type \/Page[^s]/g) || []).length, 2);
  assert.match(s, /\/Count 2/);
  assert.match(s, /\(Hello \\\(world\\\)\\\\ok\)/, 'brackets and backslashes are escaped');
  assert.match(s, /startxref\n\d+/);
});

const game = (grade, home, away, ground, umps = ['A UMP'], days = ['2026-11-21']) => ({
  id: grade + home, grade, home: { name: home }, away: { name: away }, ground, slots: 1,
  days: days.map((date, i) => ({ date, day: i + 1 })),
  alloc: Object.fromEntries(days.map(d => [d, umps.map(n => ({ p: n, n }))])),
});

test('the allocation report lays out as a PDF, paging when it runs long', () => {
  const sections = [{ label: 'Round 2 Seniors', dates: ['2026-11-21'], games: [game('Senior A Grade', 'GLCC', 'KINGS LANGLEY', 'McCredie Park')] }];
  const doc = buildReportPdf({ heading: 'Senior · Round 2', dates: ['2026-11-21', '2026-11-28'], sections, generated: new Date('2026-11-16T00:00:00Z') });
  const s = dec(doc.bytes());
  assert.equal(doc.pageCount, 1);
  assert.match(s, /\(Senior \\267 Round 2\)/, 'the middle dot is written as a WinAnsi byte');
  for (const bit of ['Round 2 Seniors \\226 21 NOV', 'GLCC', 'KINGS LANGLEY', 'MCCREDIE PARK', 'A UMP', 'UMPIRES', 'Page 1 of 1', 'Generated 16 Nov 2026']) {
    assert.ok(s.includes(`(${bit})`), `the PDF contains ${bit}`);
  }

  const many = { label: 'Big round', dates: ['2026-11-21'], games: Array.from({ length: 60 }, (_, i) => game(`B${i}`, `HOME ${i}`, `AWAY ${i}`, 'A GROUND')) };
  const long = buildReportPdf({ heading: 'Senior', dates: [], sections: [many] });
  assert.ok(long.pageCount >= 2, 'a long round runs onto more pages');
  assert.ok(dec(long.bytes()).includes(`(Page ${long.pageCount} of ${long.pageCount})`));

  assert.equal(reportFileName('Senior · Round 2'), 'senior-round-2.pdf');
  assert.equal(reportFileName(''), 'umpire-allocations.pdf');
});

test('an unfilled slot shows as a dash, and two umpires on one game both appear', () => {
  const g = game('A', 'H', 'A', 'G', ['FIRST UMP', 'SECOND UMP']);
  g.slots = 2;
  const s = dec(buildReportPdf({ heading: 'R', sections: [{ label: 'S', dates: [], games: [g, game('B', 'H2', 'A2', 'G2', [null])] }] }).bytes());
  assert.ok(s.includes('(FIRST UMP & SECOND UMP)') || (s.includes('(FIRST UMP &)') && s.includes('(SECOND UMP)')));
  assert.match(s, /\\227/, 'the empty slot is an em dash');
});

test('a player umpire is named as one in the report', async () => {
  const { umpireText } = await import('../js/logic.js');
  const g = game('B9', 'KSS', 'WENTY', 'ERIC MOBBS', ['S Kandhaswami'], ['2026-11-21', '2026-11-28']);
  g.alloc['2026-11-21'][0].pu = true;
  g.alloc['2026-11-28'] = [null];
  assert.equal(umpireText(g), 'S KANDHASWAMI (PLAYER UMPIRE) (DAY 1) / \u2014 (DAY 2)');
});
