let genres = [];

// 데이터 불러오기
fetch('genres.json')
  .then(res => res.json())
  .then(data => {
    genres = data.genres;
    renderGenreList();
  });

// 장르 목록 출력
function renderGenreList() {
  const list = document.getElementById('genre-list');
  list.innerHTML = '';

  genres.forEach(g => {
    const btn = document.createElement('button');
    btn.textContent = g.name;
    btn.className = 'genre-btn';
    btn.onclick = () => showGenre(g.id);
    list.appendChild(btn);
  });
}

// 장르 정보 표시
function showGenre(id) {
  const genre = genres.find(g => g.id === id);
  if (!genre) return;

  document.getElementById('genre-title').textContent = genre.name;
  document.getElementById('genre-desc').textContent = genre.description;

  // 대표곡
  const trackList = document.getElementById('track-list');
  trackList.innerHTML = '';
  genre.tracks.forEach(t => {
    const li = document.createElement('li');
    li.textContent = `${t.title} - ${t.artist}`;
    trackList.appendChild(li);
  });

  // 하위 장르
  renderButtons('subgenres', genre.subgenres);

  // 유사 장르
  renderButtons('similar', genre.similar);

  // 융합 장르
  renderButtons('fusion', genre.fusion);
}

// 버튼 렌더링
function renderButtons(elementId, ids) {
  const container = document.getElementById(elementId);
  container.innerHTML = '';

  ids.forEach(id => {
    const g = genres.find(x => x.id === id);
    if (!g) return;

    const btn = document.createElement('button');
    btn.textContent = g.name;
    btn.onclick = () => showGenre(g.id);

    container.appendChild(btn);
  });
}