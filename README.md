# AS 부품 이미지 자동 매칭 스튜디오 (웹 버전)

`Python/Photo_Val.py` 의 기능을 **브라우저에서 100% 동작**하도록 옮긴 정적 웹 애플리케이션입니다.
서버·API 키·비용이 필요 없고, GitHub Pages 같은 정적 호스팅에 올리면 바로 씁니다.

## 무엇을 하나

1. **엑셀 부품 리스트 업로드** — 각 시트의 `D열(부품 이미지)` + `E열(서비스 코드)`를 **4행부터** 읽습니다. (파이썬 원본과 동일)
2. **원본 사진 업로드** — 고화질 원본 사진들.
3. **자동 매칭** — OpenCV(WASM)의 특징점 매칭(RANSAC inlier 수)으로 엑셀 썸네일 ↔ 원본 사진을 짝지어 줍니다. 원본 사진을 **0·90·180·270°로 돌려가며** 각각 비교해 가장 잘 맞는 각도의 점수를 채택하고, 카드에 그 각도를 표시합니다(예: `94점 · 90° 회전`). 기준 점수(기본 15) 이상이면 성공. 카드에서 후보를 직접 바꿀 수도 있습니다.
4. **배경 제거 · 내보내기** — 확정된 사진을 AI로 배경 제거 → 흰 배경 합성 → `{서비스코드}.png` 로 만들고, `엑셀파일명/코드.png` 구조의 **ZIP**으로 다운로드합니다.

## 파이썬 원본과의 대응

| 파이썬 (`Photo_Val.py`) | 웹 버전 | 비고 |
|---|---|---|
| `openpyxl` + `openpyxl_image_loader` | `lib/xlsx.js` (JSZip 로 xlsx 직접 파싱) | D열 이미지 · E열 코드 · 4행 시작 동일 |
| `cv2.SIFT` + `BFMatcher` + `findHomography(RANSAC)` | `lib/matcher.js` (`@techstark/opencv-js`) | **ORB** 사용 — 브라우저 WASM 표준 빌드에 SIFT 미포함. ORB는 SIFT의 무료 대체 알고리즘으로 동등한 매칭 성능 |
| `MIN_INLIER_COUNT = 15` | 설정(⚙)에서 조절 | 동일 기본값 |
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

- **최초 실행 시**: 매칭 엔진(OpenCV WASM, ~9MB)과 AI 배경제거 모델(수십 MB)을 CDN에서 처음 한 번 내려받습니다. 이후에는 브라우저 캐시로 빠르게 동작합니다. (인터넷 연결 필요)
- **처리량**: 모든 계산이 사용자 PC(브라우저)에서 일어납니다. 수십~수백 장은 무리 없으나, 매우 많은 양은 시간이 걸립니다.
- **매칭이 잘 안 될 때**: ⚙ 설정에서 기준 점수를 낮춰 보세요(예: 10). 낮추면 매칭률은 오르지만 오매칭 가능성도 커집니다. 카드의 **후보 변경**으로 직접 확정할 수 있습니다.
- **배경 제거 없이**: 3단계에서 "AI 배경 제거 사용" 체크를 끄면 배경 제거 없이 흰 배경 합성 + 코드 명명만 수행합니다.

## 파일 구성

```
WebApp/
├─ index.html      # 화면 구조
├─ styles.css      # 디자인
├─ app.js          # 전체 흐름 오케스트레이션 (ES module)
└─ lib/
   ├─ xlsx.js      # 엑셀 셀 삽입 이미지 + 코드 추출
   └─ matcher.js   # OpenCV(ORB) 특징점 매칭
```

## 사용 라이브러리 (모두 CDN, 오픈소스)

- [JSZip](https://stuk.github.io/jszip/) — xlsx 파싱 / 결과 ZIP 생성
- [FileSaver.js](https://github.com/eligrey/FileSaver.js) — 다운로드
- [@techstark/opencv-js](https://www.npmjs.com/package/@techstark/opencv-js) — OpenCV WASM (특징점 매칭)
- [@imgly/background-removal](https://www.npmjs.com/package/@imgly/background-removal) — 브라우저 AI 배경 제거
