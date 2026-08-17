"use strict";

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const monthOrder = new Map(monthNames.map((month, index) => [month.toLowerCase(), index]));
const FAVORITES_STORAGE_KEY = "beatz-favorites-v1";
const STATS_PAGE_SIZE = 10;
const MAX_STATS_RANK = 100;

const state = {
  tracks: [],
  artwork: [],
  artworkDeck: [],
  currentArtwork: null,
  trackById: new Map(),
  currentTrack: null,
  queue: [],
  queueSource: [],
  queueIndex: -1,
  shuffle: false,
  repeat: false,
  favoriteIDs: [],
  explorePath: [],
  currentFolderTracks: [],
  searchResults: [],
  seeking: false,
  toastTimer: 0,
  playerExpanded: false,
  playerExpandInvoker: null,
  playerTouch: null,
  playSession: null,
  stats: {
    scope: "all",
    period: "",
    rankings: [],
    periods: { years: [], months: [] },
    totalPlays: 0,
    totalTracks: 0,
    hasMore: false,
    status: "idle",
    requestID: 0,
    retryAppend: false,
  },
};

const elements = {
  audio: document.querySelector("#audio"),
  body: document.body,
  siteHeader: document.querySelector(".site-header"),
  skipLink: document.querySelector(".skip-link"),
  pages: {
    home: document.querySelector("#home-page"),
    explore: document.querySelector("#explore-page"),
    search: document.querySelector("#search-page"),
    favorites: document.querySelector("#favorites-page"),
    stats: document.querySelector("#stats-page"),
  },
  main: document.querySelector("#main-content"),
  fatalError: document.querySelector("#fatal-error"),
  retryLibrary: document.querySelector("#retry-library"),
  shuffleAll: document.querySelector("#shuffle-all"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  folderToolbar: document.querySelector("#folder-toolbar"),
  folderTrackCount: document.querySelector("#folder-track-count"),
  shuffleFolder: document.querySelector("#shuffle-folder"),
  folderGrid: document.querySelector("#folder-grid"),
  exploreTrackSection: document.querySelector("#explore-track-section"),
  exploreTrackList: document.querySelector("#explore-track-list"),
  searchInput: document.querySelector("#search-input"),
  clearSearch: document.querySelector("#clear-search"),
  searchMeta: document.querySelector("#search-meta"),
  searchResults: document.querySelector("#search-results"),
  favoritesCount: document.querySelector("#favorites-count"),
  favoritesEmpty: document.querySelector("#favorites-empty"),
  favoritesEmptyTitle: document.querySelector("#favorites-empty-title"),
  favoritesEmptyCopy: document.querySelector("#favorites-empty-copy"),
  favoritesTrackSection: document.querySelector("#favorites-track-section"),
  favoritesTrackList: document.querySelector("#favorites-track-list"),
  shuffleFavorites: document.querySelector("#shuffle-favorites"),
  statsScopeButtons: [...document.querySelectorAll("[data-stats-scope]")],
  statsPeriodControl: document.querySelector("#stats-period-control"),
  statsPeriodLabel: document.querySelector("#stats-period-label"),
  statsPeriod: document.querySelector("#stats-period"),
  topYear: document.querySelector("#top-year"),
  topYearPeriod: document.querySelector("#top-year-period"),
  topYearPlays: document.querySelector("#top-year-plays"),
  topMonth: document.querySelector("#top-month"),
  topMonthPeriod: document.querySelector("#top-month-period"),
  topMonthPlays: document.querySelector("#top-month-plays"),
  statsSummary: document.querySelector("#stats-summary"),
  statsLoading: document.querySelector("#stats-loading"),
  statsLoadingCopy: document.querySelector("#stats-loading-copy"),
  statsEmpty: document.querySelector("#stats-empty"),
  statsEmptyCopy: document.querySelector("#stats-empty-copy"),
  statsError: document.querySelector("#stats-error"),
  retryStats: document.querySelector("#retry-stats"),
  statsRankings: document.querySelector("#stats-rankings"),
  statsTrackList: document.querySelector("#stats-track-list"),
  statsLoadMoreRow: document.querySelector(".stats-load-more"),
  statsLoadMore: document.querySelector("#stats-load-more"),
  player: document.querySelector("#player"),
  playerArt: document.querySelector(".player-art"),
  playerArtwork: document.querySelector("#player-artwork"),
  expandPlayer: document.querySelector("#expand-player"),
  desktopExpandPlayer: document.querySelector("#desktop-expand-player"),
  collapsePlayer: document.querySelector("#collapse-player"),
  playerTitle: document.querySelector("#player-title"),
  marqueeClone: document.querySelector("#marquee-clone"),
  titleMarquee: document.querySelector("#title-marquee"),
  playerMeta: document.querySelector("#player-meta"),
  playerFavorite: document.querySelector("#player-favorite"),
  playerShuffle: document.querySelector("#player-shuffle"),
  playerRepeat: document.querySelector("#player-repeat"),
  previousTrack: document.querySelector("#previous-track"),
  playPause: document.querySelector("#play-pause"),
  nextTrack: document.querySelector("#next-track"),
  seek: document.querySelector("#seek"),
  currentTime: document.querySelector("#current-time"),
  duration: document.querySelector("#duration"),
  volume: document.querySelector("#volume"),
  toast: document.querySelector("#toast"),
};

function svgIcon(symbol, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (className) svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${symbol}`);
  svg.append(use);
  return svg;
}

function normalize(value) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = String(wholeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function setRangeProgress(input, ratio) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  input.style.setProperty("--range-progress", `${clamped * 100}%`);
}

function getStoredValue(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function createSessionID() {
  if (typeof window.crypto?.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  if (typeof window.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatStatsPeriod(value, scope) {
  if (scope !== "month") return value;
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = monthNames[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : value;
}

function startsWithPath(track, segments) {
  const directorySegments = track.directory ? track.directory.split("/") : [];
  return segments.every((segment, index) => directorySegments[index] === segment);
}

function uniqueTrackIDs(tracks) {
  return [...new Set(tracks.map((track) => track.id))];
}

function shuffled(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function sortFolderNames(names) {
  return [...names].sort((left, right) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) {
      return rightNumber - leftNumber;
    }
    const leftMonth = monthOrder.get(left.toLowerCase());
    const rightMonth = monthOrder.get(right.toLowerCase());
    if (leftMonth !== undefined && rightMonth !== undefined) {
      return rightMonth - leftMonth;
    }
    return collator.compare(left, right);
  });
}

function folderHash(segments) {
  if (!segments.length) return "#explore";
  return `#explore/${segments.map(encodeURIComponent).join("/")}`;
}

function navigate(view, segments = []) {
  const nextHash = view === "explore" ? folderHash(segments) : `#${view}`;
  if (window.location.hash === nextHash) {
    applyRoute();
  } else {
    window.location.hash = nextHash;
  }
}

function parseRoute() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw || raw === "home") return { view: "home", segments: [] };
  if (raw === "search") return { view: "search", segments: [] };
  if (raw === "favorites") return { view: "favorites", segments: [] };
  if (raw === "stats") return { view: "stats", segments: [] };
  if (raw === "explore") return { view: "explore", segments: [] };
  if (raw.startsWith("explore/")) {
    const segments = raw
      .slice("explore/".length)
      .split("/")
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .filter(Boolean);
    return { view: "explore", segments };
  }
  return { view: "home", segments: [] };
}

