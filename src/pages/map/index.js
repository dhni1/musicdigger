import {
  MAP_DRAG_THRESHOLD,
  MAP_MAX_ZOOM,
  MAP_MIN_NODE_GAP,
  MAP_MIN_ZOOM,
  MAP_SURFACE_HEIGHT,
  MAP_SURFACE_WIDTH,
  MAP_ZOOM_STEP,
  MAX_MAP_PREVIEW_TRACKS,
  elements,
  state,
} from '../../shared/context.js';
import {
  clearChildren,
  createEmptyState,
  createTextBlock,
} from '../../shared/dom.js';
import { clamp, hashString } from '../../shared/utils.js';

const MAP_INSPECTOR_MARGIN = 18;
const MAP_LAYOUT_MARGIN_X = 64;
const MAP_LAYOUT_MARGIN_Y = 72;
const MAP_FORCE_ITERATIONS = 140;
const MAP_HORIZONTAL_POSITIVE = [
  'dance',
  'drill',
  'punk',
  'grime',
  'trap',
  'hyperpop',
  'house',
  'edm',
  'electro',
  'disco',
  'reggaeton',
  'amapiano',
];
const MAP_HORIZONTAL_NEGATIVE = [
  'ambient',
  'shoegaze',
  'soundtrack',
  'jazz',
  'blues',
  'classical',
  'lofi',
  'acoustic',
  'folk',
  'bossa',
];
const MAP_VERTICAL_POSITIVE = [
  'edm',
  'house',
  'electro',
  'synthwave',
  'hyperpop',
  'dance',
  'trap',
  'drill',
  'grime',
  'reggaeton',
  'amapiano',
  'kpop',
];
const MAP_VERTICAL_NEGATIVE = [
  'jazz',
  'folk',
  'blues',
  'soul',
  'country',
  'classical',
  'acoustic',
  'bossa',
  'ambient',
  'lofi',
];

