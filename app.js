/**
 * app.js — AS 부품 이미지 자동 매칭 스튜디오 (프런트 오케스트레이터)
 *
 * 전체 흐름 (Photo_Val.py 의 웹 재현):
 *   1) 엑셀 + 원본 사진 업로드
 *   2) opencv.js(SIFT/ORB) 로 자동 매칭 → 카드 보드에서 확인/수정
 *   3) @imgly AI 로 배경 제거 → 흰 배경 합성 → {코드}.png ZIP 다운로드
 */

import { parseWorkbook } from './lib/xlsx.js?v=15';
import {
  computeFeatures, computeFeaturesAllRotations, releaseFeatures, releaseFeatureList,
  matchBestRotation, getDetectorName, MIN_INLIER_COUNT,
} from './lib/matcher.js?v=15';
import { loadEmbedder, embed, cosine, getDevice } from './lib/embedder.js?v=15';
import { buildModifiedWorkbook } from './lib/xlsx-writer.js?v=15';

/* ========== 상태 ========== */
const state = {
  excelFiles: [],   // {file, name}
  photos: [],       // {name, dataUrl, features|null, emb|null}
  pairs: [],        // 매칭 대상
  results: [],      // {folder, name, dataUrl}
  threshold: MIN_INLIER_COUNT, // ORB inlier 기준
  aiThreshold: 0.83,           // AI 코사인 유사도 기준
  useOrb: false,               // ORB 정밀 검증 사용 여부 (기본 끔 = 가볍고 안 멈춤)
  imgCol: 'D',                 // 이미지 열
  codeCol: 'E',                // 코드 열
  startRow: 4,                 // 시작 행
  failCol: 'A',                // 수정 엑셀에서 "매칭 실패"를 기입할 열
  cvReady: false,
  aiReady: false,      // CLIP 임베딩 모델 준비 여부
  bgRemover: null,     // @imgly removeBackground 함수 (지연 로딩)
  bgModelReady: false, // 배경제거 모델(가중치) 다운로드 완료 여부
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

/* ========== 로딩 오버레이 (모델 다운로드 등 % 표시) ========== */
function showOverlay(title, sub) {
  $('#overlay-title').textContent = title;
  if (sub != null) $('#overlay-sub').textContent = sub;
  setOverlay(0);
  $('#overlay').classList.remove('hidden');
}
function setOverlay(pct, sub) {
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  $('#overlay-bar').style.width = pct + '%';
  $('#overlay-pct').textContent = pct + '%';
  if (sub != null) $('#overlay-sub').textContent = sub;
}
function hideOverlay() { $('#overlay').classList.add('hidden'); }

/** 여러 파일 다운로드 진행을 loaded/total 합산으로 %(0~100) 계산하는 트래커 */
function makeProgress() {
  const files = {};
  const pct = () => {
    let l = 0, t = 0;
    for (const k in files) { l += files[k].loaded; t += files[k].total; }
    return t > 0 ? (l / t) * 100 : 0;
  };
  return {
    hf(p) { // transformers.js progress_callback
      if (p && p.file && typeof p.total === 'number' && p.total > 0) {
        files[p.file] = { loaded: p.loaded || 0, total: p.total };
      }
      return pct();
    },
    imgly(key, current, total) { // @imgly progress 콜백
      if (total > 0) files[key] = { loaded: current || 0, total };
      return pct();
    },
    pct,
  };
}

/* ========== 매칭 진행바 ========== */
function setMatchProgress(ratio, label) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  $('#match-bar').style.width = pct + '%';
  $('#match-label').textContent = label;
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
setChip('#chip-ai', 'AI 매칭 (매칭 시작 시 로딩)', '');

/* ========== AI 매칭(CLIP) 모델 준비 ========== */
async function ensureEmbedder() {
  if (state.aiReady) return true;
  setChip('#chip-ai', 'AI 매칭 모델 다운로드 중…', '');
  showOverlay('AI 매칭 모델 다운로드 중…', 'CLIP 이미지 인식 모델 (최초 1회, 수십 MB)');
  log('▶ AI 매칭 모델(CLIP) 로딩 중… (최초 1회, 수십 MB 다운로드)', 'warn');
  const prog = makeProgress();
  try {
    await loadEmbedder((p) => {
      const pct = prog.hf(p);
      setOverlay(pct, p && p.file ? `${p.file} 내려받는 중…` : '모델 준비 중…');
      const c = Math.floor(pct);
      if (c % 10 === 0) setChip('#chip-ai', `AI 매칭 모델 ${c}%`, '');
    });
    // 워밍업: 첫 추론(특히 WebGPU 셰이더 컴파일)의 큰 지연을 로딩 화면에서 미리 소화 → 매칭 중 멈춤 방지
    setOverlay(100, '엔진 워밍업 중…');
    try {
      const c = el('canvas'); c.width = 32; c.height = 32;
      const cx = c.getContext('2d'); cx.fillStyle = '#ccc'; cx.fillRect(0, 0, 32, 32);
      await embed(c.toDataURL('image/png'));
    } catch (e) { /* 무시 */ }
    state.aiReady = true;
    setChip('#chip-ai', 'AI 매칭 준비됨 (' + getDevice() + ')', 'ready');
    log('✔ AI 매칭 모델 준비 완료 (CLIP · ' + getDevice() + ')', 'ok');
    hideOverlay();
    return true;
  } catch (e) {
    hideOverlay();
    setChip('#chip-ai', 'AI 매칭 로드 실패 (ORB만 사용)', 'error');
    log('✖ AI 매칭 모델 로드 실패, ORB 특징점만 사용: ' + e.message, 'bad');
    return false;
  }
}

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

/** 표시용 작은 썸네일 dataURL 생성 (원본은 그대로 두고 화면 메모리만 절약) */
function makeThumb(dataUrl, max = 240) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const s = Math.min(1, max / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      const c = el('canvas'); c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(img, 0, 0, cw, ch);
      try { res(c.toDataURL('image/jpeg', 0.8)); } catch (e) { res(dataUrl); }
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}

/* ========== 업로드: 사진 ========== */
function addPhotoFiles(files) {
  const imgExt = /\.(png|jpe?g|webp)$/i;
  for (const f of files) {
    if (!imgExt.test(f.name)) continue;
    if (state.photos.some((p) => p.name === f.name)) continue;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const thumb = await makeThumb(dataUrl, 240);
      state.photos.push({ name: f.name, dataUrl, thumb, features: null, emb: null });
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
    t.appendChild(el('img')).src = p.thumb || p.dataUrl;
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
  $('#ai-threshold-label').textContent = Math.round(state.aiThreshold * 100);
  setMatchProgress(0, '매칭 준비 중…');
  log('━━━━━━━━━━ 자동 매칭 시작 ━━━━━━━━━━', 'dim');

  // 0) AI 매칭 모델 준비 (실패해도 ORB 로 진행)
  await ensureEmbedder();
  // ORB 정밀 검증은 옵션(기본 끔). AI 가 없으면 어쩔 수 없이 ORB 사용.
  const useOrbNow = state.useOrb || !state.aiReady;
  log(useOrbNow ? '  · ORB 정밀 검증: 사용' : '  · ORB 정밀 검증: 꺼짐 (AI 전용, 가벼움)', 'dim');

  // 1) 원본 사진 분석: AI 임베딩(워커) + (옵션) ORB 특징점
  log(`▶ [1단계] 원본 사진 ${state.photos.length}장 분석 중…`);
  for (let i = 0; i < state.photos.length; i++) {
    const p = state.photos[i];
    if (useOrbNow && !p.features) p.features = await computeFeatures(p.dataUrl);
    if (state.aiReady && !p.emb) { try { p.emb = await embed(p.dataUrl); } catch (e) {} }
    setMatchProgress(0.15 * ((i + 1) / state.photos.length), `[1/3] 원본 사진 분석 ${i + 1}/${state.photos.length}`);
    await tick();
  }
  log(`  → 분석 완료: ${state.photos.length}장`, 'ok');

  // 2) 엑셀 파싱 → 매칭 대상 생성
  setMatchProgress(0.18, '[2/3] 엑셀 분석 중…');
  const opts = { imgCol: state.imgCol, codeCol: state.codeCol, startRow: state.startRow };
  state.pairs = [];
  let idc = 0;
  for (const ex of state.excelFiles) {
    log(`▶ [2단계] 엑셀 처리: ${ex.name} (이미지 ${state.imgCol}열 · 코드 ${state.codeCol}열 · ${state.startRow}행~)`);
    let sheets;
    try {
      sheets = await parseWorkbook(ex.file, opts);
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
  log(`▶ [3단계] 매칭 계산 (${state.pairs.length}건) — ${useOrbNow ? 'AI 유사도 + ORB 검증' : 'AI 전용(빠름)'}`);
  await matchAllPairs(useOrbNow);
  updateMatchStats();
  updateUnmatched();
  sortCards(); // 성공 매칭을 상단으로
  setMatchProgress(1, `매칭 완료 — 총 ${state.pairs.length}건`);
  log('━━━━━━━━━━ 매칭 완료 ━━━━━━━━━━', 'dim');
  $('#btn-reorb').classList.toggle('hidden', useOrbNow); // 이미 ORB 썼으면 재분석 버튼 숨김
}

/** 한 건(pair) 매칭 계산. AI 임베딩은 pair.qEmb 에 캐시해 재분석 시 재사용. */
async function matchOnePair(pair, useOrbNow) {
  let scored;
  if (state.aiReady) {
    if (!pair.qEmb) { try { pair.qEmb = await embed(pair.imageDataUrl); } catch (e) {} await tick(); }
    const qEmb = pair.qEmb;
    scored = state.photos.map((p, idx) => ({ idx, ai: (qEmb && p.emb) ? cosine(qEmb, p.emb) : 0, score: -1, deg: 0 }));
    scored.sort((a, b) => b.ai - a.ai);
    if (useOrbNow && scored.length && scored[0].ai >= 0.5) {
      const qRot = await computeFeaturesAllRotations(pair.imageDataUrl);
      await tick();
      const r = matchBestRotation(state.photos[scored[0].idx].features, qRot);
      scored[0].score = r.score; scored[0].deg = r.deg;
      releaseFeatureList(qRot);
    }
  } else {
    // AI 미사용(폴백): 전체 ORB 매칭
    const qRot = await computeFeaturesAllRotations(pair.imageDataUrl);
    scored = state.photos.map((p, idx) => { const r = matchBestRotation(p.features, qRot); return { idx, score: r.score, deg: r.deg, ai: null }; });
    releaseFeatureList(qRot);
    scored.sort((a, b) => b.score - a.score);
  }
  pair.candidates = scored;
  applyTop(pair, scored[0]);
}

/** 전체 매칭 루프 + 카드 갱신 + 진행바 */
async function matchAllPairs(useOrbNow) {
  const N = state.pairs.length;
  for (let pi = 0; pi < N; pi++) {
    const pair = state.pairs[pi];
    await matchOnePair(pair, useOrbNow);
    const rot = pair.matchDeg ? ` ${pair.matchDeg}°` : '';
    const aiTxt = pair.matchAi != null ? `AI ${(pair.matchAi * 100).toFixed(0)}%` : '';
    const orbTxt = pair.maxScore >= 0 ? ` · ORB ${pair.maxScore}점${rot}` : '';
    log(`  [${pair.code}] ${aiTxt}${orbTxt} ${pair.auto ? '✔' : '(기준 미달)'}`, pair.auto ? 'ok' : 'warn');
    renderCard(pair);
    setMatchProgress(0.2 + 0.8 * ((pi + 1) / N), `[3/3] 매칭 계산 ${pi + 1}/${N} (${Math.round((pi + 1) / N * 100)}%)`);
    await tick();
  }
}

/** 성공 매칭을 상단으로 정렬 (그룹 내에서는 원래 행 순서 유지) */
function sortCards() {
  const grid = $('#cardgrid');
  if (!grid) return;
  const rank = (p) => (p.excluded ? 2 : (p.auto ? 0 : 1)); // 성공 → 수동확정 → 제외
  const ordered = state.pairs
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i);
  for (const { p } of ordered) {
    const c = document.getElementById('card-' + p.id);
    if (c) grid.appendChild(c); // 순서대로 재배치
  }
}

/** ORB 정밀 재분석 — 다운로드/파싱 없이 ORB 검증만 다시 (쿼리 임베딩은 캐시 재사용) */
async function reanalyzeWithOrb() {
  if (!state.pairs.length) return;
  $('#btn-reorb').disabled = true;
  log('━━━━━━━━━━ ORB 정밀 재분석 ━━━━━━━━━━', 'dim');
  setMatchProgress(0.05, 'ORB 특징점 준비 중…');
  // 사진 ORB 특징점 준비 (AI 전용 모드였다면 아직 없음)
  for (const p of state.photos) { if (!p.features) p.features = await computeFeatures(p.dataUrl); await tick(); }
  await matchAllPairs(true);
  updateMatchStats();
  updateUnmatched();
  sortCards();
  setMatchProgress(1, 'ORB 정밀 재분석 완료');
  log('✔ ORB 정밀 재분석 완료', 'ok');
  $('#btn-reorb').disabled = false;
  $('#btn-reorb').classList.add('hidden');
}

/** 후보 하나를 대표 매칭으로 반영 + 성공/제외 판정 */
function applyTop(pair, top) {
  top = top || { idx: -1, score: -1, deg: 0, ai: null };
  pair.selectedPhotoIdx = top.idx;
  pair.maxScore = top.score;
  pair.matchDeg = top.deg;
  pair.matchAi = top.ai;
  // 성공 기준: AI 유사도 통과 또는 ORB inlier 통과 (둘 중 하나만 강해도 인정)
  const aiOk = top.ai != null && top.ai >= state.aiThreshold;
  const orbOk = top.score >= state.threshold;
  pair.auto = pair.selectedPhotoIdx >= 0 && (aiOk || orbOk);
  pair.excluded = !pair.auto;
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
      <div class="mimg ${photo ? '' : 'empty'}">${photo ? `<img src="${photo.thumb || photo.dataUrl}" loading="lazy">` : '없음'}</div>
    </div>
    <div class="mcard-foot">
      <span class="score">${pair.matchAi != null ? `AI <b>${(pair.matchAi * 100).toFixed(0)}%</b>` : ''}${pair.maxScore >= 0 ? `${pair.matchAi != null ? ' · ' : ''}ORB <b>${pair.maxScore}</b>${pair.matchDeg ? ` · ${pair.matchDeg}°` : ''}` : ''}</span>
      ${status}
      <button class="link-btn" data-act="pick">후보 변경</button>
    </div>`;

  if (!card) {
    card = el('div', 'mcard');
    card.id = 'card-' + pair.id;
    $('#cardgrid').appendChild(card);
  }
  card.classList.toggle('excluded', pair.excluded);
  card.innerHTML = html;

  card.querySelector('[data-act="pick"]').onclick = () => openCandModal(pair);
}

/* ========== 후보 선택 큰 팝업 ========== */
function openCandModal(pair) {
  $('#cand-code').textContent = pair.code;
  $('#cand-meta').textContent = `${pair.folder} · ${pair.sheet} · 행 ${pair.row}`;
  $('#cand-target-img').src = pair.imageDataUrl;

  const grid = $('#cand-grid');
  grid.innerHTML = '';

  const choose = (fn) => { fn(); renderCard(pair); updateMatchStats(); updateUnmatched(); sortCards(); closeCandModal(); };

  // "제외(매칭 없음)" 옵션
  const none = el('div', 'candL none' + (pair.excluded || pair.selectedPhotoIdx < 0 ? ' sel' : ''));
  none.innerHTML = '<div class="candL-x">제외<br><small>매칭 없음</small></div>';
  none.onclick = () => choose(() => { pair.excluded = true; pair.selectedPhotoIdx = -1; pair.matchAi = null; pair.maxScore = -1; });
  grid.appendChild(none);

  (pair.candidates || []).forEach((c) => {
    const p = state.photos[c.idx];
    const sel = c.idx === pair.selectedPhotoIdx && !pair.excluded;
    const cand = el('div', 'candL' + (sel ? ' sel' : ''));
    const aiTxt = c.ai != null ? `AI ${(c.ai * 100).toFixed(0)}%` : '';
    const orbTxt = c.score >= 0 ? `${aiTxt ? ' · ' : ''}ORB ${c.score}` : '';
    const degTxt = c.deg ? ` · ${c.deg}°` : '';
    cand.innerHTML = `<img src="${p.dataUrl}"><div class="candL-cap">${aiTxt}${orbTxt}${degTxt}</div><div class="candL-name">${p.name}</div>`;
    cand.onclick = () => choose(() => { applyTop(pair, c); pair.excluded = false; });
    grid.appendChild(cand);
  });

  $('#modal-cand').classList.remove('hidden');
}
function closeCandModal() { $('#modal-cand').classList.add('hidden'); }

function updateMatchStats() {
  const total = state.pairs.length;
  const included = state.pairs.filter((p) => !p.excluded && p.selectedPhotoIdx >= 0).length;
  const excluded = total - included;
  $('#match-stats').innerHTML = `
    <div class="stat"><b>${total}</b><span>전체</span></div>
    <div class="stat ok"><b>${included}</b><span>확정</span></div>
    <div class="stat bad"><b>${excluded}</b><span>제외</span></div>`;
}

/* ========== 미매칭(제외) 부품 코드 요약 ========== */
function unmatchedPairs() {
  return state.pairs.filter((p) => p.excluded || p.selectedPhotoIdx < 0);
}
function updateUnmatched() {
  const list = unmatchedPairs();
  $('#unmatched-count').textContent = list.length;
  const lines = list.map((p) => [p.code, p.folder, p.sheet, p.row].join('\t'));
  $('#unmatched-text').value = lines.join('\n');
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
$('#btn-reorb').onclick = reanalyzeWithOrb;

/* ========== 후보 팝업 / 미매칭 목록 버튼 ========== */
$('#cand-close').onclick = closeCandModal;
$('#modal-cand').onclick = (e) => { if (e.target.id === 'modal-cand') closeCandModal(); };

$('#btn-copy-unmatched').onclick = async () => {
  const text = $('#unmatched-text').value;
  const ta = $('#unmatched-text');
  try {
    await navigator.clipboard.writeText(text);
    log('✔ 미매칭 코드 복사됨 (' + unmatchedPairs().length + '개)', 'ok');
  } catch (e) {
    ta.focus(); ta.select(); document.execCommand('copy'); // 폴백
    log('✔ 미매칭 코드 복사됨', 'ok');
  }
};

$('#btn-csv-unmatched').onclick = () => {
  const rows = [['서비스코드', '엑셀파일', '시트', '행'], ...unmatchedPairs().map((p) => [p.code, p.folder, p.sheet, p.row])];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM → 엑셀 한글 깨짐 방지
  saveAs(blob, '미매칭_부품코드.csv');
  log('✔ 미매칭 코드 CSV 다운로드', 'ok');
};

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

/** 투명 배경 이미지를 흰 배경 위에 합성 → jpg dataURL (최종 저장 형식) */
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
  return canvas.toDataURL('image/jpeg', 0.92);
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
    const label = `${t.folder}/${t.code}.jpg`;
    setProgress(i / targets.length, `처리 중 (${i + 1}/${targets.length}) — ${label}`);

    let jpgDataUrl = photo.dataUrl;
    try {
      if (useBg && state.bgRemover) {
        const cfg = { output: { format: 'image/png' } }; // 배경제거는 투명 png 로 받고
        if (!state.bgModelReady) {
          const prog = makeProgress();
          showOverlay('AI 배경제거 모델 다운로드 중…', 'ISNet 배경제거 모델 (최초 1회, 수십 MB)');
          cfg.progress = (key, cur, tot) => setOverlay(prog.imgly(key, cur, tot), '' + key);
        }
        const cut = await state.bgRemover(photo.dataUrl, cfg);
        if (!state.bgModelReady) { state.bgModelReady = true; hideOverlay(); setChip('#chip-ai', 'AI 배경제거 준비됨', 'ready'); }
        jpgDataUrl = await compositeWhite(cut); // 흰 배경 합성 후 jpg 로 저장
      } else {
        jpgDataUrl = await compositeWhite(photo.dataUrl);
      }
      log(`  ✔ ${label}`, 'ok');
    } catch (e) {
      hideOverlay();
      log(`  ✖ ${label} 처리 실패: ${e.message}`, 'bad');
      jpgDataUrl = await compositeWhite(photo.dataUrl);
    }

    state.results.push({ folder: t.folder, name: t.code + '.jpg', dataUrl: jpgDataUrl });
    addResultCard(t.code, await makeThumb(jpgDataUrl, 200)); // 표시는 썸네일, ZIP 은 원본
    await tick();
  }

  setProgress(1, `완료 — ${state.results.length}개 생성됨`);
  $('#btn-zip').classList.remove('hidden');
  $('#btn-xlsx').classList.remove('hidden');
  $('#btn-run-export').disabled = false;
  log('━━━━━━━━━━ 내보내기 완료 ━━━━━━━━━━', 'dim');
}

function setProgress(ratio, label) {
  $('#export-bar').style.width = Math.round(ratio * 100) + '%';
  $('#export-label').textContent = label;
}
function addResultCard(code, dataUrl) {
  const c = el('div', 'rcard', `<div class="ri"><img src="${dataUrl}"></div><div class="rn">${code}.jpg</div>`);
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

/* ========== 수정된 엑셀 다운로드 (지정 열에 "매칭 실패" 표시) ========== */
$('#btn-xlsx').onclick = async () => {
  const btn = $('#btn-xlsx');
  btn.disabled = true;
  log(`▶ 수정 엑셀 생성 중… (${state.failCol}열에 매칭 실패 표시)`);
  try {
    for (const ex of state.excelFiles) {
      const folder = ex.name.replace(/\.xlsx$/i, '');
      const mine = state.pairs.filter((p) => p.folder === folder);
      if (!mine.length) continue;

      // 시트별 실패 행 수집
      const failRows = {};
      for (const p of mine) {
        if (p.excluded || p.selectedPhotoIdx < 0) {
          (failRows[p.sheet] = failRows[p.sheet] || []).push(p.row);
        }
      }

      const { blob, fails } = await buildModifiedWorkbook(ex.file, { failRows, failCol: state.failCol });
      saveAs(blob, folder + '_수정.xlsx');
      log(`  ✔ ${folder}_수정.xlsx — ${state.failCol}열 매칭 실패 표시 ${fails}건`, 'ok');
    }
    log('✔ 수정 엑셀 다운로드 완료', 'ok');
  } catch (e) {
    log('✖ 수정 엑셀 생성 실패: ' + e.message, 'bad');
  }
  btn.disabled = false;
};

/* ========== 설정 모달 ========== */
$('#btn-settings').onclick = () => {
  // 현재 값을 입력창에 반영
  $('#cfg-imgcol').value = state.imgCol;
  $('#cfg-codecol').value = state.codeCol;
  $('#cfg-startrow').value = state.startRow;
  $('#cfg-failcol').value = state.failCol;
  $('#cfg-aithreshold').value = Math.round(state.aiThreshold * 100);
  $('#cfg-threshold').value = state.threshold;
  $('#cfg-useorb').checked = state.useOrb;
  $('#modal-settings').classList.remove('hidden');
};
$('#btn-close-settings').onclick = () => {
  const colRe = /^[A-Za-z]{1,3}$/;
  const ic = $('#cfg-imgcol').value.trim().toUpperCase();
  const cc = $('#cfg-codecol').value.trim().toUpperCase();
  if (colRe.test(ic)) state.imgCol = ic;
  if (colRe.test(cc)) state.codeCol = cc;
  const fc = $('#cfg-failcol').value.trim().toUpperCase();
  if (colRe.test(fc)) state.failCol = fc;
  const sr = parseInt($('#cfg-startrow').value, 10);
  if (sr > 0) state.startRow = sr;
  const ai = parseInt($('#cfg-aithreshold').value, 10);
  if (ai > 0 && ai < 100) state.aiThreshold = ai / 100;
  const v = parseInt($('#cfg-threshold').value, 10);
  if (v > 0) state.threshold = v;
  state.useOrb = $('#cfg-useorb').checked;

  // 안내 라벨 갱신
  $('#hint-imgcol').textContent = state.imgCol;
  $('#hint-codecol').textContent = state.codeCol;
  $('#hint-startrow').textContent = state.startRow;
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
