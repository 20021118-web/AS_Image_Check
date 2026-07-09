/**
 * embedder.js — CLIP 이미지 임베딩 매칭의 메인 스레드 측 프록시.
 *
 * 실제 추론은 embed-worker.js(Web Worker)에서 돌아 메인 스레드(화면)를 막지 않는다.
 * ORB(국소 특징점)와 달리 저해상도·저텍스처·조명 차이에 강한 "의미 유사도"를 제공.
 */

let _worker = null;
let _loading = null;
let _device = 'wasm';
let _reqId = 0;
const _pending = new Map();

export function getDevice() { return _device; }
export function isEmbedderReady() { return !!_worker && !_loading; }

function ensureWorker() {
  if (_worker) return _worker;
  // embedder.js 기준 상대경로로 워커 로드 (module worker → CDN import 가능)
  const url = new URL('./embed-worker.js?v=11', import.meta.url);
  _worker = new Worker(url, { type: 'module' });
  _worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'result') {
      const res = _pending.get(msg.id);
      if (res) { _pending.delete(msg.id); res(msg.emb ? Float32Array.from(msg.emb) : null); }
    }
  };
  return _worker;
}

/**
 * 모델 로드(최초 1회, 수십 MB 다운로드). onProgress 로 진행 상황 전달.
 */
export function loadEmbedder(onProgress) {
  if (_worker && !_loading) return Promise.resolve();
  if (_loading) return _loading;
  const w = ensureWorker();
  _loading = new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') { if (onProgress) onProgress(msg.p); }
      else if (msg.type === 'loaded') {
        _device = msg.device || 'wasm';
        w.removeEventListener('message', onMsg);
        _loading = null;
        resolve();
      }
    };
    w.addEventListener('message', onMsg);
    w.onerror = (err) => { _loading = null; reject(err); };
    w.postMessage({ type: 'load' });
  });
  return _loading;
}

/**
 * 이미지(dataURL) → 정규화된 CLIP 임베딩(Float32Array). 워커에서 계산.
 */
export function embed(dataUrl) {
  const w = ensureWorker();
  return new Promise((resolve) => {
    const id = ++_reqId;
    _pending.set(id, resolve);
    w.postMessage({ type: 'embed', id, dataUrl });
  });
}

/** 두 단위 벡터의 코사인 유사도 (= 내적), 대략 0~1 범위 */
export function cosine(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
