/**
 * app.js — AS 부품 이미지 자동 매칭 스튜디오 (프런트 오케스트레이터)
 *
 * 전체 흐름 (Photo_Val.py 의 웹 재현):
 *   1) 엑셀 + 원본 사진 업로드
 *   2) opencv.js(SIFT/ORB) 로 자동 매칭 → 카드 보드에서 확인/수정
 *   3) @imgly AI 로 배경 제거 → 흰 배경 합성 → {코드}.png ZIP 다운로드
 */

import { parseWorkbook } from './lib/xlsx.js';
import {
  computeFeatures, computeFeaturesAllRotations, releaseFeatures, releaseFeatureList,
  matchBestRotation, getDetectorName, MIN_INLIER_COUNT,
} from './lib/matcher.js';

/* ========== 상태 ========== */
const state = {
  excelFiles: [],   // {file, name}
  photos: [],       // {name, dataUrl, features|null}
  pairs: [],        // 매칭 대상 (아래 buildPairs 참고)
  results: [],      // {folder, name, dataUrl}
  threshold: MIN_INLIER_COUNT,
  cvReady: false,
  bgRemover: null,  // @imgly removeBackground 함수 (지연 로딩)
};

/* ========== 짧은 DOM 헬퍼 ========== */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

/* ========== 콘솔 로그 ========== */
function log(msg, type = 'info') {
  const body = $('#console-body');
  const line = el('div', 'l-' + type, msg);
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

/* ========== 엔진 상태 칩 ========== */
function setChip(id, text, cls) {
  const chip = $(id);
  chip.classList.remove('ready', 'error');
  if (cls) chip.classList.add(cls);
  chip.lastChild.textContent = ' ' + text;
}

/* ========== opencv.js(WASM) 준비 — @techstark/opencv-js 를 ESM 으로 로드 ========== */
const OPENCV_CDN = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/+esm';
async function loadOpenCv() {
  setChip('#chip-cv', '매칭 엔진 로딩…(~9MB)', '');
  log('▶ 매칭 엔진(OpenCV WASM) 다운로드 중…', 'dim');
  try {
    const mod = await import(OPENCV_CDN);
    const cvm = mod.default || mod;
    window.cv = cvm;
    // WASM 런타임 초기화 대기
    await new Promise((res) => {
      if (cvm.Mat) return res();
      cvm.onRuntimeInitialized = res;
    });
    state.cvReady = true;
    const name = getDetectorName();
    setChip('#chip-cv', '매칭 엔진: ' + name, 'ready');
    log('✔ 매칭 엔진 준비 완료 (' + name + ')', 'ok');
    refreshStartButton();
  } catch (e) {
    setChip('#chip-cv', '매칭 엔진 로드 실패', 'error');
    log('✖ 매칭 엔진 로드 실패: ' + e.message, 'bad');
  }
}
loadOpenCv();
setChip('#chip-ai', 'AI 배경제거 (처음 사용 시 로딩)', '');

/* ========== 업로드: 엑셀 ========== */
function addExcelFiles(files) {
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith('.xlsx') || f.name.startsWith('~$')) continue;
    if (state.excelFiles.some((x) => x.name === f.name)) continue;
    state.excelFiles.push({ file: f, name: f.name });
  }
  renderExcelList();
}
function renderExcelList() {
  const ul = $('#list-excel');
  ul.innerHTML = '';
  state.excelFiles.forEach((x, i) => {
    const li = el('li', null, `<span class="name">📄 ${x.name}</span>`);
    const rm = el('button', 'rm', '✕');
    rm.onclick = () => { state.excelFiles.splice(i, 1); renderExcelList(); updateCounts(); };
    li.appendChild(rm);
    ul.appendChild(li);
  });
  updateCounts();
}

/* ========== 업로드: 사진 ========== */
function addPhotoFiles(files) {
  const imgExt = /\.(png|jpe?g|webp)$/i;
  for (const f of files) {
    if (!imgExt.test(f.name)) continue;
    if (state.photos.some((p) => p.name === f.name)) continue;
    const reader = new FileReader();
    reader.onload = () => {
      state.photos.push({ name: f.name, dataUrl: reader.result, features: null });
      renderPhotoList();
    };
    reader.readAsDataURL(f);
  }
}
function renderPhotoList() {
  const box = $('#list-photo');
  box.innerHTML = '';
  state.photos.forEach((p, i) => {
    const t = el('div', 't');
    t.appendChild(el('img')).src = p.dataUrl;
    const rm = el('button', 'rm', '✕');
    rm.onclick = () => { state.photos.splice(i, 1); renderPhotoList(); };
    t.appendChild(rm);
    box.appendChild(t);
  });
  updateCounts();
}

