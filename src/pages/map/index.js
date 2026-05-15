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
const MAP_CORE_RADIUS_MIN = 0.24;
const MAP_CORE_RADIUS_MAX = 0.64;
const MAP_DERIVED_RADIUS_MIN = 0.58;
const MAP_DERIVED_RADIUS_MAX = 1.04;
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
  let cachedLayoutSignature = '';
  let cachedLayout = [];

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
      cachedLayoutSignature = '';
      cachedLayout = [];
      state.mapLayoutById = new Map();
      renderMapSelection(null);
      closeMapInspector();
      return;
    }

    const layoutSignature = getMapLayoutSignature(visibleGenres);
    const layout =
      layoutSignature === cachedLayoutSignature
        ? cachedLayout
        : buildMapLayout(visibleGenres);

    if (layoutSignature !== cachedLayoutSignature) {
      cachedLayoutSignature = layoutSignature;
      cachedLayout = layout;
    }

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

  function getMapCoreGenreIds(genres) {
    const derivedIds = new Set();

    genres.forEach(genre => {
      (genre.subgenres ?? []).forEach(id => derivedIds.add(id));
      (genre.fusion ?? []).forEach(id => derivedIds.add(id));
    });

    const coreIds = genres
      .filter(genre => !derivedIds.has(genre.id))
      .map(genre => genre.id);

    if (coreIds.length > 0) {
      return new Set(coreIds);
    }

    return new Set(
      [...genres]
        .sort((left, right) => {
          return getGenreWeight(right) - getGenreWeight(left) || left.name.localeCompare(right.name);
        })
        .slice(0, Math.min(8, Math.max(3, Math.ceil(genres.length / 4))))
        .map(genre => genre.id),
    );
  }

  function buildMapDepthContext(genres, coreIds) {
    const parentIdsById = new Map(genres.map(genre => [genre.id, []]));
    const relationKindsById = new Map(genres.map(genre => [genre.id, new Set()]));

    genres.forEach(genre => {
      (genre.subgenres ?? []).forEach(childId => {
        if (!parentIdsById.has(childId)) {
          return;
        }

        parentIdsById.get(childId).push(genre.id);
        relationKindsById.get(childId).add('subgenre');
      });

      (genre.fusion ?? []).forEach(childId => {
        if (!parentIdsById.has(childId)) {
          return;
        }

        parentIdsById.get(childId).push(genre.id);
        relationKindsById.get(childId).add('fusion');
      });
    });

    const depthById = new Map();

    function resolveDepth(genreId, stack = new Set()) {
      if (depthById.has(genreId)) {
        return depthById.get(genreId);
      }

      if (coreIds.has(genreId) || stack.has(genreId)) {
        depthById.set(genreId, 0);
        return 0;
      }

      const parentIds = parentIdsById.get(genreId) ?? [];
      if (parentIds.length === 0) {
        depthById.set(genreId, 0);
        return 0;
      }

      stack.add(genreId);
      const depth = 1 + Math.min(...parentIds.map(parentId => resolveDepth(parentId, stack)));
      stack.delete(genreId);
      depthById.set(genreId, depth);
      return depth;
    }

    genres.forEach(genre => {
      resolveDepth(genre.id);
    });

    return {
      depthById,
      relationKindsById,
    };
  }

  function projectMapPositions(genres, descriptors) {
    const axisPoints = normalizeAxisPoints(
      genres.map(genre => {
        const descriptor = descriptors.get(genre.id);

        return {
          id: genre.id,
          x: descriptor?.axisX ?? getDeterministicJitter(genre.id, 1),
          y: descriptor?.axisY ?? getDeterministicJitter(`${genre.id}-y`, 1),
        };
      }),
    );
    const coreIds = getMapCoreGenreIds(genres);
    const { depthById, relationKindsById } = buildMapDepthContext(genres, coreIds);
    const centerX = MAP_SURFACE_WIDTH / 2;
    const centerY = MAP_SURFACE_HEIGHT / 2;
    const radiusX = (MAP_SURFACE_WIDTH - MAP_LAYOUT_MARGIN_X * 2) / 2;
    const radiusY = (MAP_SURFACE_HEIGHT - MAP_LAYOUT_MARGIN_Y * 2) / 2;

    return axisPoints.reduce((accumulator, point) => {
      const isCore = coreIds.has(point.id);
      const depth = depthById.get(point.id) ?? 0;
      const relationKinds = relationKindsById.get(point.id) ?? new Set();
      const axisRadius = clamp(Math.hypot(point.x, point.y), 0, 1.2);
      const baseAngle =
        axisRadius > 0.04
          ? Math.atan2(point.y, point.x)
          : (hashString(`${point.id}-angle`) % 360) * (Math.PI / 180);
      const angle = baseAngle + getDeterministicJitter(`${point.id}-angle`, isCore ? 0.18 : 0.12);
      const radialBias = relationKinds.has('fusion') ? 0.08 : relationKinds.has('subgenre') ? -0.02 : 0;
      const targetRadius = isCore
        ? clamp(0.18 + axisRadius * 0.42, MAP_CORE_RADIUS_MIN, MAP_CORE_RADIUS_MAX)
        : clamp(
            0.56 + axisRadius * 0.24 + depth * 0.13 + radialBias,
            MAP_DERIVED_RADIUS_MIN,
            MAP_DERIVED_RADIUS_MAX,
          );
      const spreadX = Math.cos(angle) * targetRadius;
      const spreadY = Math.sin(angle) * targetRadius * 0.92;

      accumulator.set(point.id, {
        x: clamp(centerX + spreadX * radiusX, MAP_LAYOUT_MARGIN_X, MAP_SURFACE_WIDTH - MAP_LAYOUT_MARGIN_X),
        y: clamp(centerY + spreadY * radiusY, MAP_LAYOUT_MARGIN_Y, MAP_SURFACE_HEIGHT - MAP_LAYOUT_MARGIN_Y),
      });
      return accumulator;
    }, new Map());
  }

  function normalizeAxisPoints(points) {
    if (points.length === 0) {
      return [];
    }

    const maxAbsX = Math.max(...points.map(point => Math.abs(point.x)), 0.01);
    const maxAbsY = Math.max(...points.map(point => Math.abs(point.y)), 0.01);

    return points.map(point => ({
      id: point.id,
      x: clamp(point.x / maxAbsX, -1, 1),
      y: clamp(point.y / maxAbsY, -1, 1),
    }));
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

  function getMapLayoutSignature(genres) {
    return genres
      .map(genre => {
        return `${genre.id}:${getMapConnectionIds(genre).length}:${(genre.tracks ?? []).length}`;
      })
      .join('|');
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
