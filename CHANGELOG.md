# CHANGELOG

## v0.1.0
- 파일 생성

## v0.1.1
- ui 생성

## v0.1.2
- v0.1.1 갈아엎고 ui 및 기능 제작

## v0.1.3
- v0.1.2에서 ui 디자인 수정

## v0.1.4
- v0.1.3에서 ui 디자인 수정

## v0.1.5
- v0.1.4에서 ui 디자인 수정

## v0.2.0
- spotify 연결 시도

## v0.2.1
- spotify 연결 실패 후 장르에 붐뱁 추가

## v0.3.0
- Spotify 장르/트랙 카탈로그 조회용 Python 서버 추가
- 프론트에서 `/api/genres`, `/api/genre-details` 우선 사용하도록 변경
- 서버 미연결 시 `genres.json`으로 자동 폴백되도록 수정
- Spotify 플레이리스트/좋아요/프로필 UI 유지하면서 백엔드 기반 장르 탐색 구조 추가

## v0.3.1
- Spotify 연결 안되는 문제 수정

## v0.3.2
- Spotify 연결 안되는 문제 수정

## v0.4.0
- backend

## v0.4.1
- frontend

## v0.4.2
- error

## v0.4.3
- error

## v0.4.4
- 프론트 스크립트 중복 로딩 문제 수정
- DOM 로딩 전 이벤트 바인딩으로 발생하던 콘솔 에러 수정
- 백엔드 `/api/genres`, `/api/genre-details` 라우팅 추가
- Render 배포 환경에서 API가 404를 반환하던 문제 수정

## v0.4.5
- Spotify 장르 시드 API 의존성을 제거하고 `data/genres.json` 기반으로 장르 목록 응답하도록 수정
- `/api/genres` 호출 시 502가 발생하던 문제 수정

## v0.4.6
- 검색창이 트랙명이나 아티스트명이 아니라 장르 이름과 스타일만 검색하도록 수정
- Spotify `Get Available Genre Seeds` 와 `Get Recommendations` 흐름을 기준으로 장르별 추천 곡을 우선 불러오도록 수정
- 추천 API 실패 시 로컬 장르 데이터와 장르 기반 검색 결과로 자연스럽게 폴백되도록 보강

## v0.4.7
- `Boom Bap`, `R&B`, `Lo-Fi`, `K-Pop` 같은 장르 별칭을 Spotify seed와 매핑하도록 보강
- 장르 검색 시 별칭, seed 이름, 검색어까지 함께 인식하도록 수정
- `data/genres.json`에 Spotify 기반 탐색용 장르를 대폭 추가하고 연결 장르(`dance`, `grime`, `rap-rock`, `drill`)도 함께 보강

## v0.5.0
- 홈 화면 장르 라이브러리를 기본 4개만 노출하고 `All Genres` 버튼으로 전체 확장되도록 수정
- `Library`와 `Profile`을 스크롤 섹션이 아닌 별도 화면 전환 방식으로 개편
- 프로필 버튼 클릭 시 Spotify 계정 상태와 라이브러리 요약을 보는 프로필 화면으로 이동하도록 수정
- 장르 카드의 `recommendation picks` 문구와 waveform 패널 제거
- `Jazz Hip-Hop` 설명이 Spotify 아티스트 문구로 덮어써지지 않도록 수정하고 기본 대표 곡 수 보강
- `K-Pop` seed/search 기준과 대표 곡을 한국 아이돌 음악 맥락에 맞게 조정

## v0.5.1
- 장르 상태 표시에서 `4 / 23 장르` 같은 축약 카운트 문구 제거
- 사이드바에서 `Liked Tracks`, `Search` 메뉴를 제거하고 `Playlists`를 생성 진입점으로 유지
- 라이브러리 화면의 `Create Playlist` 버튼 제거
- 프로필 화면의 액션 버튼을 제거하고 `Go To` 영역을 `Settings` 영역으로 변경
- 상단 메뉴 패널은 `Settings` 한 개만 노출되도록 정리

## v0.5.2
- 장르 상세 트랙 로딩 기준을 Spotify 추천 위주에서 인기순 검색 기준으로 조정
- Spotify 검색 결과와 추천 결과를 합쳐 중복 제거 후 장르별 대표곡 8개를 우선 노출하도록 수정
- 트랙 popularity 값을 함께 보존해 더 유명한 곡이 앞에 오도록 정렬
- 홈 히어로 영역의 라이트/다크 모드 버튼 제거
- `Settings`를 프로필과 분리된 별도 화면으로 추가
- 프로필 화면 `Settings` 칸에 `More Settings` 버튼을 추가해 설정 화면으로 이동하도록 수정
- 설정 화면에서 라이트/다크 모드 전환을 별도로 제공하고 프로필 내 간단 전환 버튼은 유지

## v0.5.4
- 장르 라이브러리의 기본 `전체 장르` 상태 텍스트를 숨기도록 조정
- 확장 버튼 라벨을 `All Genres`에서 `Show More`로 변경

## v0.5.5
- 장르별 대표 곡 선정 시 Spotify popularity 기준으로 상위 8곡이 더 정확히 앞에 오도록 정렬 로직 보강
- 검색 결과와 추천 결과를 합친 뒤 다시 popularity 기준으로 재정렬하도록 수정
- `Representative Tracks` 섹션명을 `Representative Major Tracks`로 변경
