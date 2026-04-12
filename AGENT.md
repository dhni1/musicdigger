# MUSICDIGGER Agent

## 개요
MUSICDIGGER는 장르 기반 음악 탐색 UI를 제공하는 웹 애플리케이션입니다. 로컬 데이터와 Spotify API를 모두 활용하며, 사용자는 장르를 검색하고 장르별 대표 트랙, 연결된 서브장르, 관련 장르를 확인할 수 있습니다.

## 주요 기능
- 장르 라이브러리 브라우징
- 실시간 검색 필터링
- 랜덤 장르 탐색
- 장르별 대표 트랙 표시
- Spotify 로그인 및 라이브러리/플레이리스트 연동
- 좋아요 트랙 저장 기능
- Spotify 기반 장르 상세 정보 로딩
- 오프라인 및 백엔드 실패 시 로컬/내장 데이터 폴백

## 아키텍처 요약
- `index.html`: 애플리케이션의 기본 페이지 레이아웃과 UI 구조
- `design.css`: 다크/라이트 테마 스타일과 전체 UI 디자인
- `script.js`: 클라이언트 측 상태 관리, 렌더링, 이벤트 처리, Spotify 통합
- `server.py`: 간단한 HTTP 서버 및 Spotify 카탈로그 API 프록시
- `data/genres.json`: 로컬 장르 데이터 폴백
- `spotify-config.js`: Spotify 클라이언트 PKCE 로그인 설정
- `spotify-server.env.example`: 서버 측 Spotify 인증 설정 예시

## 실행 방법
1. Python 3 환경에서 `server.py` 실행
2. 환경 변수 설정
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
   - `SPOTIFY_MARKET` (기본값: `US`)
   - `PORT` (기본값: `8000`)
3. 브라우저에서 `http://127.0.0.1:8000/index.html` 접속

## 배포 방법
- 프론트엔드: Vercel (https://musicdigger.vercel.app)
- 백엔드: Render (https://musicdigger.onrender.com)
- 프론트에서 백엔드 API 호출 시 `config.js`의 `backendBaseUrl` 사용

## Spotify 통합
- 클라이언트 측은 `spotify-config.js`의 `clientId`와 `redirectUri`를 사용하여 PKCE 인증 흐름을 수행합니다.
- 서버 측은 `server.py`에서 `SPOTIFY_CLIENT_ID`와 `SPOTIFY_CLIENT_SECRET`를 사용하여 Spotify Client Credentials로 장르 목록과 트랙 데이터를 가져옵니다.
- `script.js`는 로그인 상태에 따라 Spotify 프로필, 플레이리스트, 좋아요 트랙을 노출하고, 현재 장르의 트랙을 Spotify URI로 변환하여 플레이리스트 생성/저장 기능을 제공합니다.

## 상태 및 로드 흐름
1. 애플리케이션 초기화 시 `loadGenres()` 실행
2. `/api/genres` 호출 시도
3. 실패 시 `data/genres.json` 로드
4. 실패 시 `script.js` 내 `BUILTIN_GENRES` 사용
5. 장르 선택 시 Spotify 백엔드 장르라면 `/api/genre-details` 호출로 상세 정보 갱신

## 개발 안내
- 새 장르를 추가하려면 `data/genres.json` 또는 `script.js`의 `BUILTIN_GENRES`에 항목 추가
- Spotify 인증을 사용하려면 `spotify-server.env.example`를 기반으로 `.env` 또는 환경 변수를 설정
- `spotify-config.js`의 `clientId`는 공개 설정이므로 실제 앱에서는 보안에 유의

## 개선 제안
- 서버 측 캐싱 및 에러 핸들링 강화
- 장르 간 연결 데이터(`subgenres`, `similar`, `fusion`) 자동 생성 로직 추가
- 트랙 검색 정확도를 높이는 Spotify 검색 세부 조정
- 모바일/반응형 UI 개선

## 참고
- 현재 프로젝트에는 `README.md`가 없으므로 이 `AGENT.md`를 초기 설명 문서로 사용
- `spotify-config.js`가 현재 예시 `clientId`를 포함하므로, 실제 배포 전에는 적절하게 교체하거나 숨겨야 합니다.
