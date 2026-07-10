/**
 * xlsx-writer.js — 원본 엑셀(.xlsx)을 브라우저에서 직접 수정한다.
 *
 *  · 매칭 실패한 행: 지정 열(기본 A)에 "매칭 실패" 기입 + 빨간 배경
 *
 * xlsx 는 zip 이므로 JSZip 으로 열어 내부 XML(sheet/styles)을 고쳐서
 * 원본 서식·수식·기존 이미지를 그대로 보존한 채 다시 포장한다.
 * 전제: 전역 JSZip.
 */

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function parseXml(text) { return new DOMParser().parseFromString(text, 'application/xml'); }
function serialize(doc) {
  // XMLSerializer 는 XML 선언을 생략하므로 엑셀 호환을 위해 다시 붙인다
  const s = new XMLSerializer().serializeToString(doc);
  return s.startsWith('<?xml') ? s : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + s;
}

async function readRels(zip, relsPath) {
  const f = zip.file(relsPath);
  const map = {};
  if (!f) return map;
  const doc = parseXml(await f.async('string'));
  for (const rel of doc.getElementsByTagName('Relationship')) map[rel.getAttribute('Id')] = rel.getAttribute('Target');
  return map;
}
function resolvePath(baseFile, target) {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const dir = baseFile.split('/').slice(0, -1);
  for (const p of target.split('/')) { if (p === '..') dir.pop(); else if (p !== '.') dir.push(p); }
  return dir.join('/');
}

/** 열 문자("A","H"…) → 0-based 인덱스 */
function colLetterToIndex(letter) {
  let col = 0;
  for (const ch of String(letter).toUpperCase()) { if (ch >= 'A' && ch <= 'Z') col = col * 26 + (ch.charCodeAt(0) - 64); }
  return col - 1;
}
/** "AB12" → 0-based 열 인덱스 */
function refToColIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  return m ? colLetterToIndex(m[1]) : -1;
}

/** styles.xml 에 빨간 배경 fill + cellXf 를 추가하고 새 스타일 인덱스를 반환 */
async function addRedStyle(zip) {
  const path = 'xl/styles.xml';
  let xml = await zip.file(path).async('string');

  // 1) fills 에 빨간 solid fill 추가
  const fillsM = xml.match(/<fills count="(\d+)">/);
  const fillCount = parseInt(fillsM[1], 10);
  xml = xml.replace(fillsM[0], `<fills count="${fillCount + 1}">`);
  xml = xml.replace('</fills>', '<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor indexed="64"/></patternFill></fill></fills>');

  // 2) cellXfs 에 해당 fill 을 쓰는 xf 추가
  const xfsM = xml.match(/<cellXfs count="(\d+)">/);
  const xfCount = parseInt(xfsM[1], 10);
  xml = xml.replace(xfsM[0], `<cellXfs count="${xfCount + 1}">`);
  xml = xml.replace('</cellXfs>', `<xf numFmtId="0" fontId="0" fillId="${fillCount}" borderId="0" xfId="0" applyFill="1"/></cellXfs>`);

  zip.file(path, xml);
  return xfCount; // 새 cellXf 인덱스
}

/**
 * 시트 XML 의 특정 행 지정 열에 "매칭 실패"(빨간 스타일) 기입.
 * 셀은 행 내에서 열 순서를 지켜 삽입한다 (엑셀 규격).
 */
function markFailRows(sheetDoc, rows, styleIdx, colLetter) {
  const ns = sheetDoc.documentElement.namespaceURI;
  const colIdx = colLetterToIndex(colLetter);
  const rowEls = {};
  for (const r of sheetDoc.getElementsByTagName('row')) rowEls[r.getAttribute('r')] = r;

  for (const rowNum of rows) {
    const rowEl = rowEls[String(rowNum)];
    if (!rowEl) continue;
    const ref = colLetter.toUpperCase() + rowNum;

    // 기존 동일 셀 제거
    const cells = [...rowEl.getElementsByTagName('c')];
    for (const c of cells) { if (c.getAttribute('r') === ref) { c.remove(); break; } }

    const c = sheetDoc.createElementNS(ns, 'c');
    c.setAttribute('r', ref);
    c.setAttribute('t', 'inlineStr');
    c.setAttribute('s', String(styleIdx));
    const is = sheetDoc.createElementNS(ns, 'is');
    const t = sheetDoc.createElementNS(ns, 't');
    t.textContent = '매칭 실패';
    is.appendChild(t);
    c.appendChild(is);

    // 열 순서 유지: 자기보다 큰 열의 첫 셀 앞에 삽입, 없으면 맨 뒤
    let before = null;
    for (const x of rowEl.getElementsByTagName('c')) {
      if (refToColIndex(x.getAttribute('r')) > colIdx) { before = x; break; }
    }
    rowEl.insertBefore(c, before);
  }
}

/**
 * 메인 진입점 — 원본 엑셀 File 을 수정해 Blob(.xlsx)으로 반환.
 * @param {File} file 원본 엑셀
 * @param {Object} edits {
 *   failRows: { [sheetName]: number[] },  // "매칭 실패" 표시할 행
 *   failCol:  string ("A" 등, 기본 "A")   // 표시할 열
 * }
 * @returns {Promise<{blob: Blob, fails: number}>}
 */
export async function buildModifiedWorkbook(file, edits) {
  const zip = await JSZip.loadAsync(file);
  const failCol = (edits.failCol || 'A').toUpperCase();

  // 시트 이름 → 경로
  const wbDoc = parseXml(await zip.file('xl/workbook.xml').async('string'));
  const wbRels = await readRels(zip, 'xl/_rels/workbook.xml.rels');
  const sheets = {};
  for (const s of wbDoc.getElementsByTagName('sheet')) {
    const rid = s.getAttributeNS(NS_REL, 'id') || s.getAttribute('r:id');
    if (wbRels[rid]) sheets[s.getAttribute('name')] = resolvePath('xl/workbook.xml', wbRels[rid]);
  }

  // 빨간 스타일 준비 (실패 행이 하나라도 있을 때만)
  const hasFails = Object.values(edits.failRows || {}).some((a) => a && a.length);
  const styleIdx = hasFails ? await addRedStyle(zip) : 0;

  let fails = 0;
  for (const [sheetName, sheetPath] of Object.entries(sheets)) {
    const failRows = (edits.failRows || {})[sheetName] || [];
    if (!failRows.length) continue;

    const sf = zip.file(sheetPath);
    if (!sf) continue;
    const sheetDoc = parseXml(await sf.async('string'));
    markFailRows(sheetDoc, failRows, styleIdx, failCol);
    fails += failRows.length;
    zip.file(sheetPath, serialize(sheetDoc));
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
  });
  return { blob, fails };
}