function applyRoute() {
  if (!state.tracks.length) return;
  const route = parseRoute();
  const previousPage = document.querySelector(".page.is-active");
  const nextPage = elements.pages[route.view];

  for (const [view, page] of Object.entries(elements.pages)) {
    const active = view === route.view;
    page.hidden = !active;
    page.classList.toggle("is-active", active);
  }
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === route.view;
    button.classList.toggle("is-active", active);
    if (button.classList.contains("nav-link")) {
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });

  if (route.view === "explore") {
    renderExplore(route.segments);
  } else if (route.view === "search") {
    window.requestAnimationFrame(() => elements.searchInput.focus({ preventScroll: true }));
  } else if (route.view === "favorites") {
    renderFavorites();
  } else if (route.view === "stats") {
    renderStatsPage(previousPage !== nextPage);
  }

  if (route.view !== "search" && (previousPage !== nextPage || route.view === "explore")) {
    const focusTarget = nextPage.querySelector("h1") || elements.main;
    focusTarget.tabIndex = -1;
    window.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
  }

  if (previousPage !== nextPage) {
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}


function renderExplore(requestedSegments) {
  let segments = [...requestedSegments];
  const requestedTracks = state.tracks.filter((track) => startsWithPath(track, segments));
  if (segments.length && !requestedTracks.length) {
    segments = [];
    if (window.location.hash !== "#explore") {
      window.history.replaceState(null, "", "#explore");
    }
  }
  state.explorePath = segments;

  renderBreadcrumbs(segments);

  const recursiveTracks = state.tracks.filter((track) => startsWithPath(track, segments));
  state.currentFolderTracks = recursiveTracks;
  const directTracks = recursiveTracks
    .filter((track) => {
      const directorySegments = track.directory ? track.directory.split("/") : [];
      return directorySegments.length === segments.length;
    })
    .sort((left, right) => collator.compare(left.title, right.title));

  const childNames = new Set();
  recursiveTracks.forEach((track) => {
    const directorySegments = track.directory ? track.directory.split("/") : [];
    if (directorySegments.length > segments.length) {
      childNames.add(directorySegments[segments.length]);
    }
  });

  const folderFragment = document.createDocumentFragment();
  sortFolderNames(childNames).forEach((name) => {
    const childPath = [...segments, name];
    const count = state.tracks.filter((track) => startsWithPath(track, childPath)).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-card";
    button.setAttribute("aria-label", `Open ${name}, ${plural(count, "beat")}`);
    button.append(svgIcon("folder", "folder-icon"));

    const title = document.createElement("strong");
    title.textContent = name;
    const metadata = document.createElement("small");
    metadata.textContent = plural(count, "beat");
    button.append(title, metadata);
    button.addEventListener("click", () => navigate("explore", childPath));
    folderFragment.append(button);
  });
  elements.folderGrid.replaceChildren(folderFragment);
  elements.folderGrid.hidden = childNames.size === 0;

  elements.folderToolbar.hidden = segments.length === 0 || recursiveTracks.length === 0;
  elements.folderTrackCount.textContent = plural(recursiveTracks.length, "beat");
  elements.shuffleFolder.disabled = recursiveTracks.length === 0;

  elements.exploreTrackSection.hidden = directTracks.length === 0;
  renderTrackList(elements.exploreTrackList, directTracks, directTracks);
}

function renderBreadcrumbs(segments) {
  const fragment = document.createDocumentFragment();
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = "breadcrumb-button";
  rootButton.textContent = "Archive";
  rootButton.addEventListener("click", () => navigate("explore"));
  if (!segments.length) rootButton.setAttribute("aria-current", "page");
  fragment.append(rootButton);

  segments.forEach((segment, index) => {
    fragment.append(svgIcon("chevron"));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "breadcrumb-button";
    button.textContent = segment;
    if (index === segments.length - 1) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => navigate("explore", segments.slice(0, index + 1)));
    fragment.append(button);
  });

  elements.breadcrumbs.replaceChildren(fragment);
  window.requestAnimationFrame(() => {
    elements.breadcrumbs.scrollLeft = elements.breadcrumbs.scrollWidth;
  });
}

