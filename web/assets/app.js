"use strict";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const monthOrder = new Map(
  [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ].map((month, index) => [month.toLowerCase(), index]),
);

const state = {
  tracks: [],
  trackById: new Map(),
  currentTrack: null,
  queue: [],
  queueSource: [],
  queueIndex: -1,
  shuffle: false,
  explorePath: [],
  currentFolderTracks: [],
  searchResults: [],
  seeking: false,
  toastTimer: 0,
};

const elements = {
  audio: document.querySelector("#audio"),
  body: document.body,
  pages: {
    home: document.querySelector("#home-page"),
    explore: document.querySelector("#explore-page"),
    search: document.querySelector("#search-page"),
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
  player: document.querySelector("#player"),
  playerTitle: document.querySelector("#player-title"),
  marqueeClone: document.querySelector("#marquee-clone"),
  titleMarquee: document.querySelector("#title-marquee"),
  playerMeta: document.querySelector("#player-meta"),
  playerShuffle: document.querySelector("#player-shuffle"),
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

function createTrackRow(track, index, contextTracks) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "track-row";
  row.dataset.trackId = track.id;
  row.setAttribute("aria-label", `Play ${track.title}`);

  const number = document.createElement("span");
  number.className = "track-number";
  const numberText = document.createElement("span");
  numberText.textContent = String(index + 1);
  number.append(numberText, svgIcon("play"));

  const primary = document.createElement("span");
  primary.className = "track-primary";
  const title = document.createElement("strong");
  title.textContent = track.title;
  title.title = track.title;
  const mobileFolder = document.createElement("small");
  mobileFolder.textContent = track.directory.split("/").join(" / ") || "Archive";
  primary.append(title, mobileFolder);

  const folder = document.createElement("span");
  folder.className = "track-folder";
  folder.textContent = track.directory.split("/").join(" / ") || "Archive";
  folder.title = track.directory;

  const action = document.createElement("span");
  action.className = "row-action";
  action.append(svgIcon("play"));

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

function shuffleAndPlay(tracks) {
  const source = uniqueTrackIDs(tracks);
  if (!source.length) return;
  state.shuffle = true;
  state.queueSource = source;
  state.queue = shuffled(source);
  state.queueIndex = 0;
  updateShuffleUI();
  const firstTrack = state.trackById.get(state.queue[0]);
  loadTrack(firstTrack, true);
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

function loadTrack(track, autoplay) {
  if (!track) return;
  state.currentTrack = track;
  elements.audio.src = track.url;
  elements.audio.load();
  elements.player.classList.remove("is-empty");
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
    row.setAttribute("aria-label", `${current && playing ? "Pause" : "Play"} ${row.querySelector(".track-primary strong").textContent}`);
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
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    album: "Archive",
    artwork: [{ src: "/logo.png", sizes: "4000x4000", type: "image/png" }],
  });
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

  elements.shuffleAll.addEventListener("click", () => shuffleAndPlay(state.tracks));
  elements.shuffleFolder.addEventListener("click", () => shuffleAndPlay(state.currentFolderTracks));
  elements.searchInput.addEventListener("input", performSearch);
  elements.clearSearch.addEventListener("click", () => {
    elements.searchInput.value = "";
    performSearch();
    elements.searchInput.focus();
  });
  elements.retryLibrary.addEventListener("click", () => window.location.reload());

  elements.playerShuffle.addEventListener("click", toggleShuffle);
  elements.previousTrack.addEventListener("click", previousTrack);
  elements.playPause.addEventListener("click", togglePlayback);
  elements.nextTrack.addEventListener("click", nextTrack);

  elements.audio.addEventListener("play", updatePlayerState);
  elements.audio.addEventListener("pause", updatePlayerState);
  elements.audio.addEventListener("ended", nextTrack);
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

  const savedVolume = Number(window.localStorage.getItem("beats-volume"));
  if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1) {
    elements.volume.value = String(savedVolume);
  }
  elements.audio.volume = Number(elements.volume.value);
  setRangeProgress(elements.volume, Number(elements.volume.value));
  elements.volume.addEventListener("input", () => {
    const volume = Number(elements.volume.value);
    elements.audio.volume = volume;
    setRangeProgress(elements.volume, volume);
    window.localStorage.setItem("beats-volume", String(volume));
  });

  window.addEventListener("hashchange", applyRoute);
  window.addEventListener("resize", updateMarquee);
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing = target instanceof HTMLElement && target.closest("input, button, [contenteditable='true']");
    if (event.key === "/" && !editing) {
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
  state.trackById = new Map(state.tracks.map((track) => [track.id, track]));
  state.queueSource = state.tracks.map((track) => track.id);

  performSearch();
  applyRoute();
  elements.body.classList.remove("is-loading");
}

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
