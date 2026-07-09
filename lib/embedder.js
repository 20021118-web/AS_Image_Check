/**
 * embedder.js — CLIP 이미지 임베딩 기반 "의미 유사도" 매칭.
 *
 * transformers.js(브라우저 WASM)로 CLIP ViT-B/32 를 실행해 이미지를 512차원 벡터로 바꾸고,
 * 코사인 유사도로 부품 썸네일 ↔ 원본 사진의 "같은 물건일 가능성"을 측정한다.
 * ORB(국소 특징점)와 달리 저해상도·저텍스처·조명 차이에 강하다.
 */

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
const MODEL = 'Xenova/clip-vit-base-patch32';

let _extractor = null;
let _loading = null;

/**
 * 임베딩 모델을 로드(최초 1회, 수십 MB 다운로드).
 * @param {(p:object)=>void} onProgress transformers.js 진행 콜백
 */
export function loadEmbedder(onProgress) {
  if (_extractor) return Promise.resolve(_extractor);
  if (_loading) return _loading;
  _loading = (async () => {
    const { pipeline } = await import(TRANSFORMERS_CDN);
    _extractor = await pipeline('image-feature-extraction', MODEL,
      onProgress ? { progress_callback: onProgress } : undefined);
    return _extractor;
  })();
  return _loading;
}

export function isEmbedderReady() {
  return !!_extractor;
}

/** L2 정규화 (단위 벡터로) */
function l2normalize(arr) {
  let s = 0;
  for (const x of arr) s += x * x;
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / s;
  return out;
}

/**
 * 이미지(dataURL) → 정규화된 CLIP 임베딩(Float32Array, 512).
 */
export async function embed(dataUrl) {
  const ex = await loadEmbedder();
  const output = await ex(dataUrl, { normalize: true });
  return l2normalize(Array.from(output.data));
}

/** 두 단위 벡터의 코사인 유사도 (= 내적), 대략 0~1 범위 */
export function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