function createTrackRow(track, index, contextTracks, options = {}) {
  const rank = options.rank ?? index + 1;
  const hasPlayCount = Number.isFinite(options.plays);
  const folderLabel = track.directory.split("/").join(" / ") || "Archive";
  const trackLabel = hasPlayCount
    ? `${track.title}, ${folderLabel}, rank ${rank}, ${plural(options.plays, "play")}`
    : `${track.title}, ${folderLabel}`;
  const row = document.createElement("button");
  row.type = "button";
  row.className = "track-row";
  row.classList.toggle("stats-track-row", hasPlayCount);
  row.dataset.trackId = track.id;
  row.dataset.trackLabel = trackLabel;
  row.setAttribute("aria-label", `Play ${trackLabel}`);

  const number = document.createElement("span");
  number.className = "track-number";
  const numberText = document.createElement("span");
  numberText.textContent = String(rank);
  number.append(numberText, svgIcon("play"));

  const primary = document.createElement("span");
  primary.className = "track-primary";
  const title = document.createElement("strong");
  title.textContent = track.title;
  title.title = track.title;
  const mobileFolder = document.createElement("small");
  mobileFolder.textContent = folderLabel;
  primary.append(title, mobileFolder);

  const folder = document.createElement("span");
  folder.className = "track-folder";
  folder.textContent = folderLabel;
  folder.title = track.directory;

  const action = document.createElement("span");
  if (hasPlayCount) {
    action.className = "track-plays";
    action.textContent = options.plays.toLocaleString();
  } else {
    action.className = "row-action";
    action.append(svgIcon("play"));
  }

  row.append(number, primary, folder, action);
  row.addEventListener("click", () => {
    if (state.currentTrack?.id === track.id) {
      togglePlayback();
    } else {
      playFromContext(track, contextTracks);
    }
  });
  return row;
}

function renderTrackList(container, tracks, contextTracks) {
  const fragment = document.createDocumentFragment();
  tracks.forEach((track, index) => fragment.append(createTrackRow(track, index, contextTracks)));
  container.replaceChildren(fragment);
  updateTrackRows();
}

function loadFavorites() {
  const stored = getStoredValue(FAVORITES_STORAGE_KEY);
  if (stored === null) {
    setStoredValue(FAVORITES_STORAGE_KEY, "[]");
    return;
  }
  try {
    const values = JSON.parse(stored);
    state.favoriteIDs = Array.isArray(values)
      ? [...new Set(values.filter((value) => typeof value === "string"))]
      : [];
  } catch {
    state.favoriteIDs = [];
  }
  setStoredValue(FAVORITES_STORAGE_KEY, JSON.stringify(state.favoriteIDs));
}

function persistFavorites() {
  return setStoredValue(FAVORITES_STORAGE_KEY, JSON.stringify(state.favoriteIDs));
}

function availableFavoriteTracks() {
  return state.favoriteIDs
    .map((trackID) => state.trackById.get(trackID))
    .filter(Boolean);
}

function updateFavoriteUI() {
  const track = state.currentTrack;
  const isFavorite = Boolean(track && state.favoriteIDs.includes(track.id));
  elements.playerFavorite.disabled = !track;
  elements.playerFavorite.setAttribute("aria-pressed", String(isFavorite));
  elements.playerFavorite.setAttribute(
    "aria-label",
    track
      ? `${isFavorite ? "Remove" : "Add"} ${track.title} ${isFavorite ? "from" : "to"} favorites`
      : "Add current beat to favorites",
  );
}

function renderFavorites() {
  const tracks = availableFavoriteTracks();
  elements.favoritesCount.textContent = plural(tracks.length, "beat");
  elements.shuffleFavorites.disabled = tracks.length === 0;
  elements.favoritesEmpty.hidden = tracks.length !== 0;
  elements.favoritesTrackSection.hidden = tracks.length === 0;
  const hasUnavailableFavorites = tracks.length === 0 && state.favoriteIDs.length > 0;
  elements.favoritesEmptyTitle.textContent = hasUnavailableFavorites
    ? "No saved favorites are available."
    : "No favorites yet.";
  elements.favoritesEmptyCopy.textContent = hasUnavailableFavorites
    ? "Unavailable beats stay saved and will return here if they come back."
    : "Use the star in the player to keep beats here.";
  if (tracks.length) {
    renderTrackList(elements.favoritesTrackList, tracks, tracks);
  } else {
    elements.favoritesTrackList.replaceChildren();
  }
}

function toggleFavorite() {
  const track = state.currentTrack;
  if (!track) return;
  const index = state.favoriteIDs.indexOf(track.id);
  const adding = index === -1;
  if (adding) {
    state.favoriteIDs.push(track.id);
  } else {
    state.favoriteIDs.splice(index, 1);
  }
  const saved = persistFavorites();
  updateFavoriteUI();
  if (!elements.pages.favorites.hidden) renderFavorites();
  const action = adding ? "Added to favorites" : "Removed from favorites";
  showToast(saved ? action : `${action} for this visit`);
}

function shuffleFavoriteTracks() {
  shuffleAndPlay(availableFavoriteTracks());
}

function statsPeriodEntries(scope = state.stats.scope) {
  if (scope === "year") return state.stats.periods.years;
  if (scope === "month") return state.stats.periods.months;
  return [];
}

