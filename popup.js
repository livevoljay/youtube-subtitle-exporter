(function installPopup() {
  "use strict";

  const YouTube = globalThis.SubtitleExporterYouTube;
  const videoTitle = document.getElementById("video-title");
  const trackSelect = document.getElementById("track-select");
  const translationSelect = document.getElementById("translation-select");
  const formatSelect = document.getElementById("format-select");
  const layoutSelect = document.getElementById("layout-select");
  const timestampCheckbox = document.getElementById("timestamp-checkbox");
  const timestampField = document.getElementById("timestamp-field");
  const exportButton = document.getElementById("export-button");
  const status = document.getElementById("status");
  let currentVideo = null;
  let currentTabId = null;
  let pollTimer = null;
  let controlsLocked = true;

  function setStatus(message, type) {
    status.textContent = message;
    status.title = message;
    status.className = `status${type ? ` ${type}` : ""}`;
  }

  function compactFilename(filename, maxCharacters) {
    const characters = Array.from(String(filename || ""));
    const limit = maxCharacters || 56;
    if (characters.length <= limit) return characters.join("");
    const extensionMatch = String(filename).match(/\.[A-Za-z0-9]{1,5}$/);
    const extensionLength = extensionMatch ? extensionMatch[0].length : 0;
    const tailLength = 14 + extensionLength;
    const headLength = Math.max(20, limit - tailLength - 1);
    return `${characters.slice(0, headLength).join("")}…${characters.slice(-tailLength).join("")}`;
  }

  function selectedTrack() {
    return currentVideo && currentVideo.tracks[Number(trackSelect.value)] || null;
  }

  function updateFormatControls() {
    const isTxt = formatSelect.value === "txt";
    formatSelect.disabled = controlsLocked || !currentVideo;
    layoutSelect.disabled = controlsLocked || !currentVideo || !isTxt;
    timestampCheckbox.disabled = controlsLocked || !currentVideo || !isTxt;
    timestampField.classList.toggle("disabled", timestampCheckbox.disabled);
    exportButton.textContent = `导出 ${formatSelect.value.toUpperCase()}`;
  }

  function updateTranslationOptions() {
    const previous = translationSelect.value;
    const track = selectedTrack();
    const languages = currentVideo && Array.isArray(currentVideo.translationLanguages)
      ? currentVideo.translationLanguages
      : [];
    translationSelect.replaceChildren(new Option("不翻译（原字幕）", ""));
    if (track && track.isTranslatable) {
      for (const language of languages) {
        if (!language || !language.languageCode) continue;
        translationSelect.add(new Option(language.name || language.languageCode, language.languageCode));
      }
    }
    if (Array.from(translationSelect.options).some((option) => option.value === previous)) {
      translationSelect.value = previous;
    }
    translationSelect.disabled = controlsLocked || !track || !track.isTranslatable || translationSelect.options.length < 2;
  }

  function setControlsLocked(locked) {
    controlsLocked = Boolean(locked);
    trackSelect.disabled = controlsLocked || !currentVideo || !currentVideo.tracks.length;
    exportButton.disabled = controlsLocked || !currentVideo || !currentVideo.tracks.length;
    updateTranslationOptions();
    updateFormatControls();
  }

  function setUnavailable(title, message) {
    currentVideo = null;
    videoTitle.textContent = title;
    trackSelect.replaceChildren(new Option("无可用字幕", ""));
    translationSelect.replaceChildren(new Option("不翻译（原字幕）", ""));
    setControlsLocked(true);
    setStatus(message, "error");
  }

  function sendTabMessage(tabId, message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PAGE_MESSAGE_TIMEOUT")), timeoutMs || 5000);
      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function displayExportState(state) {
    if (!state || state.videoId && currentVideo && state.videoId !== currentVideo.videoId) return false;
    if (state.status === "running" || state.status === "downloading") {
      setControlsLocked(true);
      setStatus(`${state.message} 可关闭此窗口，任务会继续。`);
      return true;
    }
    if (state.status === "success") {
      setControlsLocked(false);
      const message = state.filename
        ? `${state.warning ? `${state.warning}，` : ""}导出成功：${compactFilename(state.filename)}`
        : state.message;
      setStatus(message, "success");
      status.title = state.message || message;
      return false;
    }
    if (state.status === "error") {
      setControlsLocked(false);
      setStatus(state.message, "error");
      return false;
    }
    return false;
  }

  async function readExportState() {
    if (!currentTabId) return false;
    const response = await sendTabMessage(currentTabId, { type: "GET_EXPORT_STATE" }, 3000);
    return Boolean(response && response.ok && displayExportState(response.state));
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const stillRunning = await readExportState();
        if (!stillRunning) clearInterval(pollTimer);
      } catch (_error) {
        clearInterval(pollTimer);
      }
    }, 750);
  }

  async function initialize() {
    setControlsLocked(true);
    setStatus("正在读取字幕……");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !YouTube.getVideoId(tab.url || "")) {
      setUnavailable("未检测到 YouTube 视频", "当前页面不是 YouTube 视频");
      return;
    }
    currentTabId = tab.id;

    let response;
    try { response = await sendTabMessage(tab.id, { type: "GET_VIDEO_INFO" }); }
    catch (_error) {
      setUnavailable("无法读取当前视频", "无法获取视频信息，请刷新页面后重试");
      return;
    }

    if (!response || !response.ok) {
      setUnavailable("无法读取当前视频", response && response.code === "NOT_VIDEO_PAGE"
        ? "当前页面不是 YouTube 视频" : "无法获取视频信息，请稍后重试");
      return;
    }

    currentVideo = response.data;
    videoTitle.textContent = currentVideo.title;
    trackSelect.replaceChildren();
    if (!currentVideo.tracks.length) {
      setUnavailable(currentVideo.title, "当前视频没有字幕或字幕已被禁用");
      return;
    }

    currentVideo.tracks.forEach((track, index) => trackSelect.add(new Option(track.label, String(index))));
    setControlsLocked(false);
    setStatus(`字幕读取成功，共 ${currentVideo.tracks.length} 个轨道`, "success");

    try {
      if (await readExportState()) startPolling();
    } catch (_error) {
      // A state read is optional and must not block a new export.
    }
  }

  async function exportSelectedTrack() {
    if (!currentVideo || !currentTabId) return;
    const track = selectedTrack();
    if (!track) return;

    const translationCode = translationSelect.value;
    const translation = translationCode
      ? currentVideo.translationLanguages.find((item) => item.languageCode === translationCode) || null
      : null;
    const options = {
      format: formatSelect.value,
      layout: layoutSelect.value,
      includeTimestamps: timestampCheckbox.checked,
      translation
    };

    setControlsLocked(true);
    setStatus("正在启动后台导出任务……");

    try {
      const response = await sendTabMessage(currentTabId, {
        type: "START_EXPORT",
        videoId: currentVideo.videoId,
        track,
        options
      }, 5000);
      if (!response || !response.ok) throw new Error("START_FAILED");
      if (!response.accepted) {
        displayExportState(response.state);
        setStatus("已有字幕导出任务正在后台运行，可关闭此窗口。");
      } else {
        displayExportState(response.state);
        setStatus("后台导出已启动，可关闭此窗口；完成后会发送系统通知。", "success");
      }
      startPolling();
    } catch (_error) {
      setControlsLocked(false);
      setStatus("无法启动后台任务，请刷新视频页面后重试", "error");
    }
  }

  exportButton.addEventListener("click", exportSelectedTrack);
  trackSelect.addEventListener("change", updateTranslationOptions);
  formatSelect.addEventListener("change", updateFormatControls);
  window.addEventListener("unload", () => clearInterval(pollTimer));
  initialize().catch(() => setUnavailable("无法读取当前视频", "无法获取视频信息"));
})();
