/**
 * matcher.js — opencv.js(WASM) 로 SIFT/ORB 특징점 매칭을 수행한다.
 *
 * 파이썬 원본(Photo_Val.py)의 매칭 로직을 그대로 옮김:
 *   get_sift_features : 그레이스케일 → 긴 변 512px 리사이즈 → detectAndCompute
 *   match_features    : knnMatch(k=2) → ratio test(0.7) → good>=10 → findHomography(RANSAC) → inlier 수
 *   판정 기준         : inlier >= MIN_INLIER_COUNT(15)
 *
 * opencv.js 기본 빌드에 SIFT 가 포함돼 있으면 SIFT 를, 없으면 ORB 로 자동 대체한다.
 * 전제: 전역에 opencv.js 의 `cv` 가 초기화되어 있어야 한다.
 */

export const MIN_INLIER_COUNT = 15;
// 공통 작업 해상도: 저해상도 썸네일은 확대, 큰 사진은 축소해 스케일을 맞춘다.
const TARGET_DIM = 640;

let _detector = null;
let _detectorName = '';
let _normType = 0;

/** 사용 가능한 특징점 검출기를 준비한다 (SIFT 우선, 실패 시 강화 ORB). */
function getDetector() {
  if (_detector) return _detector;
  try {
    _detector = new cv.SIFT();
    _detectorName = 'SIFT';
    _normType = cv.NORM_L2;
  } catch (e) {
    // nfeatures=1200: BFMatcher 는 특징점 수의 제곱으로 느려지므로 속도/정확도 균형점.
    // scaleFactor=1.2, nlevels=8, edgeThreshold=15(작은 이미지 대응)
    _detector = new cv.ORB(1200, 1.2, 8, 15);
    _detectorName = 'ORB(강화)';
    _normType = cv.NORM_HAMMING;
  }
  return _detector;
}

export function getDetectorName() {
  getDetector();
  return _detectorName;
}

/** dataURL → HTMLImageElement (로드 완료까지 대기) */
export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/** 매칭 시 시도할 회전 각도들 (원본 사진을 돌려가며 확인) */
export const ROTATIONS = [0, 90, 180, 270];

/**
 * HTMLImageElement → 대비 보정된 그레이스케일 cv.Mat.
 * 긴 변을 TARGET_DIM 으로 맞추고(작으면 확대·크면 축소), 흰 배경 합성,
 * deg 회전(0/90/180/270), CLAHE 대비 보정으로 저해상도/저조도에서 특징점을 더 검출.
 */
function toGrayMat(img, deg = 0) {
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const long = Math.max(w, h) || 1;
  const scale = TARGET_DIM / long; // 항상 공통 해상도로 정규화 (업스케일 포함)
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));

  const swap = deg === 90 || deg === 270; // 90/270 회전 시 가로세로 바뀜
  const canvas = document.createElement('canvas');
  canvas.width = swap ? sh : sw;
  canvas.height = swap ? sw : sh;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff'; // 투명(RGBA) 이미지는 흰 배경으로 (Python 과 동일)
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);

  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  src.delete();

  // CLAHE 대비 보정 (실패 시 원본 그레이 유지)
  try {
    const eq = new cv.Mat();
    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(gray, eq);
    clahe.delete();
    gray.delete();
    return eq;
  } catch (e) {
    return gray;
  }
}

function detectOn(gray) {
  const detector = getDetector();
  const kp = new cv.KeyPointVector();
  const des = new cv.Mat();
  const mask = new cv.Mat();
  try {
    detector.detectAndCompute(gray, mask, kp, des);
  } catch (e) {
    // 실패 시 빈 결과
  }
  mask.delete();
  return { kp, des };
}

/**
 * 이미지의 특징점/기술자를 계산한다 (기본 0°).
 * @returns {{kp: cv.KeyPointVector, des: cv.Mat, deg:number}} — 사용 후 releaseFeatures 로 해제
 */
export async function computeFeatures(dataUrl, deg = 0) {
  const img = await loadImage(dataUrl);
  const gray = toGrayMat(img, deg);
  const f = detectOn(gray);
  gray.delete();
  return { ...f, deg };
}

/**
 * 0/90/180/270 회전본 각각의 특징점을 계산해 배열로 반환.
 * (원본 사진을 돌려가며 엑셀 썸네일과 비교하기 위함)
 * @returns {Array<{kp,des,deg}>} — 사용 후 releaseFeatureList 로 해제
 */
export async function computeFeaturesAllRotations(dataUrl) {
  const img = await loadImage(dataUrl);
  const list = [];
  for (const deg of ROTATIONS) {
    const gray = toGrayMat(img, deg);
    const f = detectOn(gray);
    gray.delete();
    list.push({ ...f, deg });
  }
  return list;
}

export function releaseFeatures(f) {
  if (!f) return;
  try { f.kp && f.kp.delete(); } catch (e) {}
  try { f.des && f.des.delete(); } catch (e) {}
}

export function releaseFeatureList(list) {
  if (!list) return;
  list.forEach(releaseFeatures);
}

/**
 * 쿼리 특징점(f)을 원본 사진의 여러 회전본(rotFeatures)과 매칭해
 * 0/90/180/270 중 "가장 잘 맞는" 각도의 점수와 그 각도를 반환한다.
 * (조기 종료하지 않고 4방향을 모두 확인해 최고 점수를 채택 —
 *  일부 부품은 회전한 각도에서 점수가 더 높게 나오기 때문)
 * @returns {{score:number, deg:number}}
 */
export function matchBestRotation(f, rotFeatures) {
  let best = -1;
  let bestDeg = 0;
  for (const rf of rotFeatures) {
    const s = matchFeatures(f, rf);
    if (s > best) { best = s; bestDeg = rf.deg; }
  }
  return { score: best, deg: bestDeg };
}

/**
 * 두 기술자 집합을 매칭하여 RANSAC inlier 수를 반환 (Photo_Val.py match_features 와 동일).
 */
export function matchFeatures(f1, f2) {
  const des1 = f1.des, des2 = f2.des;
  if (!des1 || !des2 || des1.rows < 2 || des2.rows < 2) return 0;

  const bf = new cv.BFMatcher(_normType, false);
  const knn = new cv.DMatchVectorVector();
  let inliers = 0;
  const cleanup = [bf, knn];
  try {
    bf.knnMatch(des1, des2, knn, 2);

    const goodSrc = []; // f1 좌표
    const goodDst = []; // f2 좌표
    for (let i = 0; i < knn.size(); i++) {
      const pair = knn.get(i);
      if (pair.size() < 2) { pair.delete(); continue; }
      const m = pair.get(0);
      const n = pair.get(1);
      if (m.distance < 0.7 * n.distance) {
        const p1 = f1.kp.get(m.queryIdx).pt;
        const p2 = f2.kp.get(m.trainIdx).pt;
        goodSrc.push(p1.x, p1.y);
        goodDst.push(p2.x, p2.y);
      }
      pair.delete();
    }

    const good = goodSrc.length / 2;
    if (good >= 10) {
      const srcMat = cv.matFromArray(good, 1, cv.CV_32FC2, goodSrc);
      const dstMat = cv.matFromArray(good, 1, cv.CV_32FC2, goodDst);
      const mask = new cv.Mat();
      const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 5.0, mask);
      if (!mask.empty()) inliers = cv.countNonZero(mask);
      srcMat.delete();
      dstMat.delete();
      mask.delete();
      if (H) H.delete();
    }
  } catch (e) {
    inliers = 0;
  } finally {
    cleanup.forEach((c) => { try { c.delete(); } catch (e) {} });
  }
  return inliers;
}
