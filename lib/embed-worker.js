/**
 * embed-worker.js — CLIP 이미지 임베딩을 별도 스레드(Web Worker)에서 실행.
 * 메인 스레드(화면)를 막지 않아 매칭 중에도 UI 가 멈추지 않는다.
 * 메시지: {type:'load'} → 'progress'/'loaded', {type:'embed', id, dataUrl} → 'result'
 */
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';

const MODEL = 'Xenova/clip-vit-base-patch32';
let extractor = null;
let device = 'wasm';

function l2(arr) {
  let s = 0;
  for (const x of arr) s += x * x;
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / s;
  return out;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    const prog = (p) => self.postMessage({ type: 'progress', p });
    // WebGPU 우선(워커에서도 지원), 실패 시 WASM
    if (self.navigator && self.navigator.gpu) {
      try {
        extractor = await pipeline('image-feature-extraction', MODEL, { device: 'webgpu', dtype: 'fp32', progress_callback: prog });
        device = 'webgpu';
      } catch (err) { extractor = null; }
    }
    if (!extractor) {
      extractor = await pipeline('image-feature-extraction', MODEL, { progress_callback: prog });
      device = 'wasm';
    }
    self.postMessage({ type: 'loaded', device });
  } else if (msg.type === 'embed') {
    try {
      const o = await extractor(msg.dataUrl, { normalize: true });
      const emb = l2(Array.from(o.data));
      self.postMessage({ type: 'result', id: msg.id, emb }, [emb.buffer]);
    } catch (err) {
      self.postMessage({ type: 'result', id: msg.id, emb: null, err: String((err && err.message) || err) });
    }
  }
};
