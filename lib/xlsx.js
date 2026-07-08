/**
 * xlsx.js — 엑셀(.xlsx) 파일에서 "셀 삽입 이미지"와 "서비스 코드"를 추출한다.
 *
 * 파이썬 원본(Photo_Val.py)의 openpyxl + openpyxl_image_loader 역할을 브라우저에서 대체.
 *   · xlsx 는 실제로는 zip 파일이므로 JSZip 으로 풀어서 내부 XML 을 직접 파싱한다.
 *   · 각 시트에서 D열(=col index 3)에 앵커된 이미지와 E열(=col index 4)의 코드를 4행부터 읽는다.
 *
 * 반환 구조:
 *   [{ sheetName, rows: [{ row, code, imageDataUrl }] }, ...]
 *
 * 전제: 전역에 JSZip 이 로드되어 있어야 한다.
 */

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DATA_COL = 3;   // D열 (0-based) — 이미지
const CODE_COL = 4;   // E열 (0-based) — 서비스 코드
const START_ROW = 4;  // 4행부터 (Photo_Val.py 와 동일)

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

/** rels 파일을 { Id: Target } 맵으로 읽는다. */
async function readRels(zip, relsPath) {
  const f = zip.file(relsPath);
  const map = {};
  if (!f) return map;
  const doc = parseXml(await f.async('string'));
  for (const rel of doc.getElementsByTagName('Relationship')) {
    map[rel.getAttribute('Id')] = rel.getAttribute('Target');
  }
  return map;
}

/** base 경로(파일) 기준으로 상대 target 경로를 절대 zip 경로로 정규화한다. */
function resolvePath(baseFile, target) {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const baseDir = baseFile.split('/').slice(0, -1);
  const parts = target.split('/');
  for (const p of parts) {
    if (p === '..') baseDir.pop();
    else if (p !== '.') baseDir.push(p);
  }
  return baseDir.join('/');
}

/** sharedStrings.xml → 문자열 배열 */
async function readSharedStrings(zip) {
  const f = zip.file('xl/sharedStrings.xml');
  if (!f) return [];
  const doc = parseXml(await f.async('string'));
  return [...doc.getElementsByTagName('si')].map((si) => {
    // <si> 안의 모든 <t> 텍스트를 이어붙임 (rich text 대응)
    return [...si.getElementsByTagName('t')].map((t) => t.textContent).join('');
  });
}

/** "E4" → { col: 4, row: 4 } (row 는 1-based, col 은 0-based) */
function parseCellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) };
}

/** media 파일을 data URL 로 변환 */
async function mediaToDataUrl(zip, mediaPath) {
  const f = zip.file(mediaPath);
  if (!f) return null;
  const b64 = await f.async('base64');
  const ext = (mediaPath.split('.').pop() || 'png').toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/png';
  return `data:${mime};base64,${b64}`;
}

/**
 * 시트 하나에서 D열 이미지(행 → dataUrl) 맵을 만든다.
 * @param sheetPath 예: "xl/worksheets/sheet1.xml"
 */
