// Reading the first sheet of an Excel (.xlsx) file in the browser, with no library: an .xlsx is a zip of
// XML files. Returns rows of text cells, the heading row first, the same shape as a pasted sheet.
// Cells formatted as dates come back as 'YYYY-MM-DD'; numbers as written.

const td = new TextDecoder();

async function unzip(buf) {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file.');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = td.decode(new Uint8Array(buf, p + 46, nameLen));
    files[name] = { method, size, start: local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async name => {
    const f = files[name];
    if (!f) return null;
    const raw = new Uint8Array(buf, f.start, f.size);
    if (f.method === 0) return td.decode(raw);
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return td.decode(await new Response(stream).arrayBuffer());
  };
}

const xml = s => new DOMParser().parseFromString(s, 'application/xml');
const all = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

// Excel counts days from 30 Dec 1899.
export function excelDate(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(Number(serial) * 86400000));
  return d.toISOString().slice(0, 10);
}

export async function readXlsx(arrayBuffer) {
  const get = await unzip(arrayBuffer);
  const wb = xml(await get('xl/workbook.xml') || '');
  const first = all(wb, 'sheet')[0];
  let path = 'xl/worksheets/sheet1.xml';
  if (first) {
    const rid = first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rel = all(xml(await get('xl/_rels/workbook.xml.rels') || '<x/>'), 'Relationship').find(r => r.getAttribute('Id') === rid);
    if (rel) { const t = rel.getAttribute('Target'); path = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''); }
  }
  const sheet = await get(path);
  if (!sheet) throw new Error('The workbook has no sheet to read.');
  const shared = all(xml(await get('xl/sharedStrings.xml') || '<sst/>'), 'si').map(si => all(si, 't').map(t => t.textContent).join(''));
  // Which cell styles are dates.
  const styles = xml(await get('xl/styles.xml') || '<styleSheet/>');
  const custom = Object.fromEntries(all(styles, 'numFmt').map(f => [f.getAttribute('numFmtId'), f.getAttribute('formatCode') || '']));
  const xfs = all(styles, 'cellXfs')[0];
  const dateStyle = (xfs ? all(xfs, 'xf') : []).map(xf => {
    const id = Number(xf.getAttribute('numFmtId') || 0);
    return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (custom[id] !== undefined && /[dmy]/i.test(custom[id].replace(/\[[^\]]*\]|"[^"]*"/g, '')));
  });
  const rows = [];
  for (const r of all(xml(sheet), 'row')) {
    const row = [];
    for (const c of all(r, 'c')) {
      const t = c.getAttribute('t'), vEl = all(c, 'v')[0];
      let val = '';
      if (t === 's') val = vEl ? shared[Number(vEl.textContent)] || '' : '';
      else if (t === 'inlineStr') val = all(c, 't').map(x => x.textContent).join('');
      else if (t === 'b') val = vEl && vEl.textContent === '1' ? 'TRUE' : 'FALSE';
      else if (vEl) val = dateStyle[Number(c.getAttribute('s') || 0)] && t !== 'str' ? excelDate(vEl.textContent) : vEl.textContent;
      const ref = c.getAttribute('r');
      row[ref ? colIndex(ref) : row.length] = val;
    }
    rows.push(Array.from(row, x => x || ''));
  }
  const width = Math.max(0, ...rows.map(r => r.length));
  return rows.map(r => { while (r.length < width) r.push(''); return r; }).filter(r => r.some(c => String(c).trim() !== ''));
}