function updateCounts() {
  $('#upload-counts').textContent = `엑셀 ${state.excelFiles.length}개 · 사진 ${state.photos.length}장`;
  refreshStartButton();
}
function refreshStartButton() {
  $('#btn-start').disabled = !(state.cvReady && state.excelFiles.length && state.photos.length);
}

/* ========== 드롭존 배선 ========== */
function wireDrop(zoneId, inputId, handler) {
  const zone = $(zoneId), input = $(inputId);
  input.onchange = () => { handler(input.files); input.value = ''; };
  ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => handler(e.dataTransfer.files));
}
wireDrop('#dz-excel', '#in-excel', addExcelFiles);
wireDrop('#dz-photo', '#in-photo', addPhotoFiles);

/* ========== STEP 전환 ========== */
function goStep(n) {
  $('#panel-upload').classList.toggle('hidden', n !== 1);
  $('#panel-match').classList.toggle('hidden', n !== 2);
  $('#panel-export').classList.toggle('hidden', n !== 3);
  document.querySelectorAll('.step').forEach((s) => {
    const step = +s.dataset.step;
    s.classList.toggle('active', step === n);
    s.classList.toggle('done', step < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ========== 매칭 실행 ========== */
$('#btn-start').onclick = runMatching;

async function runMatching() {
  goStep(2);
  $('#cardgrid').innerHTML = '';
  $('#threshold-label').textContent = state.threshold;
  log('━━━━━━━━━━ 자동 매칭 시작 ━━━━━━━━━━', 'dim');

  // 1) 원본 사진 특징점 계산 (0/90/180/270 회전본 모두)
  log(`▶ [1단계] 원본 사진 ${state.photos.length}장 특징점 분석 중… (0·90·180·270° 회전 포함)`);
  for (const p of state.photos) {
    if (!p.features) p.features = await computeFeaturesAllRotations(p.dataUrl);
    await tick();
  }
  log(`  → 분석 완료: ${state.photos.length}장 × 4방향`, 'ok');

  // 2) 엑셀 파싱 → 매칭 대상 생성
  state.pairs = [];
  let idc = 0;
  for (const ex of state.excelFiles) {
    log(`▶ [2단계] 엑셀 처리: ${ex.name}`);
    let sheets;
    try {
      sheets = await parseWorkbook(ex.file);
    } catch (e) {
      log(`  ✖ 엑셀 읽기 실패: ${e.message}`, 'bad');
      continue;
    }
    const folder = ex.name.replace(/\.xlsx$/i, '');
    for (const sh of sheets) {
      log(`  시트 [${sh.sheetName}] — 부품 ${sh.rows.length}건`);
      for (const r of sh.rows) {
        state.pairs.push({
          id: 'p' + (idc++), folder, sheet: sh.sheetName, row: r.row,
          code: r.code, imageDataUrl: r.imageDataUrl,
          candidates: [], selectedPhotoIdx: -1, maxScore: -1, excluded: false,
        });
      }
    }
  }

  if (!state.pairs.length) {
    log('  ✖ 처리할 (이미지+코드) 항목이 없습니다. D열 이미지 / E열 코드 / 4행 시작을 확인하세요.', 'bad');
    return;
  }

  // 3) 각 엑셀 이미지 → 전체 사진과 매칭
  log(`▶ [3단계] 매칭 계산 (${state.pairs.length}건, 회전 매칭)…`);
  for (const pair of state.pairs) {
    const f = await computeFeatures(pair.imageDataUrl);
    // 각 사진을 0/90/180/270 돌려가며 가장 잘 맞는 각도의 점수를 취함
    const scored = state.photos.map((p, idx) => {
      const r = matchBestRotation(f, p.features);
      return { idx, score: r.score, deg: r.deg };
    });
    releaseFeatures(f);
    scored.sort((a, b) => b.score - a.score);
    pair.candidates = scored;
    const top = scored[0] || { idx: -1, score: -1, deg: 0 };
    pair.maxScore = top.score;
    pair.matchDeg = top.deg;
    pair.selectedPhotoIdx = top.idx;
    pair.auto = pair.maxScore >= state.threshold;
    // 기준 미달이면 기본은 "제외"로 두되 후보는 유지 (사용자가 수동 확정 가능)
    pair.excluded = !pair.auto;

    const st = pair.auto ? 'ok' : 'warn';
    const rot = top.deg ? ` (${top.deg}° 회전)` : '';
    log(`  [${pair.folder}/${pair.sheet} 행${pair.row}] ${pair.code} → ${pair.maxScore}점${rot} ${pair.auto ? '✔' : '(기준 미달)'}`, st);
    renderCard(pair);
    await tick();
  }
  updateMatchStats();
  log('━━━━━━━━━━ 매칭 완료 ━━━━━━━━━━', 'dim');
}

/* ========== 매칭 카드 렌더 ========== */
function renderCard(pair) {
  let card = document.getElementById('card-' + pair.id);
  const photo = pair.selectedPhotoIdx >= 0 ? state.photos[pair.selectedPhotoIdx] : null;
  const status = pair.excluded
    ? '<span class="badge bad">제외</span>'
    : (pair.auto ? '<span class="badge ok">성공</span>' : '<span class="badge warn">수동 확정</span>');

  const html = `
    <div class="mcard-top">
      <span class="mcard-code">${pair.code}</span>
      <span class="mcard-meta">${pair.folder} · ${pair.sheet} · 행 ${pair.row}</span>
    </div>
    <div class="mcard-body">
      <div class="mimg"><img src="${pair.imageDataUrl}" alt=""></div>
      <div class="arrow">➜</div>
      <div class="mimg ${photo ? '' : 'empty'}">${photo ? `<img src="${photo.dataUrl}">` : '없음'}</div>
    </div>
    <div class="mcard-foot">
      <span class="score">유사도 <b>${pair.maxScore < 0 ? 0 : pair.maxScore}</b>점${pair.matchDeg ? ` · <b>${pair.matchDeg}°</b> 회전` : ''}</span>
      ${status}
      <button class="link-btn" data-act="toggle-cand">후보 변경</button>
    </div>
    <div class="candidates hidden">
      <div class="cand-title">후보 사진 (유사도 높은 순) — 클릭해서 확정</div>
      <div class="cand-row"></div>
    </div>`;

  if (!card) {
    card = el('div', 'mcard');
    card.id = 'card-' + pair.id;
    $('#cardgrid').appendChild(card);
  }
  card.classList.toggle('excluded', pair.excluded);
  card.innerHTML = html;

  card.querySelector('[data-act="toggle-cand"]').onclick = () => {
    const drawer = card.querySelector('.candidates');
    drawer.classList.toggle('hidden');
    if (!drawer.dataset.filled) { fillCandidates(pair, drawer.querySelector('.cand-row')); drawer.dataset.filled = '1'; }
  };
}

function fillCandidates(pair, row) {
  // "매칭 없음" 옵션
  const none = el('div', 'cand none' + (pair.selectedPhotoIdx < 0 || pair.excluded ? ' sel' : ''), '제외');
  none.onclick = () => { pair.excluded = true; pair.selectedPhotoIdx = -1; renderCard(pair); updateMatchStats(); };
  row.appendChild(none);

  pair.candidates.forEach((c) => {
    const p = state.photos[c.idx];
    const cand = el('div', 'cand' + (c.idx === pair.selectedPhotoIdx && !pair.excluded ? ' sel' : ''));
    cand.innerHTML = `<img src="${p.dataUrl}"><small>${c.score}점${c.deg ? ` · ${c.deg}°` : ''}</small>`;
    cand.onclick = () => {
      pair.selectedPhotoIdx = c.idx;
      pair.maxScore = c.score;
      pair.matchDeg = c.deg || 0;
      pair.excluded = false;
      pair.auto = c.score >= state.threshold;
      renderCard(pair);
      updateMatchStats();
    };
    row.appendChild(cand);
  });
}

function updateMatchStats() {
  const total = state.pairs.length;
  const included = state.pairs.filter((p) => !p.excluded && p.selectedPhotoIdx >= 0).length;
  const excluded = total - included;
  $('#match-stats').innerHTML = `
    <div class="stat"><b>${total}</b><span>전체</span></div>
    <div class="stat ok"><b>${included}</b><span>확정</span></div>
    <div class="stat bad"><b>${excluded}</b><span>제외</span></div>`;
}

/* ========== 내보내기 (배경 제거 + 흰 배경 + zip) ========== */
$('#btn-export').onclick = () => {
  goStep(3);
  $('#resultgrid').innerHTML = '';
  $('#btn-zip').classList.add('hidden');
  $('#export-bar').style.width = '0%';
  $('#export-label').textContent = '"처리 시작"을 누르면 시작합니다.';
};
$('#btn-back').onclick = () => goStep(1);
$('#btn-back2').onclick = () => goStep(2);
$('#btn-run-export').onclick = runExport;

async function ensureBgRemover() {
  if (state.bgRemover) return state.bgRemover;
  setChip('#chip-ai', 'AI 모델 다운로드 중…', '');
  log('▶ AI 배경 제거 모델 로딩 중… (최초 1회, 수십 MB 다운로드)', 'warn');
  const mod = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1/+esm');
  state.bgRemover = mod.removeBackground;
  setChip('#chip-ai', 'AI 배경제거 준비됨', 'ready');
  log('✔ AI 배경 제거 모델 준비 완료', 'ok');
  return state.bgRemover;
}

/** 투명 배경 이미지를 흰 배경 위에 합성 → png dataURL */
async function compositeWhite(blobOrDataUrl) {
  const url = blobOrDataUrl instanceof Blob ? URL.createObjectURL(blobOrDataUrl) : blobOrDataUrl;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const canvas = el('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  if (blobOrDataUrl instanceof Blob) URL.revokeObjectURL(url);
  return canvas.toDataURL('image/png');
}

async function runExport() {
  const targets = state.pairs.filter((p) => !p.excluded && p.selectedPhotoIdx >= 0);
  if (!targets.length) { alert('내보낼 확정 항목이 없습니다.'); return; }

  const useBg = $('#use-bg').checked;
  $('#btn-run-export').disabled = true;
  state.results = [];
  $('#resultgrid').innerHTML = '';

  if (useBg) { try { await ensureBgRemover(); } catch (e) { log('✖ AI 모델 로드 실패, 배경 제거 없이 진행: ' + e.message, 'bad'); } }

  log('━━━━━━━━━━ 내보내기 시작 (' + targets.length + '건) ━━━━━━━━━━', 'dim');
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const photo = state.photos[t.selectedPhotoIdx];
    const label = `${t.folder}/${t.code}.png`;
    setProgress(i / targets.length, `처리 중 (${i + 1}/${targets.length}) — ${label}`);

    let pngDataUrl = photo.dataUrl;
    try {
      if (useBg && state.bgRemover) {
        const cut = await state.bgRemover(photo.dataUrl, { output: { format: 'image/png' } });
        pngDataUrl = await compositeWhite(cut);
      } else {
        pngDataUrl = await compositeWhite(photo.dataUrl);
      }
      log(`  ✔ ${label}`, 'ok');
    } catch (e) {
      log(`  ✖ ${label} 처리 실패: ${e.message}`, 'bad');
      pngDataUrl = await compositeWhite(photo.dataUrl);
    }

    state.results.push({ folder: t.folder, name: t.code + '.png', dataUrl: pngDataUrl });
    addResultCard(t.code, pngDataUrl);
    await tick();
  }

  setProgress(1, `완료 — ${state.results.length}개 생성됨`);
  $('#btn-zip').classList.remove('hidden');
  $('#btn-run-export').disabled = false;
  log('━━━━━━━━━━ 내보내기 완료 ━━━━━━━━━━', 'dim');
}

function setProgress(ratio, label) {
  $('#export-bar').style.width = Math.round(ratio * 100) + '%';
  $('#export-label').textContent = label;
}
function addResultCard(code, dataUrl) {
  const c = el('div', 'rcard', `<div class="ri"><img src="${dataUrl}"></div><div class="rn">${code}.png</div>`);
  $('#resultgrid').appendChild(c);
}

/* ========== ZIP 다운로드 ========== */
$('#btn-zip').onclick = async () => {
  const zip = new JSZip();
  for (const r of state.results) {
    const b64 = r.dataUrl.split(',')[1];
    zip.folder(r.folder).file(r.name, b64, { base64: true });
  }
  log('▶ ZIP 생성 중…');
  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, 'AS부품_이미지_결과물.zip');
  log('✔ ZIP 다운로드 완료', 'ok');
};

/* ========== 설정 모달 ========== */
$('#btn-settings').onclick = () => $('#modal-settings').classList.remove('hidden');
$('#btn-close-settings').onclick = () => {
  const v = parseInt($('#cfg-threshold').value, 10);
  if (v > 0) state.threshold = v;
  $('#modal-settings').classList.add('hidden');
};

/* ========== 기타 ========== */
$('#btn-clearlog').onclick = () => { $('#console-body').innerHTML = ''; };
$('#only-success').onchange = (e) => {
  if (e.target.checked) state.pairs.forEach((p) => { if (!p.auto) { p.excluded = true; renderCard(p); } });
  updateMatchStats();
};

/** UI 가 갱신될 틈을 주는 마이크로 양보 */
function tick() { return new Promise((r) => setTimeout(r, 0)); }

log('부품 이미지 자동 매칭 스튜디오에 오신 것을 환영합니다.', 'ok');
log('엑셀과 원본 사진을 업로드한 뒤 [자동 매칭 시작]을 누르세요.', 'dim');
