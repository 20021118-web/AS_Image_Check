# AS 부품 이미지 자동 매칭 스튜디오 (웹 버전)

`Python/Photo_Val.py` 의 기능을 **브라우저에서 100% 동작**하도록 옮긴 정적 웹 애플리케이션입니다.
서버·API 키·비용이 필요 없고, GitHub Pages 같은 정적 호스팅에 올리면 바로 씁니다.

## 무엇을 하나

1. **엑셀 부품 리스트 업로드** — 각 시트의 `D열(부품 이미지)` + `E열(서비스 코드)`를 **4행부터** 읽습니다. (열·시작행은 ⚙ 설정에서 변경 가능)
2. **원본 사진 업로드** — 고화질 원본 사진들.
3. **자동 매칭 (AI + 특징점 결합)** — 두 신호를 함께 씁니다.
   - **AI 의미 유사도**: CLIP 이미지 임베딩(브라우저 WASM)으로 "같은 물건일 가능성"을 코사인 유사도로 측정. **저해상도·저텍스처·조명 차이에 강함.**
   - **ORB 특징점**: OpenCV(WASM)로 국소 특징점을 RANSAC 매칭(inlier 수). 원본 사진을 **0·90·180·270° 회전**해 가장 잘 맞는 각도 채택. 저해상도 대응을 위해 **공통 해상도 업스케일 + CLAHE 대비 보정** 적용.
   - AI 유사도 ≥ 기준(기본 83%) **또는** ORB inlier ≥ 기준(기본 15) 이면 **성공**. 카드에 `AI 88% · ORB 154 · 180°`처럼 표시하고, 후보를 직접 바꿀 수 있습니다.
   - 진행 상황은 **% 진행바**로, 모델 최초 다운로드는 **% 오버레이**로 보여줍니다.
4. **배경 제거 · 내보내기** — 확정된 사진을 AI로 배경 제거 → 흰 배경 합성 → `{서비스코드}.png` 로 만들고, `엑셀파일명/코드.png` 구조의 **ZIP**으로 다운로드합니다.

## 파이썬 원본과의 대응

| 파이썬 (`Photo_Val.py`) | 웹 버전 | 비고 |
|---|---|---|
| `openpyxl` + `openpyxl_image_loader` | `lib/xlsx.js` (JSZip 로 xlsx 직접 파싱) | D열 이미지 · E열 코드 · 4행 시작 (설정에서 변경 가능) |
| `cv2.SIFT` + `BFMatcher` + `findHomography(RANSAC)` | `lib/matcher.js` (`@techstark/opencv-js`) | **강화 ORB**(3000 특징점·10 피라미드·CLAHE·업스케일). 브라우저 WASM 빌드에 SIFT 미포함이라 ORB 사용 |
| (없음 — 신규) | `lib/embedder.js` (`@huggingface/transformers`, CLIP ViT-B/32) | **AI 의미 유사도 매칭** — 저해상도 썸네일 대응 핵심 |
| `MIN_INLIER_COUNT = 15` | 설정(⚙)에서 AI %·ORB 점수 조절 | |
| `rembg` (U²-Net/ISNet) | `@imgly/background-removal` (ISNet 계열 ONNX, 브라우저 WASM) | 배경 제거 후 흰 배경 합성 동일 |
| 폴더 저장 | ZIP 다운로드 | `{엑셀명}/{코드}.png` |

## 로컬에서 실행

정적 파일이라 아무 정적 서버로나 열면 됩니다 (ES 모듈 때문에 `file://` 직접 열기는 안 됨).

```bash
cd WebApp
python -m http.server 5599
# 브라우저에서 http://localhost:5599 접속
```

## GitHub Pages 배포

1. 새 GitHub 저장소를 만들고 `WebApp` 폴더 안의 파일들을 **저장소 루트**에 올립니다.
   (즉 `index.html`, `app.js`, `styles.css`, `lib/` 가 루트에 오도록)
   ```bash
   cd WebApp
   git init
   git add .
   git commit -m "AS 부품 이미지 자동 매칭 스튜디오"
   git branch -M main
   git remote add origin https://github.com/<계정>/<저장소>.git
   git push -u origin main
   ```
2. 저장소 **Settings → Pages → Build and deployment**
   - Source: `Deploy from a branch`
   - Branch: `main` / `/ (root)` → **Save**
3. 잠시 뒤 `https://<계정>.github.io/<저장소>/` 로 접속하면 됩니다.