function statsPeriodValue(entry, scope) {
  return scope === "year" ? entry.year : entry.month;
}

function updateStatsControls() {
  elements.statsScopeButtons.forEach((button) => {
    const scope = button.dataset.statsScope;
    const active = scope === state.stats.scope;
    button.setAttribute("aria-pressed", String(active));
    button.disabled = scope !== "all" && statsPeriodEntries(scope).length === 0;
  });

  const usesPeriod = state.stats.scope !== "all";
  elements.statsPeriodControl.hidden = !usesPeriod;
  if (!usesPeriod) {
    elements.statsPeriod.replaceChildren();
    elements.statsPeriod.disabled = true;
    return;
  }

  const entries = statsPeriodEntries();
  const values = entries.map((entry) => statsPeriodValue(entry, state.stats.scope));
  if (!values.includes(state.stats.period)) {
    state.stats.period = values[0] || "";
  }
  const options = document.createDocumentFragment();
  entries.forEach((entry) => {
    const value = statsPeriodValue(entry, state.stats.scope);
    const option = document.createElement("option");
    option.value = value;
    option.textContent = formatStatsPeriod(value, state.stats.scope);
    options.append(option);
  });
  elements.statsPeriod.replaceChildren(options);
  elements.statsPeriod.value = state.stats.period;
  elements.statsPeriod.disabled = entries.length === 0;
  elements.statsPeriodLabel.textContent = state.stats.scope === "year" ? "Year" : "Month";
}

function updateStatsHighlights() {
  const highlights = [
    {
      scope: "year",
      entry: state.stats.periods.years[0],
      button: elements.topYear,
      period: elements.topYearPeriod,
      plays: elements.topYearPlays,
    },
    {
      scope: "month",
      entry: state.stats.periods.months[0],
      button: elements.topMonth,
      period: elements.topMonthPeriod,
      plays: elements.topMonthPlays,
    },
  ];

  highlights.forEach(({ scope, entry, button, period, plays }) => {
    button.disabled = !entry;
    if (!entry) {
      period.textContent = "—";
      plays.textContent = "No plays";
      button.setAttribute("aria-label", `No top ${scope} yet`);
      return;
    }
    const value = statsPeriodValue(entry, scope);
    const label = formatStatsPeriod(value, scope);
    const playCount = Number(entry.plays);
    period.textContent = label;
    plays.textContent = plural(playCount, "play");
    button.setAttribute("aria-label", `Show ${label}, top ${scope}, ${plural(playCount, "play")}`);
  });
}

function renderStatsRankings() {
  const rows = state.stats.rankings
    .map((ranking, index) => ({
      index,
      ranking,
      track: state.trackById.get(ranking.trackId),
    }))
    .filter(({ track }) => Boolean(track));
  const contextTracks = rows.map(({ track }) => track);
  const fragment = document.createDocumentFragment();
  rows.forEach(({ index, ranking, track }) => {
    fragment.append(createTrackRow(track, index, contextTracks, {
      rank: index + 1,
      plays: Number(ranking.plays),
    }));
  });
  elements.statsTrackList.replaceChildren(fragment);
  updateTrackRows();
}

function renderStatsState() {
  updateStatsControls();
  updateStatsHighlights();

  const status = state.stats.status;
  const hasRows = state.stats.rankings.length > 0;
  const loading = status === "loading" || status === "loading-more";
  elements.statsLoading.hidden = !loading;
  elements.statsLoadingCopy.textContent = status === "loading-more"
    ? "Loading more rankings…"
    : "Loading statistics…";
  elements.statsError.hidden = status !== "error";
  elements.statsEmpty.hidden = status !== "empty";
  elements.statsEmptyCopy.textContent = state.stats.scope === "all"
    ? "Play a beat to start building the rankings."
    : "No plays were recorded in this period.";

  elements.statsRankings.hidden = !hasRows;
  if (hasRows) {
    renderStatsRankings();
  } else {
    elements.statsTrackList.replaceChildren();
  }

  if (status === "ready" || status === "empty" || (status === "error" && hasRows) || status === "loading-more") {
    const scopeLabel = state.stats.scope === "all"
      ? "All time"
      : formatStatsPeriod(state.stats.period, state.stats.scope);
    elements.statsSummary.textContent = `${scopeLabel} · ${plural(state.stats.totalPlays, "play")} · ${plural(state.stats.totalTracks, "ranked beat")}`;
  } else {
    elements.statsSummary.textContent = "";
  }

  const canLoadMore = state.stats.hasMore
    && state.stats.rankings.length < MAX_STATS_RANK;
  const hideLoadMore = status === "loading-more"
    ? !hasRows
    : status !== "ready" || !canLoadMore;
  elements.statsLoadMoreRow.hidden = hideLoadMore;
  elements.statsLoadMore.hidden = hideLoadMore;
  elements.statsLoadMore.disabled = status === "loading-more";
  elements.statsLoadMore.textContent = status === "loading-more" ? "Loading…" : "Load more";
}

function renderStatsPage(reset = false) {
  if (reset) {
    state.stats.requestID += 1;
    state.stats.scope = "all";
    state.stats.period = "";
    state.stats.rankings = [];
    state.stats.totalPlays = 0;
    state.stats.totalTracks = 0;
    state.stats.hasMore = false;
    state.stats.status = "idle";
    state.stats.retryAppend = false;
  }
  renderStatsState();
  if (state.stats.status === "idle") loadStats(false);
}