function createMapPage({ setActiveNav, showGenre, showView }) {
  let resizeBound = false;

  function renderGenreMap() {
    if (!elements.mapCanvas || !elements.mapSurface) {
      return;
    }

    const visibleGenres = [...state.filteredGenres];
    if (elements.mapVisibleCount) {
      elements.mapVisibleCount.textContent = String(visibleGenres.length);
    }
    if (elements.mapConnectionCount) {
      elements.mapConnectionCount.textContent = String(countVisibleMapConnections(visibleGenres));
    }

    if (visibleGenres.length === 0) {
      renderEmptyMapSurface(elements.mapSurface);
      if (elements.mapModalSurface) {
        renderEmptyMapSurface(elements.mapModalSurface);
      }
      state.mapLayoutById = new Map();
      renderMapSelection(null);
      closeMapInspector();
      return;
    }

    const layout = buildMapLayout(visibleGenres);
    state.mapLayoutById = new Map(layout.map(item => [item.genre.id, item]));
    renderMapSurface(elements.mapSurface, layout, 'main');

    if (elements.mapModalSurface) {
      renderMapSurface(elements.mapModalSurface, layout, 'modal');
    }

    if (state.mapInspector.isOpen) {
      updateMapInspectorUI();
    }
  }

  function renderMapSurface(surface, layout, viewportKey) {
    const scale = getMapZoom(viewportKey);
    clearChildren(surface);
    surface.style.width = `${Math.round(MAP_SURFACE_WIDTH * scale)}px`;
    surface.style.height = `${Math.round(MAP_SURFACE_HEIGHT * scale)}px`;

    const activeLayout = state.currentGenreId ? state.mapLayoutById.get(state.currentGenreId) : null;
    const activeConnections = new Set(activeLayout ? getMapConnectionIds(activeLayout.genre) : []);

    layout.forEach(item => {
      const button = document.createElement('button');
      const relationCount = getMapConnectionIds(item.genre).length;
      button.type = 'button';
      button.className = 'map-node';
      button.textContent = item.genre.name;
      button.style.left = `${Math.round(item.x * scale)}px`;
      button.style.top = `${Math.round(item.y * scale)}px`;
      button.style.fontSize = `${(item.size * clamp(scale, 0.28, 1.35)).toFixed(3)}rem`;
      button.title = `${item.genre.name} · ${relationCount} links`;

      if (item.genre.id === state.currentGenreId) {
        button.classList.add('is-active');
      } else if (activeConnections.has(item.genre.id)) {
        button.classList.add('is-linked');
      }

      button.addEventListener('pointerdown', event => {
        event.stopPropagation();
      });
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        selectMapGenre(item.genre.id, {
          openInspector: true,
          anchorPoint: getStagePointFromEvent(event),
        });
      });

      surface.appendChild(button);
    });

    ensureMapViewportReady(viewportKey);
    updateMapZoomUI(viewportKey);
  }

  function renderEmptyMapSurface(surface) {
    clearChildren(surface);
    surface.appendChild(
      createEmptyState('검색 결과가 없어 맵을 그릴 수 없습니다. 다른 장르 이름으로 다시 시도해보세요.', {
        className: 'empty-state map-empty-state',
      }),
    );
    surface.style.width = '100%';
    surface.style.height = '100%';
  }

  function renderMapSelection(genre) {
    if (!elements.mapSelectionTitle) {
      return;
    }

    if (!genre) {
      if (elements.mapSelectionBadge) {
        elements.mapSelectionBadge.textContent = 'Genre Field';
      }
      elements.mapSelectionTitle.textContent = 'Select a genre';
      elements.mapSelectionDesc.textContent =
        '맵의 장르 이름을 누르면 이 영역에 설명, 연결된 장르, 대표곡이 표시됩니다.';
      clearChildren(elements.mapSelectionLinks);
      clearChildren(elements.mapSelectionTracks);
      elements.mapSelectionLinks.appendChild(
        createEmptyState('연결된 장르가 여기에 표시됩니다.'),
      );
      elements.mapSelectionTracks.appendChild(
        createEmptyState('대표곡 미리보기가 여기에 표시됩니다.', {
          tagName: 'li',
        }),
      );
      if (elements.mapOpenHome) {
        elements.mapOpenHome.disabled = true;
      }
      return;
    }

    const connectionIds = getMapConnectionIds(genre);
    const previewTracks = (genre.tracks ?? []).slice(0, MAX_MAP_PREVIEW_TRACKS);

    if (elements.mapSelectionBadge) {
      elements.mapSelectionBadge.textContent = 'Music Map';
    }
    elements.mapSelectionTitle.textContent = genre.name;
    elements.mapSelectionDesc.textContent =
      genre.description ?? `${genre.name} 장르 설명이 아직 없습니다.`;
    clearChildren(elements.mapSelectionLinks);
    clearChildren(elements.mapSelectionTracks);

    if (elements.mapOpenHome) {
      elements.mapOpenHome.disabled = false;
    }

    if (connectionIds.length === 0) {
      elements.mapSelectionLinks.appendChild(
        createEmptyState('맵에서 표시할 연결 장르가 아직 없습니다.'),
      );
    } else {
      connectionIds.slice(0, 8).forEach(id => {
        const related = state.genres.find(item => item.id === id);

        if (!related) {
          return;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pill-btn';
        button.textContent = related.name;
        button.addEventListener('click', () => {
          selectMapGenre(related.id);
        });
        elements.mapSelectionLinks.appendChild(button);
      });
    }

    if (previewTracks.length === 0) {
      elements.mapSelectionTracks.appendChild(
        createEmptyState('이 장르에 등록된 대표곡이 아직 없습니다.', {
          tagName: 'li',
        }),
      );
      return;
    }

    previewTracks.forEach(track => {
      const item = document.createElement('li');
      item.className = 'map-track-item';
      item.appendChild(createTextBlock('strong', track.title));
      item.appendChild(createTextBlock('span', track.artist));
      elements.mapSelectionTracks.appendChild(item);
    });
  }

  function buildMapLayout(genres) {
    const nameById = new Map(genres.map(genre => [genre.id, genre.name]));
    const descriptors = new Map(
      genres.map(genre => [genre.id, buildGenreDescriptor(genre, nameById)]),
    );
    const projectedPositions = projectMapPositions(genres, descriptors);
    const layout = [];
    const sortedGenres = [...genres].sort((left, right) => {
      return getGenreWeight(right) - getGenreWeight(left) || left.name.localeCompare(right.name);
    });

    sortedGenres.forEach((genre, index) => {
      const size = clamp(
        0.92 + getGenreWeight(genre) * 0.045 + Math.max(0, 14 - genre.name.length) * 0.012,
        0.92,
        1.72,
      );
      const width = estimateMapNodeWidth(genre.name, size);
      const height = estimateMapNodeHeight(size);
      const projected = projectedPositions.get(genre.id) ?? {
        x: MAP_SURFACE_WIDTH / 2,
        y: MAP_SURFACE_HEIGHT / 2,
      };
      const position = findOpenProjectedPosition(genre.id, projected, width, height, layout, index);

      layout.push({
        genre,
        x: position.x,
        y: position.y,
        size,
        width: position.width,
        height: position.height,
      });
    });

    return layout;
  }

  function findOpenProjectedPosition(genreId, projected, width, height, existingLayout, index) {
    const hash = hashString(genreId);
    const baseAngle = (hash % 360) * (Math.PI / 180);
    const centerX = clamp(projected.x, width / 2 + MAP_LAYOUT_MARGIN_X, MAP_SURFACE_WIDTH - width / 2 - MAP_LAYOUT_MARGIN_X);
    const centerY = clamp(
      projected.y,
      height / 2 + MAP_LAYOUT_MARGIN_Y,
      MAP_SURFACE_HEIGHT - height / 2 - MAP_LAYOUT_MARGIN_Y,
    );

    for (let attempt = 0; attempt < 220; attempt += 1) {
      const ring = Math.floor(attempt / 8);
      const slot = attempt % 8;
      const angle = baseAngle + ring * 0.42 + slot * 0.78 + index * 0.06;
      const radiusX = ring * 18 + (hash % 11);
      const radiusY = ring * 16 + ((hash >> 4) % 9);
      const candidateX = clamp(
        centerX + Math.cos(angle) * radiusX,
        width / 2 + MAP_LAYOUT_MARGIN_X,
        MAP_SURFACE_WIDTH - width / 2 - MAP_LAYOUT_MARGIN_X,
      );
      const candidateY = clamp(
        centerY + Math.sin(angle) * radiusY,
        height / 2 + MAP_LAYOUT_MARGIN_Y,
        MAP_SURFACE_HEIGHT - height / 2 - MAP_LAYOUT_MARGIN_Y,
      );
      const candidateBox = {
        left: candidateX - width / 2 - MAP_MIN_NODE_GAP,
        right: candidateX + width / 2 + MAP_MIN_NODE_GAP,
        top: candidateY - height / 2 - MAP_MIN_NODE_GAP,
        bottom: candidateY + height / 2 + MAP_MIN_NODE_GAP,
      };

      const overlaps = existingLayout.some(item => {
        const box = {
          left: item.x - item.width / 2 - MAP_MIN_NODE_GAP,
          right: item.x + item.width / 2 + MAP_MIN_NODE_GAP,
          top: item.y - item.height / 2 - MAP_MIN_NODE_GAP,
          bottom: item.y + item.height / 2 + MAP_MIN_NODE_GAP,
        };

        return !(
          candidateBox.right < box.left ||
          candidateBox.left > box.right ||
          candidateBox.bottom < box.top ||
          candidateBox.top > box.bottom
        );
      });

      if (!overlaps) {
        return {
          x: Math.round(candidateX),
          y: Math.round(candidateY),
          width,
          height,
        };
      }
    }

    return {
      x: centerX,
      y: centerY,
      width,
      height,
    };
  }

  function estimateMapNodeWidth(label, size) {
    return Math.max(56, label.length * size * 10.5 + 18);
  }

  function estimateMapNodeHeight(size) {
    return Math.max(24, size * 25);
  }

  function buildGenreDescriptor(genre, nameById) {
    const tokenWeights = new Map();
    const relationIds = getMapConnectionIds(genre);
    const seedTerms = new Set();

    addWeightedTerms(tokenWeights, genre.id, 1.2);
    addWeightedTerms(tokenWeights, genre.name, 1.4);
    addWeightedTerms(tokenWeights, genre.aliases, 1.15);
    addWeightedTerms(tokenWeights, genre.spotifySeedGenres, 1.05);
    addWeightedTerms(tokenWeights, genre.spotifySearchTerms, 1.05);
    addWeightedTerms(tokenWeights, genre.description, 0.45);

    [genre.name, ...(genre.aliases ?? []), ...(genre.spotifySeedGenres ?? []), ...(genre.spotifySearchTerms ?? [])]
      .forEach(value => addTermsToSet(seedTerms, value));

    relationIds.forEach(id => {
      addWeightedTerms(tokenWeights, id, 0.8);
      addWeightedTerms(tokenWeights, nameById.get(id) ?? id, 0.95);
    });

    const tokenNorm = Math.sqrt(
      [...tokenWeights.values()].reduce((total, weight) => total + weight * weight, 0),
    ) || 1;

    const axisX =
      getAxisKeywordScore(tokenWeights, MAP_HORIZONTAL_POSITIVE) -
      getAxisKeywordScore(tokenWeights, MAP_HORIZONTAL_NEGATIVE) +
      getDeterministicJitter(genre.id, 0.12);
    const axisY =
      getAxisKeywordScore(tokenWeights, MAP_VERTICAL_POSITIVE) -
      getAxisKeywordScore(tokenWeights, MAP_VERTICAL_NEGATIVE) +
      getDeterministicJitter(`${genre.id}-vertical`, 0.12);

    return {
      id: genre.id,
      relationIds: new Set(relationIds),
      seedTerms,
      tokenNorm,
      tokenWeights,
      axisX,
      axisY,
    };
  }

  function addWeightedTerms(target, value, weight) {
    const values = Array.isArray(value) ? value : [value];

    values.forEach(entry => {
      if (!entry) {
        return;
      }

      const normalized = String(entry).toLowerCase().trim();

      if (!normalized) {
        return;
      }

      const collapsed = normalized.replace(/[^a-z0-9]+/g, '');
      if (collapsed.length > 1) {
        target.set(collapsed, (target.get(collapsed) ?? 0) + weight * 0.8);
      }

      normalized
        .split(/[^a-z0-9]+/)
        .filter(token => token.length > 1)
        .forEach(token => {
          target.set(token, (target.get(token) ?? 0) + weight);
        });
    });
  }

  function addTermsToSet(target, value) {
    const values = Array.isArray(value) ? value : [value];

    values.forEach(entry => {
      if (!entry) {
        return;
      }

      String(entry)
        .toLowerCase()
        .trim()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length > 1)
        .forEach(token => target.add(token));
    });
  }

  function getAxisKeywordScore(tokenWeights, keywords) {
    return keywords.reduce((total, keyword) => {
      const normalized = keyword.replace(/[^a-z0-9]+/g, '');
      return total + (tokenWeights.get(normalized) ?? tokenWeights.get(keyword) ?? 0);
    }, 0);
  }

  function getDeterministicJitter(seed, magnitude) {
    const normalized = (hashString(seed) % 2000) / 1000 - 1;
    return normalized * magnitude;
  }

  function projectMapPositions(genres, descriptors) {
    const basePoints = genres.map(genre => {
      const descriptor = descriptors.get(genre.id);

      return {
        id: genre.id,
        x: descriptor?.axisX ?? getDeterministicJitter(genre.id, 1),
        y: descriptor?.axisY ?? getDeterministicJitter(`${genre.id}-y`, 1),
      };
    });

    const normalizedBasePoints = normalizeProjectedPoints(basePoints);
    const positions = new Map(normalizedBasePoints.map(point => [point.id, { x: point.x, y: point.y }]));
    const anchors = new Map(normalizedBasePoints.map(point => [point.id, { x: point.x, y: point.y }]));
    const similarities = buildSimilarityMatrix(genres, descriptors);

    for (let iteration = 0; iteration < MAP_FORCE_ITERATIONS; iteration += 1) {
      const updates = new Map(genres.map(genre => [genre.id, { x: 0, y: 0 }]));

      for (let index = 0; index < genres.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < genres.length; otherIndex += 1) {
          const leftId = genres[index].id;
          const rightId = genres[otherIndex].id;
          const leftPoint = positions.get(leftId);
          const rightPoint = positions.get(rightId);
          const deltaX = rightPoint.x - leftPoint.x;
          const deltaY = rightPoint.y - leftPoint.y;
          const distance = Math.max(18, Math.hypot(deltaX, deltaY));
          const directionX = deltaX / distance;
          const directionY = deltaY / distance;
          const repulsion = 1800 / (distance * distance);
          const leftUpdate = updates.get(leftId);
          const rightUpdate = updates.get(rightId);

          leftUpdate.x -= directionX * repulsion;
          leftUpdate.y -= directionY * repulsion;
          rightUpdate.x += directionX * repulsion;
          rightUpdate.y += directionY * repulsion;

          const similarity = similarities[index][otherIndex];

          if (similarity > 0.025) {
            const targetDistance = 340 - similarity * 240;
            const attraction = (distance - targetDistance) * similarity * 0.018;

            leftUpdate.x += directionX * attraction;
            leftUpdate.y += directionY * attraction;
            rightUpdate.x -= directionX * attraction;
            rightUpdate.y -= directionY * attraction;
          }
        }
      }

      genres.forEach(genre => {
        const point = positions.get(genre.id);
        const anchor = anchors.get(genre.id);
        const update = updates.get(genre.id);

        update.x += (anchor.x - point.x) * 0.12;
        update.y += (anchor.y - point.y) * 0.12;

        point.x = clamp(point.x + clamp(update.x, -20, 20), MAP_LAYOUT_MARGIN_X, MAP_SURFACE_WIDTH - MAP_LAYOUT_MARGIN_X);
        point.y = clamp(
          point.y + clamp(update.y, -20, 20),
          MAP_LAYOUT_MARGIN_Y,
          MAP_SURFACE_HEIGHT - MAP_LAYOUT_MARGIN_Y,
        );
      });
    }

    return normalizeProjectedPoints(
      [...positions.entries()].map(([id, point]) => ({
        id,
        x: point.x,
        y: point.y,
      })),
    ).reduce((accumulator, point) => {
      accumulator.set(point.id, { x: point.x, y: point.y });
      return accumulator;
    }, new Map());
  }

  function normalizeProjectedPoints(points) {
    if (points.length === 0) {
      return [];
    }

    const xValues = points.map(point => point.x);
    const yValues = points.map(point => point.y);
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    const xRange = Math.max(1, maxX - minX);
    const yRange = Math.max(1, maxY - minY);
    const width = MAP_SURFACE_WIDTH - MAP_LAYOUT_MARGIN_X * 2;
    const height = MAP_SURFACE_HEIGHT - MAP_LAYOUT_MARGIN_Y * 2;

    return points.map(point => ({
      id: point.id,
      x: MAP_LAYOUT_MARGIN_X + ((point.x - minX) / xRange) * width,
      y: MAP_LAYOUT_MARGIN_Y + ((point.y - minY) / yRange) * height,
    }));
  }

  function buildSimilarityMatrix(genres, descriptors) {
    return genres.map((genre, index) => {
      const left = descriptors.get(genre.id);

      return genres.map((otherGenre, otherIndex) => {
        if (index === otherIndex) {
          return 1;
        }

        const right = descriptors.get(otherGenre.id);
        return getGenreSimilarity(left, right);
      });
    });
  }

  function getGenreSimilarity(left, right) {
    const textSimilarity = getWeightedCosineSimilarity(left.tokenWeights, left.tokenNorm, right.tokenWeights, right.tokenNorm);
    const relationSimilarity = getSetJaccard(left.relationIds, right.relationIds);
    const seedSimilarity = getSetJaccard(left.seedTerms, right.seedTerms);
    const directConnection =
      left.relationIds.has(right.id) || right.relationIds.has(left.id) ? 1 : 0;

    return clamp(
      textSimilarity * 0.45 +
        relationSimilarity * 0.2 +
        seedSimilarity * 0.15 +
        directConnection * 0.2,
      0,
      1,
    );
  }

  function getWeightedCosineSimilarity(leftWeights, leftNorm, rightWeights, rightNorm) {
    const [smaller, larger] =
      leftWeights.size <= rightWeights.size ? [leftWeights, rightWeights] : [rightWeights, leftWeights];
    let dot = 0;

    smaller.forEach((weight, token) => {
      dot += weight * (larger.get(token) ?? 0);
    });

    if (dot <= 0) {
      return 0;
    }

    return dot / (leftNorm * rightNorm);
  }

  function getSetJaccard(left, right) {
    if (left.size === 0 || right.size === 0) {
      return 0;
    }

    let intersection = 0;
    left.forEach(value => {
      if (right.has(value)) {
        intersection += 1;
      }
    });

    return intersection / (left.size + right.size - intersection);
  }

  function getGenreWeight(genre) {
    const relationCount = getMapConnectionIds(genre).length;
    return relationCount * 1.6 + Math.min((genre.tracks ?? []).length, 8) * 0.35;
  }

  function getMapConnectionIds(genre) {
    return [...new Set([...(genre.subgenres ?? []), ...(genre.similar ?? []), ...(genre.fusion ?? [])])];
  }

  function countVisibleMapConnections(genres) {
    const visibleIds = new Set(genres.map(genre => genre.id));
    const seenPairs = new Set();

    genres.forEach(genre => {
      getMapConnectionIds(genre).forEach(targetId => {
        if (!visibleIds.has(targetId)) {
          return;
        }

        const pairKey = [genre.id, targetId].sort().join('::');
        seenPairs.add(pairKey);
      });
    });

    return seenPairs.size;
  }

  function getMapZoom(key) {
    return state.mapZoom[key] ?? 1;
  }

  function getMapBaseZoom(key) {
    return state.mapBaseZoom[key] ?? 1;
  }

  function adjustMapZoom(key, delta) {
    setMapZoom(key, getMapZoom(key) + delta);
  }

  function resetMapZoom(key) {
    setMapZoom(key, getMapBaseZoom(key));
  }

  function getMapViewport(key) {
    return key === 'modal' ? elements.mapModalCanvas : elements.mapCanvas;
  }

  function getFitMapZoom(key) {
    const viewport = getMapViewport(key);

    if (!viewport) {
      return 1;
    }

    const widthRatio = (viewport.clientWidth - MAP_INSPECTOR_MARGIN * 2) / MAP_SURFACE_WIDTH;
    const heightRatio = (viewport.clientHeight - MAP_INSPECTOR_MARGIN * 2) / MAP_SURFACE_HEIGHT;

    return clamp(Math.min(widthRatio, heightRatio, 1), MAP_MIN_ZOOM, MAP_MAX_ZOOM);
  }

  function centerViewportOnMap(viewport) {
    if (!viewport) {
      return;
    }

    viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
    viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
  }

  function fitMapToViewport(key) {
    const viewport = getMapViewport(key);

    if (!viewport) {
      return;
    }

    window.requestAnimationFrame(() => {
      const fitZoom = Math.round(getFitMapZoom(key) * 100) / 100;

      state.mapBaseZoom[key] = fitZoom;
      state.mapZoom[key] = fitZoom;
      renderGenreMap();

      window.requestAnimationFrame(() => {
        centerViewportOnMap(viewport);
        updateMapZoomUI(key);
      });
    });
  }

  function setMapZoom(key, nextZoom) {
    const viewport = getMapViewport(key);
    const clampedZoom = clamp(
      Math.round(nextZoom * 100) / 100,
      Math.max(MAP_MIN_ZOOM, getMapBaseZoom(key)),
      MAP_MAX_ZOOM,
    );
    const previousZoom = getMapZoom(key);

    if (Math.abs(clampedZoom - previousZoom) < 0.001) {
      updateMapZoomUI(key);
      return;
    }

    const centerX = viewport ? viewport.scrollLeft + viewport.clientWidth / 2 : 0;
    const centerY = viewport ? viewport.scrollTop + viewport.clientHeight / 2 : 0;
    const ratio = clampedZoom / previousZoom;

    state.mapZoom[key] = clampedZoom;
    renderGenreMap();

    if (viewport) {
      window.requestAnimationFrame(() => {
        viewport.scrollLeft = Math.max(0, centerX * ratio - viewport.clientWidth / 2);
        viewport.scrollTop = Math.max(0, centerY * ratio - viewport.clientHeight / 2);
        updateMapZoomUI(key);
      });
    } else {
      updateMapZoomUI(key);
    }
  }

  function updateMapZoomUI(key) {
    const label = key === 'modal' ? elements.mapModalZoomLevel : elements.mapZoomLevel;

    if (label) {
      label.textContent = `${Math.round((getMapZoom(key) / getMapBaseZoom(key)) * 100)}%`;
    }
  }

  function selectMapGenre(genreId, options = {}) {
    showView('map', options);
    setActiveNav(elements.navMap);
    const selectionTask = showGenre(genreId);

    if (options.openInspector) {
      void Promise.resolve(selectionTask).then(() => {
        openMapInspector(options.anchorPoint);
      });
    }
  }

  function getStagePointFromEvent(event) {
    const container = elements.mapStageBody;

    if (!container) {
      return null;
    }

    const rect = container.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function openMapInspector(anchorPoint = null) {
    const nextAnchor = state.mapInspector.isOpen ? null : anchorPoint;
    state.mapInspector.isOpen = true;
    updateMapInspectorUI(nextAnchor);
  }

  function closeMapInspector() {
    state.mapInspector.isOpen = false;
    updateMapInspectorUI();
  }

  function updateMapInspectorUI(anchorPoint = null) {
    const inspector = elements.mapInspector;

    if (!inspector) {
      return;
    }

    inspector.classList.toggle('is-hidden', !state.mapInspector.isOpen);
    inspector.setAttribute('aria-hidden', String(!state.mapInspector.isOpen));

    if (!state.mapInspector.isOpen) {
      return;
    }

    window.requestAnimationFrame(() => {
      positionMapInspector(anchorPoint);
    });
  }

  function positionMapInspector(anchorPoint = null) {
    const inspector = elements.mapInspector;
    const container = elements.mapStageBody;

    if (!inspector || !container) {
      return;
    }

    const nextX = anchorPoint ? anchorPoint.x + 18 : state.mapInspector.x;
    const nextY = anchorPoint ? anchorPoint.y + 18 : state.mapInspector.y;
    const clamped = clampMapInspectorPosition(nextX, nextY);

    state.mapInspector.x = clamped.x;
    state.mapInspector.y = clamped.y;
    inspector.style.left = `${clamped.x}px`;
    inspector.style.top = `${clamped.y}px`;
  }

  function clampMapInspectorPosition(nextX, nextY) {
    const inspector = elements.mapInspector;
    const container = elements.mapStageBody;

    if (!inspector || !container) {
      return { x: nextX, y: nextY };
    }

    const maxX = Math.max(
      MAP_INSPECTOR_MARGIN,
      container.clientWidth - inspector.offsetWidth - MAP_INSPECTOR_MARGIN,
    );
    const maxY = Math.max(
      MAP_INSPECTOR_MARGIN,
      container.clientHeight - inspector.offsetHeight - MAP_INSPECTOR_MARGIN,
    );

    return {
      x: clamp(Math.round(nextX), MAP_INSPECTOR_MARGIN, maxX),
      y: clamp(Math.round(nextY), MAP_INSPECTOR_MARGIN, maxY),
    };
  }

  function bindMapInspector() {
    const handle = elements.mapInspectorHead;
    const inspector = elements.mapInspector;

    if (!handle || !inspector) {
      return;
    }

    let isDragging = false;
    let originX = 0;
    let originY = 0;
    let startX = 0;
    let startY = 0;

    handle.addEventListener('pointerdown', event => {
      if (!state.mapInspector.isOpen || event.target.closest('button')) {
        return;
      }

      isDragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originX = state.mapInspector.x;
      originY = state.mapInspector.y;
      inspector.classList.add('is-dragging');
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    handle.addEventListener('pointermove', event => {
      if (!isDragging) {
        return;
      }

      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      const nextPosition = clampMapInspectorPosition(originX + deltaX, originY + deltaY);

      state.mapInspector.x = nextPosition.x;
      state.mapInspector.y = nextPosition.y;
      inspector.style.left = `${nextPosition.x}px`;
      inspector.style.top = `${nextPosition.y}px`;
    });

    const stopDragging = event => {
      if (!isDragging) {
        return;
      }

      isDragging = false;
      inspector.classList.remove('is-dragging');

      if (event?.pointerId !== undefined && handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    };

    handle.addEventListener('pointerup', stopDragging);
    handle.addEventListener('pointercancel', stopDragging);
    window.addEventListener('resize', () => {
      if (state.mapInspector.isOpen) {
        updateMapInspectorUI();
      }
    });
  }

  function bindMapViewport(viewport, key) {
    if (!viewport) {
      return;
    }

    if (!resizeBound) {
      resizeBound = true;
      window.addEventListener('resize', () => {
        if (state.currentView === 'map') {
          fitMapToViewport('main');
        }
      });
    }

    let isDragging = false;
    let pendingDrag = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    viewport.addEventListener('pointerdown', event => {
      if (event.target.closest('.map-node')) {
        return;
      }

      pendingDrag = true;
      isDragging = false;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = viewport.scrollLeft;
      startTop = viewport.scrollTop;
    });

    viewport.addEventListener('pointermove', event => {
      if (!pendingDrag && !isDragging) {
        return;
      }

      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;

      if (!isDragging) {
        if (Math.hypot(deltaX, deltaY) < MAP_DRAG_THRESHOLD) {
          return;
        }

        isDragging = true;
        pendingDrag = false;
        viewport.classList.add('is-dragging');
        viewport.setPointerCapture(event.pointerId);
      }

      viewport.scrollLeft = startLeft - deltaX;
      viewport.scrollTop = startTop - deltaY;
    });

    const stopDragging = event => {
      if (!isDragging && !pendingDrag) {
        return;
      }

      pendingDrag = false;
      isDragging = false;
      viewport.classList.remove('is-dragging');

      if (event?.pointerId !== undefined && viewport.hasPointerCapture(event.pointerId)) {
        viewport.releasePointerCapture(event.pointerId);
      }
    };

    viewport.addEventListener('pointerup', stopDragging);
    viewport.addEventListener('pointercancel', stopDragging);
    viewport.addEventListener('mouseleave', stopDragging);
    viewport.addEventListener(
      'wheel',
      event => {
        if (!event.ctrlKey && !event.metaKey) {
          return;
        }

        event.preventDefault();
        adjustMapZoom(key, event.deltaY < 0 ? MAP_ZOOM_STEP : -MAP_ZOOM_STEP);
      },
      { passive: false },
    );
    viewport.dataset.mapViewportKey = key;
  }

  function ensureMapViewportReady(key) {
    const viewport = getMapViewport(key);

    if (!viewport || state.mapViewportReady[key]) {
      return;
    }

    state.mapViewportReady[key] = true;
    window.requestAnimationFrame(() => {
      centerViewportOnMap(viewport);

      if (key === 'modal' && state.currentGenreId) {
        centerViewportOnGenre(viewport, state.currentGenreId);
      }
    });
  }

  function centerViewportOnGenre(viewport, genreId) {
    const item = state.mapLayoutById.get(genreId);

    if (!viewport || !item) {
      return;
    }

    viewport.scrollLeft = clamp(
      item.x * getMapZoom(viewport === elements.mapModalCanvas ? 'modal' : 'main') -
        viewport.clientWidth / 2,
      0,
      Math.max(0, viewport.scrollWidth - viewport.clientWidth),
    );
    viewport.scrollTop = clamp(
      item.y * getMapZoom(viewport === elements.mapModalCanvas ? 'modal' : 'main') -
        viewport.clientHeight / 2,
      0,
      Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    );
  }

  function openMapModal() {
    if (!elements.mapModal) {
      return;
    }

    elements.mapModal.classList.add('is-open');
    elements.mapModal.setAttribute('aria-hidden', 'false');
    renderGenreMap();
    window.requestAnimationFrame(() => {
      if (state.currentGenreId) {
        centerViewportOnGenre(elements.mapModalCanvas, state.currentGenreId);
      } else {
        ensureMapViewportReady('modal');
      }
    });
  }

  function closeMapModal() {
    if (!elements.mapModal) {
      return;
    }

    elements.mapModal.classList.remove('is-open');
    elements.mapModal.setAttribute('aria-hidden', 'true');
  }

  function openMapView(options = {}) {
    showView('map', options);
    setActiveNav(elements.navMap);
    renderGenreMap();
    closeMapInspector();
    fitMapToViewport('main');

    if (!state.currentGenreId && state.filteredGenres.length > 0) {
      void showGenre(state.filteredGenres[0].id);
      return;
    }
  }

  return {
    adjustMapZoom,
    bindMapInspector,
    bindMapViewport,
    closeMapInspector,
    closeMapModal,
    openMapModal,
    openMapView,
    renderGenreMap,
    renderMapSelection,
    resetMapZoom,
    setMapZoom,
  };
}

export { createMapPage };