> 사내 배포가 필요하면 GitHub Enterprise Pages, 사내 웹서버, 또는 회사 공유 폴더의 정적 호스팅에 같은 파일을 올리면 동일하게 동작합니다.

## 사용 팁 / 주의

- **최초 실행 시**: 매칭 엔진(OpenCV WASM ~9MB), AI 매칭 모델(CLIP, 수십 MB), AI 배경제거 모델(수십 MB)을 CDN에서 처음 한 번 내려받습니다. 다운로드는 **% 오버레이**로 표시되며, 이후에는 브라우저 캐시로 빠르게 동작합니다. (인터넷 연결 필요)
- **처리량**: 모든 계산이 사용자 PC(브라우저)에서 일어납니다. 수십~수백 장은 무리 없으나, 매우 많은 양은 시간이 걸립니다.
- **엑셀 양식이 다르면**: ⚙ 설정에서 **이미지 열 / 코드 열 / 시작 행**을 바꾸세요(예: 이미지 C열, 코드 D열, 3행 시작).
- **매칭 기준 조절**: ⚙ 설정에서 **AI 유사도 기준(%)**·**ORB 점수 기준**을 조절합니다. 오매칭이 많으면 AI 기준을 올리고(예: 87%), 매칭이 부족하면 낮추세요. 특히 **같은 제품의 부품끼리는 AI 유사도가 전반적으로 높게** 나오므로, 원본 사진을 부품별로 충분히 넣을수록 정확해집니다. 카드의 **후보 변경**으로 직접 확정할 수 있습니다.
- **배경 제거 없이**: 3단계에서 "AI 배경 제거 사용" 체크를 끄면 배경 제거 없이 흰 배경 합성 + 코드 명명만 수행합니다.
- **업데이트 반영**: 파일을 재배포한 뒤 화면이 안 바뀌면 브라우저 캐시 때문입니다. `Ctrl+Shift+R` 로 강력 새로고침하거나, `index.html`·`app.js` 의 `?v=2` 숫자를 올리면(예: `?v=3`) 최신본이 강제로 로드됩니다.

## 파일 구성

```
WebApp/
├─ index.html         # 화면 구조
├─ styles.css         # 디자인
├─ app.js             # 전체 흐름 오케스트레이션 (ES module)
└─ lib/
   ├─ xlsx.js         # 엑셀 셀 삽입 이미지 + 코드 추출 (열/행 지정 가능)
   ├─ matcher.js      # OpenCV 강화 ORB 특징점 매칭 (회전·CLAHE·업스케일)
   ├─ embedder.js     # CLIP AI 매칭 (메인 스레드 프록시)
   └─ embed-worker.js # CLIP 추론을 도는 Web Worker (화면 안 멈추게)
```

> ⚠️ 배포 시 `lib/embed-worker.js` 를 반드시 함께 올리세요. 없으면 AI 매칭이 동작하지 않습니다.

## 성능 / 멈춤 방지

- **AI 추론은 Web Worker(별도 스레드)** 에서 실행되어, 매칭 중에도 화면이 멈추지 않습니다.
- 기본은 **AI 전용(빠름)** 모드입니다. 매칭 중 화면 블로킹이 ~0.1초 수준으로 유지됩니다.
- **ORB 정밀 검증**(⚙ 설정)은 정확도를 높이지만 OpenCV 계산이 메인 스레드에서 돌아 사진 수가 많으면 느려질 수 있습니다. 느리면 끄세요.
- 화면에는 원본이 아니라 **작은 썸네일**을 표시해 카드가 많아도 가볍습니다(원본은 내보내기에만 사용).
- 가능하면 **WebGPU** 로 AI를 가속합니다(미지원 시 자동으로 WASM).

## 사용 라이브러리 (모두 CDN, 오픈소스)

- [JSZip](https://stuk.github.io/jszip/) — xlsx 파싱 / 결과 ZIP 생성
- [FileSaver.js](https://github.com/eligrey/FileSaver.js) — 다운로드
- [@techstark/opencv-js](https://www.npmjs.com/package/@techstark/opencv-js) — OpenCV WASM (특징점 매칭)
- [@huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers) — CLIP 이미지 임베딩 (AI 의미 유사도 매칭)
- [@imgly/background-removal](https://www.npmjs.com/package/@imgly/background-removal) — 브라우저 AI 배경 제거