async function readSheetImages(zip, sheetPath, sheetDoc) {
  const result = {}; // { rowNumber(1-based): dataUrl }
  const drawingEl = sheetDoc.getElementsByTagName('drawing')[0];
  if (!drawingEl) return result;

  const drawRid = drawingEl.getAttributeNS(NS_REL, 'id') || drawingEl.getAttribute('r:id');
  const sheetRels = await readRels(zip, resolvePath(sheetPath, '_rels/' + sheetPath.split('/').pop() + '.rels'));
  const drawingTarget = sheetRels[drawRid];
  if (!drawingTarget) return result;

  const drawingPath = resolvePath(sheetPath, drawingTarget);
  const drawFile = zip.file(drawingPath);
  if (!drawFile) return result;

  const drawDoc = parseXml(await drawFile.async('string'));
  const drawRels = await readRels(zip, resolvePath(drawingPath, '_rels/' + drawingPath.split('/').pop() + '.rels'));

  // twoCellAnchor / oneCellAnchor 모두 처리
  const anchors = [
    ...drawDoc.getElementsByTagName('xdr:twoCellAnchor'),
    ...drawDoc.getElementsByTagName('xdr:oneCellAnchor'),
    ...drawDoc.getElementsByTagName('twoCellAnchor'),
    ...drawDoc.getElementsByTagName('oneCellAnchor'),
  ];

  for (const anchor of anchors) {
    const from = anchor.getElementsByTagName('xdr:from')[0] || anchor.getElementsByTagName('from')[0];
    if (!from) continue;
    const colEl = from.getElementsByTagName('xdr:col')[0] || from.getElementsByTagName('col')[0];
    const rowEl = from.getElementsByTagName('xdr:row')[0] || from.getElementsByTagName('row')[0];
    if (!colEl || !rowEl) continue;
    const col = parseInt(colEl.textContent, 10);   // 0-based
    const row0 = parseInt(rowEl.textContent, 10);  // 0-based
    if (col !== DATA_COL) continue;                // D열만

    const blip = anchor.getElementsByTagName('a:blip')[0] || anchor.getElementsByTagName('blip')[0];
    if (!blip) continue;
    const embed = blip.getAttributeNS(NS_REL, 'embed') || blip.getAttribute('r:embed');
    const mediaTarget = drawRels[embed];
    if (!mediaTarget) continue;

    const mediaPath = resolvePath(drawingPath, mediaTarget);
    const dataUrl = await mediaToDataUrl(zip, mediaPath);
    if (dataUrl) result[row0 + 1] = dataUrl; // 1-based 행번호
  }
  return result;
}

/** 시트에서 E열 코드(행 → 문자열) 맵을 만든다. */
function readSheetCodes(sheetDoc, sharedStrings) {
  const codes = {}; // { rowNumber: string }
  for (const c of sheetDoc.getElementsByTagName('c')) {
    const ref = c.getAttribute('r');
    if (!ref) continue;
    const pos = parseCellRef(ref);
    if (!pos || pos.col !== CODE_COL) continue;

    const t = c.getAttribute('t');
    let value = '';
    if (t === 's') {
      const v = c.getElementsByTagName('v')[0];
      if (v) value = sharedStrings[parseInt(v.textContent, 10)] || '';
    } else if (t === 'inlineStr') {
      const is = c.getElementsByTagName('t')[0];
      value = is ? is.textContent : '';
    } else {
      const v = c.getElementsByTagName('v')[0];
      value = v ? v.textContent : '';
    }
    value = (value || '').toString().trim();
    if (value && value !== 'None') codes[pos.row] = value;
  }
  return codes;
}

/**
 * 메인 진입점. File 객체(.xlsx)를 받아 시트별 (코드+이미지) 쌍 목록을 반환.
 */
export async function parseWorkbook(file) {
  const zip = await JSZip.loadAsync(file);
  const sharedStrings = await readSharedStrings(zip);

  // 워크북에서 시트 이름 ↔ 파일 경로 매핑
  const wbDoc = parseXml(await zip.file('xl/workbook.xml').async('string'));
  const wbRels = await readRels(zip, 'xl/_rels/workbook.xml.rels');

  const sheets = [];
  for (const s of wbDoc.getElementsByTagName('sheet')) {
    const name = s.getAttribute('name');
    const rid = s.getAttributeNS(NS_REL, 'id') || s.getAttribute('r:id');
    const target = wbRels[rid];
    if (!target) continue;
    sheets.push({ name, path: resolvePath('xl/workbook.xml', target) });
  }

  const out = [];
  for (const sheet of sheets) {
    const sf = zip.file(sheet.path);
    if (!sf) continue;
    const sheetDoc = parseXml(await sf.async('string'));

    const codes = readSheetCodes(sheetDoc, sharedStrings);
    const images = await readSheetImages(zip, sheet.path, sheetDoc);

    // 코드가 존재하는 마지막 행 찾기 (Photo_Val.py 의 last_row 로직과 동일 취지)
    const codeRows = Object.keys(codes).map(Number);
    const lastRow = codeRows.length ? Math.max(...codeRows) : 0;

    const rows = [];
    for (let r = START_ROW; r <= lastRow; r++) {
      const code = codes[r];
      const imageDataUrl = images[r];
      if (code && imageDataUrl) {
        rows.push({ row: r, code, imageDataUrl });
      }
    }
    if (rows.length) out.push({ sheetName: sheet.name, rows });
  }
  return out;
}