function setStatsScope(scope, requestedPeriod = "") {
  if (!["all", "year", "month"].includes(scope)) return;
  const entries = statsPeriodEntries(scope);
  const values = entries.map((entry) => statsPeriodValue(entry, scope));
  const period = scope === "all"
    ? ""
    : values.includes(requestedPeriod) ? requestedPeriod : values[0] || "";
  if (
    state.stats.scope === scope
    && state.stats.period === period
    && !["error", "idle"].includes(state.stats.status)
  ) {
    return;
  }

  state.stats.requestID += 1;
  state.stats.scope = scope;
  state.stats.period = period;
  state.stats.rankings = [];
  state.stats.totalPlays = 0;
  state.stats.totalTracks = 0;
  state.stats.hasMore = false;
  state.stats.retryAppend = false;
  state.stats.status = scope !== "all" && !period ? "empty" : "idle";
  renderStatsState();
  if (state.stats.status === "idle") loadStats(false);
}

async function loadStats(append) {
  if (state.stats.status === "loading" || state.stats.status === "loading-more") return;
  if (append && (!state.stats.hasMore || state.stats.rankings.length >= MAX_STATS_RANK)) return;
  const scope = state.stats.scope;
  const period = state.stats.period;
  if (scope !== "all" && !period) return;
  const offset = append ? state.stats.rankings.length : 0;
  const requestID = ++state.stats.requestID;
  state.stats.status = append ? "loading-more" : "loading";
  state.stats.retryAppend = append;
  renderStatsState();

  const parameters = new URLSearchParams({
    period: scope,
    offset: String(offset),
    limit: String(STATS_PAGE_SIZE),
  });
  if (scope === "year") parameters.set("year", period);
  if (scope === "month") parameters.set("month", period);

  try {
    const response = await fetch(`/api/stats?${parameters}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Stats request failed: ${response.status}`);
    const payload = await response.json();
    if (
      !payload
      || payload.period !== scope
      || !Array.isArray(payload.rankings)
      || !payload.periods
      || !Array.isArray(payload.periods.years)
      || !Array.isArray(payload.periods.months)
    ) {
      throw new Error("Invalid stats response");
    }
    if (requestID !== state.stats.requestID) return;

    state.stats.periods = {
      years: payload.periods.years,
      months: payload.periods.months,
    };
    state.stats.rankings = append
      ? [...state.stats.rankings, ...payload.rankings].slice(0, MAX_STATS_RANK)
      : payload.rankings.slice(0, MAX_STATS_RANK);
    state.stats.totalPlays = Number(payload.totalPlays);
    state.stats.totalTracks = Number(payload.totalTracks);
    state.stats.hasMore = Boolean(payload.hasMore)
      && state.stats.rankings.length < MAX_STATS_RANK;
    state.stats.status = state.stats.rankings.length ? "ready" : "empty";
    renderStatsState();
    if (append) {
      window.requestAnimationFrame(() => {
        if (state.stats.hasMore) {
          elements.statsLoadMore.focus();
          return;
        }
        const rows = elements.statsTrackList.querySelectorAll(".track-row");
        (rows[offset] || rows[rows.length - 1])?.focus();
      });
    }
  } catch {
    if (requestID !== state.stats.requestID) return;
    state.stats.status = "error";
    renderStatsState();
    if (append) {
      window.requestAnimationFrame(() => elements.retryStats.focus());
    }
  }
}

function openTopStatsPeriod(scope) {
  const entry = statsPeriodEntries(scope)[0];
  if (!entry) return;
  setStatsScope(scope, statsPeriodValue(entry, scope));
}

function performSearch() {
  const query = elements.searchInput.value.trim();
  elements.clearSearch.hidden = query.length === 0;

  if (!query) {
    state.searchResults = [];
    elements.searchMeta.textContent = "";
    elements.searchResults.replaceChildren();
    return;
  }

  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  const matches = state.tracks
    .filter((track) => tokens.every((token) => track.searchText.includes(token)))
    .sort((left, right) => {
      const normalizedQuery = normalize(query);
      const leftTitle = normalize(left.title);
      const rightTitle = normalize(right.title);
      const leftScore = leftTitle.startsWith(normalizedQuery) ? 0 : leftTitle.includes(normalizedQuery) ? 1 : 2;
      const rightScore = rightTitle.startsWith(normalizedQuery) ? 0 : rightTitle.includes(normalizedQuery) ? 1 : 2;
      return leftScore - rightScore || collator.compare(left.title, right.title);
    });

  state.searchResults = matches;
  elements.searchMeta.textContent = matches.length
    ? `${plural(matches.length, "result")} for “${query}”`
    : `No results for “${query}”`;

  if (!matches.length) {
    elements.searchResults.replaceChildren();
    return;
  }

  renderTrackList(elements.searchResults, matches, matches);
}


function playFromContext(track, contextTracks) {
  const source = uniqueTrackIDs(contextTracks);
  state.queueSource = source;
  if (state.shuffle) {
    state.queue = [track.id, ...shuffled(source.filter((id) => id !== track.id))];
    state.queueIndex = 0;
  } else {
    state.queue = source;
    state.queueIndex = source.indexOf(track.id);
  }
  loadTrack(track, true);
}

function shuffleAndPlay(tracks, firstTrackID = "") {
  const source = uniqueTrackIDs(tracks);
  if (!source.length) return;
  state.shuffle = true;
  state.queueSource = source;
  state.queue = firstTrackID
    ? [firstTrackID, ...shuffled(source.filter((id) => id !== firstTrackID))]
    : shuffled(source);
  state.queueIndex = 0;
  updateShuffleUI();
  const firstTrack = state.trackById.get(state.queue[0]);
  loadTrack(firstTrack, true);
}

