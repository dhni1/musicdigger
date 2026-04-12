window.SPOTIFY_CONFIG = {
  // 이 값은 사용자 로그인(PKCE)에만 사용됩니다.
  // 장르/트랙 카탈로그 조회는 server.py가 환경변수로 읽는
  // SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET를 사용합니다.
  clientId: 'YOUR_SPOTIFY_CLIENT_ID',
  // 예시: 'http://127.0.0.1:8000/index.html'
  // 비워두면 현재 페이지 주소를 redirect URI로 사용합니다.
  redirectUri: '',
};
