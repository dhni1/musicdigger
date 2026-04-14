# MUSICDIGGER

MUSICDIGGER는 장르를 중심으로 음악을 탐색하는 웹 앱입니다. 장르 카드, 대표 트랙, 연결된 서브장르를 따라가며 새로운 스타일을 발견할 수 있고, `Map` 뷰에서 장르를 지형처럼 넓게 훑어볼 수도 있습니다. Spotify 로그인 시 프로필, 좋아요 트랙, 플레이리스트 기능도 함께 사용할 수 있습니다.

## 주요 기능

- 장르 라이브러리 탐색 및 검색
- 장르 맵 뷰 탐색
- 장르별 대표곡 8개 표시
- `Subgenres`, `Similar`, `Fusion` 연결 탐색
- 랜덤 장르 추천
- Spotify 로그인(PKCE)
- Spotify 프로필, 플레이리스트, 좋아요 트랙 조회
- 현재 장르 기준 플레이리스트 생성
- 백엔드 실패 시 로컬 JSON/내장 데이터 폴백

## 프로젝트 구성

- `index.html`: 메인 UI 구조
- `design.css`: CSS 엔트리 파일
- `script.js`: JS 엔트리 파일
- `src/`: 프론트 앱 로직
  - `shared/`: 공용 상태, DOM 유틸, 네비게이션
  - `pages/`: `home`, `map`, `library`, `profile` 화면 로직
  - `services/spotify/`: Spotify 클라이언트 연동
- `styles/`: 공용 스타일과 페이지별 CSS 모듈
- `server.py`: 정적 파일 서빙 + Spotify 카탈로그 API
- `data/genres.json`: 로컬 장르 데이터
- `config.js`: 프론트에서 사용할 백엔드 주소 설정
- `spotify-config.js`: Spotify 로그인용 클라이언트 설정
- `spotify-server.env.example`: 서버 환경 변수 예시

## 로컬 실행

### 1. 서버 실행

```bash
python3 server.py
```

기본 주소:

```text
http://127.0.0.1:8000/index.html
```

### 2. 선택: Spotify 서버 기능 활성화

`server.py`는 환경 변수가 없으면 로컬 장르 데이터로 동작합니다. Spotify 기반 장르/트랙 조회까지 쓰려면 아래 값을 설정하세요.

```bash
export SPOTIFY_CLIENT_ID=your_spotify_client_id
export SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
export SPOTIFY_MARKET=US
export PORT=8000
python3 server.py
```

또는 [`spotify-server.env.example`](/Users/dhni/Documents/code/musicdigger/spotify-server.env.example) 내용을 참고해 직접 환경 변수를 넣으면 됩니다.

### 3. 선택: Spotify 로그인 기능 설정

클라이언트 로그인은 [`spotify-config.js`](/Users/dhni/Documents/code/musicdigger/spotify-config.js) 의 `clientId`, `redirectUri`를 사용합니다.

- `clientId`: Spotify 앱의 Client ID
- `redirectUri`: Spotify 앱 설정에 등록한 Redirect URI와 동일해야 함
- 비워두면 현재 페이지 주소를 redirect URI로 사용

로컬에서 테스트할 때는 예를 들어 아래처럼 맞추면 됩니다.

```js
redirectUri: 'http://127.0.0.1:8000/index.html'
```

## API

`server.py`는 아래 엔드포인트를 제공합니다.

- `GET /api/genres`: 장르 목록 반환
- `GET /api/genre-details?genre=<id>`: 특정 장르 상세 정보 반환

Spotify 서버 설정이 되어 있으면 Spotify 데이터를 우선 사용하고, 실패하면 로컬 데이터를 사용합니다.

## 동작 방식

1. 앱 시작 시 로컬 장르를 먼저 빠르게 렌더링합니다.
2. 이후 백엔드 `/api/genres` 응답이 가능하면 데이터를 갱신합니다.
3. 장르 상세 조회 시 `/api/genre-details`를 호출합니다.
4. Spotify 응답이 부족하거나 실패하면 `data/genres.json` 또는 내장 기본 데이터로 폴백합니다.

## 보안 관련 메모

- 프론트의 동적 렌더링은 `innerHTML` 대신 DOM API 기반으로 구성되어 있습니다.
- Spotify 클라이언트 토큰은 `localStorage` 대신 `sessionStorage`에 저장됩니다.
- `server.py`는 저장소 루트 전체를 공개하지 않고, 필요한 정적 파일만 허용합니다.

## 배포 구성

- 프론트엔드: `https://musicdigger.vercel.app`
- 백엔드: `https://musicdigger.onrender.com`

프론트는 [`config.js`](/Users/dhni/Documents/code/musicdigger/config.js) 의 `backendBaseUrl` 값을 사용해 백엔드를 호출합니다.

## 참고

- 현재 UI 언어는 한국어/영어가 일부 섞여 있습니다.
- `spotify-config.js`에 들어가는 값은 로그인용 클라이언트 설정입니다.
- 서버 측 비밀 값은 반드시 환경 변수로 관리해야 합니다.