function shuffleAllAndPlay() {
  const starterIDs = state.tracks.filter((track) => track.starter).map((track) => track.id);
  const starterID = starterIDs.length
    ? starterIDs[Math.floor(Math.random() * starterIDs.length)]
    : "";
  shuffleAndPlay(state.tracks, starterID);
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  if (!state.queueSource.length) {
    state.queueSource = state.tracks.map((track) => track.id);
  }

  if (state.currentTrack) {
    if (state.shuffle) {
      state.queue = [
        state.currentTrack.id,
        ...shuffled(state.queueSource.filter((id) => id !== state.currentTrack.id)),
      ];
      state.queueIndex = 0;
    } else {
      state.queue = [...state.queueSource];
      state.queueIndex = state.queue.indexOf(state.currentTrack.id);
    }
  }

  updateShuffleUI();
  showToast(state.shuffle ? "Shuffle on" : "Shuffle off");
}

function updateShuffleUI() {
  elements.playerShuffle.setAttribute("aria-pressed", String(state.shuffle));
  elements.playerShuffle.setAttribute("aria-label", state.shuffle ? "Turn shuffle off" : "Turn shuffle on");
}

function toggleRepeat() {
  state.repeat = !state.repeat;
  elements.audio.loop = state.repeat;
  updateRepeatUI();
  showToast(state.repeat ? "Repeat current on" : "Repeat current off");
}

function updateRepeatUI() {
  elements.playerRepeat.setAttribute("aria-pressed", String(state.repeat));
  elements.playerRepeat.setAttribute(
    "aria-label",
    state.repeat ? "Turn repeat current off" : "Turn repeat current on",
  );
}

function refillArtworkDeck() {
  const ids = shuffled(state.artwork.map((item) => item.id));
  if (ids.length > 1 && ids[0] === state.currentArtwork?.id) {
    [ids[0], ids[1]] = [ids[1], ids[0]];
  }
  state.artworkDeck = ids;
}

function selectNextArtwork() {
  if (!state.artwork.length) {
    state.currentArtwork = null;
    elements.playerArt.hidden = true;
    elements.playerArtwork.removeAttribute("src");
    return;
  }
  if (!state.artworkDeck.length) refillArtworkDeck();
  const artworkID = state.artworkDeck.shift();
  state.currentArtwork = state.artwork.find((item) => item.id === artworkID) || null;
  if (!state.currentArtwork) {
    selectNextArtwork();
    return;
  }
  elements.playerArtwork.src = state.currentArtwork.url;
  elements.playerArt.hidden = false;
}

function beginPlaySession(track) {
  const previousSession = state.playSession;
  if (previousSession?.playListener) {
    elements.audio.removeEventListener("playing", previousSession.playListener);
  }
  if (previousSession?.retryTimer) {
    window.clearTimeout(previousSession.retryTimer);
  }

  const session = {
    trackId: track.id,
    sessionId: createSessionID(),
    playListener: null,
    retryTimer: 0,
    attempts: 0,
    inFlight: false,
    complete: false,
  };
  session.playListener = () => {
    if (state.playSession !== session || session.complete || elements.audio.paused) return;
    elements.audio.removeEventListener("playing", session.playListener);
    session.playListener = null;
    submitPlay(session);
  };
  state.playSession = session;
  elements.audio.addEventListener("playing", session.playListener);
}

async function submitPlay(session) {
  if (
    state.playSession !== session
    || session.complete
    || session.inFlight
    || session.attempts >= 2
  ) {
    return;
  }
  session.inFlight = true;
  session.attempts += 1;
  try {
    const response = await fetch("/api/plays", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        trackId: session.trackId,
        sessionId: session.sessionId,
      }),
    });
    if (!response.ok) throw new Error(`Play request failed: ${response.status}`);
    session.complete = true;
  } catch {
    if (state.playSession === session && session.attempts < 2) {
      session.retryTimer = window.setTimeout(() => submitPlay(session), 1500);
    }
  } finally {
    session.inFlight = false;
  }
}

function setPlayerExpanded(expanded, invoker = null) {
  const wasExpanded = state.playerExpanded;
  const nextExpanded = Boolean(expanded && state.currentTrack);
  if (nextExpanded && !wasExpanded) {
    state.playerExpandInvoker = invoker instanceof HTMLElement
      ? invoker
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  state.playerExpanded = nextExpanded;
  elements.player.classList.toggle("is-expanded", nextExpanded);
  elements.body.classList.toggle("player-expanded", nextExpanded);
  elements.expandPlayer.setAttribute("aria-expanded", String(nextExpanded));
  elements.desktopExpandPlayer.setAttribute("aria-expanded", String(nextExpanded));
  [elements.siteHeader, elements.main, elements.skipLink].forEach((element) => {
    element.inert = nextExpanded;
  });

  if (nextExpanded && !wasExpanded) {
    window.requestAnimationFrame(() => elements.collapsePlayer.focus({ preventScroll: true }));
  } else if (!nextExpanded && wasExpanded) {
    const preferredFocus = state.playerExpandInvoker;
    const fallbackFocus = window.matchMedia("(min-width: 800px)").matches
      ? elements.desktopExpandPlayer
      : elements.expandPlayer;
    const restoreFocus = preferredFocus?.isConnected
      && !preferredFocus.disabled
      && preferredFocus.getClientRects().length
      ? preferredFocus
      : fallbackFocus;
    state.playerExpandInvoker = null;
    window.requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  }
  window.requestAnimationFrame(updateMarquee);
}

function loadTrack(track, autoplay) {
  if (!track) return;
  state.currentTrack = track;
  beginPlaySession(track);
  selectNextArtwork();
  elements.audio.src = track.url;
  elements.audio.load();
  elements.player.classList.remove("is-empty");
  elements.body.classList.add("has-player");
  elements.playPause.disabled = false;
  elements.seek.disabled = false;
  elements.playerTitle.textContent = track.title;
  elements.marqueeClone.textContent = track.title;
  elements.titleMarquee.title = track.title;
  elements.playerMeta.textContent = track.directory.split("/").join(" / ") || "Archive";
  elements.currentTime.textContent = "0:00";
  elements.duration.textContent = "0:00";
  elements.seek.value = "0";
  setRangeProgress(elements.seek, 0);
  document.title = track.title;
  updateFavoriteUI();
  updateMarquee();
  updateTrackRows();
  updateMediaSession(track);

  if (autoplay) {
    const playPromise = elements.audio.play();
    if (playPromise) {
      playPromise.catch(() => showToast("Press play to start listening"));
    }
  }
}

function togglePlayback() {
  if (!state.currentTrack) return;
  if (elements.audio.paused) {
    const playPromise = elements.audio.play();
    if (playPromise) playPromise.catch(() => showToast("Playback could not start"));
  } else {
    elements.audio.pause();
  }
}

function nextTrack() {
  if (!state.queue.length) return;
  const nextIndex = state.queueIndex + 1;
  if (nextIndex >= state.queue.length) {
    elements.audio.pause();
    elements.audio.currentTime = 0;
    showToast("End of the queue");
    return;
  }
  state.queueIndex = nextIndex;
  loadTrack(state.trackById.get(state.queue[nextIndex]), true);
}

function previousTrack() {
  if (!state.currentTrack) return;
  if (elements.audio.currentTime > 3 || state.queueIndex <= 0) {
    elements.audio.currentTime = 0;
    return;
  }
  state.queueIndex -= 1;
  loadTrack(state.trackById.get(state.queue[state.queueIndex]), true);
}

function updatePlayerState() {
  const playing = !elements.audio.paused && !elements.audio.ended;
  elements.player.classList.toggle("is-playing", playing);
  elements.playPause.setAttribute("aria-label", playing ? "Pause" : "Play");
  updateTrackRows();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}

function updateTrackRows() {
  const playing = !elements.audio.paused && !elements.audio.ended;
  document.querySelectorAll(".track-row").forEach((row) => {
    const current = row.dataset.trackId === state.currentTrack?.id;
    row.classList.toggle("is-current", current);
    row.classList.toggle("is-playing", current && playing);
    row.setAttribute("aria-label", `${current && playing ? "Pause" : "Play"} ${row.dataset.trackLabel}`);
    const symbol = current && playing ? "#icon-pause" : "#icon-play";
    row.querySelectorAll("use").forEach((use) => use.setAttribute("href", symbol));
  });
}

function updateProgress() {
  if (state.seeking) return;
  const duration = elements.audio.duration;
  const current = elements.audio.currentTime;
  const ratio = Number.isFinite(duration) && duration > 0 ? current / duration : 0;
  elements.seek.value = String(Math.round(ratio * 1000));
  setRangeProgress(elements.seek, ratio);
  elements.currentTime.textContent = formatTime(current);
  elements.duration.textContent = formatTime(duration);

  if ("mediaSession" in navigator && Number.isFinite(duration) && duration > 0) {
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate: elements.audio.playbackRate, position: Math.min(current, duration) });
    } catch {
      // Some browsers reject transient metadata states while a source is changing.
    }
  }
}

function updateMarquee() {
  elements.titleMarquee.classList.remove("is-overflowing");
  window.requestAnimationFrame(() => {
    const overflowing = elements.playerTitle.scrollWidth > elements.titleMarquee.clientWidth + 1;
    if (overflowing) {
      const duration = Math.max(12, Math.min(28, state.currentTrack.title.length * 0.26));
      elements.titleMarquee.style.setProperty("--marquee-duration", `${duration}s`);
      elements.titleMarquee.classList.add("is-overflowing");
    }
  });
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;
  const metadata = {
    title: track.title,
    album: "Archive",
  };
  if (state.currentArtwork) {
    metadata.artwork = [{ src: state.currentArtwork.url }];
  }
  navigator.mediaSession.metadata = new MediaMetadata(metadata);
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2400);
}

function registerEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.view));
  });
  elements.skipLink.addEventListener("click", (event) => {
    event.preventDefault();
    elements.main.focus();
  });

  elements.shuffleAll.addEventListener("click", shuffleAllAndPlay);
  elements.shuffleFolder.addEventListener("click", () => shuffleAndPlay(state.currentFolderTracks));
  elements.searchInput.addEventListener("input", performSearch);
  elements.clearSearch.addEventListener("click", () => {
    elements.searchInput.value = "";
    performSearch();
    elements.searchInput.focus();
  });
  elements.retryLibrary.addEventListener("click", () => window.location.reload());
  elements.shuffleFavorites.addEventListener("click", shuffleFavoriteTracks);
  elements.statsScopeButtons.forEach((button) => {
    button.addEventListener("click", () => setStatsScope(button.dataset.statsScope));
  });
  elements.statsPeriod.addEventListener("change", () => {
    setStatsScope(state.stats.scope, elements.statsPeriod.value);
  });
  elements.topYear.addEventListener("click", () => openTopStatsPeriod("year"));
  elements.topMonth.addEventListener("click", () => openTopStatsPeriod("month"));
  elements.statsLoadMore.addEventListener("click", () => loadStats(true));
  elements.retryStats.addEventListener("click", () => loadStats(state.stats.retryAppend));

  elements.playerShuffle.addEventListener("click", toggleShuffle);
  elements.playerFavorite.addEventListener("click", toggleFavorite);
  elements.playerRepeat.addEventListener("click", toggleRepeat);
  elements.previousTrack.addEventListener("click", previousTrack);
  elements.playPause.addEventListener("click", togglePlayback);
  elements.nextTrack.addEventListener("click", nextTrack);
  elements.expandPlayer.addEventListener("click", () => setPlayerExpanded(true, elements.expandPlayer));
  elements.desktopExpandPlayer.addEventListener("click", () => setPlayerExpanded(true, elements.desktopExpandPlayer));
  elements.collapsePlayer.addEventListener("click", () => setPlayerExpanded(false));
  elements.playerArtwork.addEventListener("error", () => {
    const failedID = state.currentArtwork?.id;
    state.artwork = state.artwork.filter((item) => item.id !== failedID);
    state.artworkDeck = state.artworkDeck.filter((id) => id !== failedID);
    selectNextArtwork();
    if (state.currentTrack) updateMediaSession(state.currentTrack);
  });

  elements.audio.addEventListener("play", updatePlayerState);
  elements.audio.addEventListener("pause", updatePlayerState);
  elements.audio.addEventListener("ended", () => {
    if (!elements.audio.loop) nextTrack();
  });
  elements.audio.addEventListener("timeupdate", updateProgress);
  elements.audio.addEventListener("durationchange", updateProgress);
  elements.audio.addEventListener("loadedmetadata", updateProgress);
  elements.audio.addEventListener("error", () => {
    if (state.currentTrack) showToast(`Could not play “${state.currentTrack.title}”`);
    updatePlayerState();
  });

  elements.seek.addEventListener("input", () => {
    state.seeking = true;
    const ratio = Number(elements.seek.value) / 1000;
    setRangeProgress(elements.seek, ratio);
    elements.currentTime.textContent = formatTime(ratio * elements.audio.duration);
  });
  elements.seek.addEventListener("change", () => {
    const duration = elements.audio.duration;
    if (Number.isFinite(duration)) {
      elements.audio.currentTime = (Number(elements.seek.value) / 1000) * duration;
    }
    state.seeking = false;
    updateProgress();
  });

  const savedVolumeValue = getStoredValue("beatz-volume");
  const savedVolume = savedVolumeValue === null ? NaN : Number(savedVolumeValue);
  if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1) {
    elements.volume.value = String(savedVolume);
  }
  elements.audio.volume = Number(elements.volume.value);
  setRangeProgress(elements.volume, Number(elements.volume.value));
  elements.volume.addEventListener("input", () => {
    const volume = Number(elements.volume.value);
    elements.audio.volume = volume;
    setRangeProgress(elements.volume, volume);
    setStoredValue("beatz-volume", String(volume));
  });

  window.addEventListener("hashchange", applyRoute);
  window.addEventListener("resize", updateMarquee);
  elements.player.addEventListener("touchstart", (event) => {
    const target = event.target;
    if (!state.playerExpanded || event.touches.length !== 1 || (target instanceof Element && target.closest("input, button"))) {
      state.playerTouch = null;
      return;
    }
    state.playerTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  elements.player.addEventListener("touchend", (event) => {
    if (!state.playerTouch || event.changedTouches.length !== 1) return;
    const deltaX = event.changedTouches[0].clientX - state.playerTouch.x;
    const deltaY = event.changedTouches[0].clientY - state.playerTouch.y;
    state.playerTouch = null;
    if (deltaY > 72 && deltaY > Math.abs(deltaX) * 1.2) setPlayerExpanded(false);
  }, { passive: true });
  elements.player.addEventListener("touchcancel", () => {
    state.playerTouch = null;
  }, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.playerExpanded) {
      event.preventDefault();
      setPlayerExpanded(false);
      return;
    }
    const target = event.target;
    const editing = target instanceof HTMLElement && target.closest("input, button, [contenteditable='true']");
    if (event.key === "/" && !editing && !state.playerExpanded) {
      event.preventDefault();
      navigate("search");
      return;
    }
    if (event.code === "Space" && !editing && state.currentTrack) {
      event.preventDefault();
      togglePlayback();
    }
  });

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => elements.audio.play());
    navigator.mediaSession.setActionHandler("pause", () => elements.audio.pause());
    navigator.mediaSession.setActionHandler("previoustrack", previousTrack);
    navigator.mediaSession.setActionHandler("nexttrack", nextTrack);
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      elements.audio.currentTime = Math.max(0, elements.audio.currentTime - (details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      elements.audio.currentTime = Math.min(elements.audio.duration || Infinity, elements.audio.currentTime + (details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (Number.isFinite(details.seekTime)) elements.audio.currentTime = details.seekTime;
    });
  }
}

async function loadLibrary() {
  const response = await fetch("/api/library", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Library request failed: ${response.status}`);
  const catalog = await response.json();
  if (!catalog || !Array.isArray(catalog.tracks) || catalog.tracks.length === 0) {
    throw new Error("The library is empty");
  }

  state.tracks = catalog.tracks.map((track) => ({
    ...track,
    searchText: normalize(`${track.title} ${track.filename} ${track.path}`),
  }));
  state.artwork = Array.isArray(catalog.artwork) ? catalog.artwork : [];
  state.trackById = new Map(state.tracks.map((track) => [track.id, track]));
  state.queueSource = state.tracks.map((track) => track.id);

  performSearch();
  applyRoute();
  elements.body.classList.remove("is-loading");
}

loadFavorites();
registerEvents();
loadLibrary().catch((error) => {
  console.error(error);
  elements.body.classList.remove("is-loading");
  Object.values(elements.pages).forEach((page) => {
    page.hidden = true;
    page.classList.remove("is-active");
  });
  elements.fatalError.hidden = false;
});
