(function installContentScript() {
  "use strict";

  const YouTube = globalThis.SubtitleExporterYouTube;
  const Subtitle = globalThis.SubtitleExporterSubtitle;
  const REQUEST = "YTSE_REQUEST_PLAYER_DATA";
  const RESPONSE = "YTSE_PLAYER_DATA";
  const CAPTION_REQUEST = "YTSE_REQUEST_CAPTION";
  const CAPTION_RESPONSE = "YTSE_CAPTION_DATA";
  let navigationVersion = 0;
  let exportState = { status: "idle", message: "", videoId: "", filename: "" };
  let activeExport = null;

  function sendRuntimeMessage(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("BACKGROUND_TIMEOUT")), timeoutMs || 60000);
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function sameTrack(left, right) {
    if (!left || !right) return false;
    if (left.vssId && right.vssId) return left.vssId === right.vssId;
    return left.languageCode === right.languageCode && left.kind === right.kind && left.name === right.name;
  }

  function errorMessage(code) {
    const value = String(code || "FETCH_FAILED");
    const messages = {
      EMPTY_SUBTITLE: "字幕内容为空",
      FETCH_TIMEOUT: "字幕请求超时",
      TIMEDTEXT_TIMEOUT: "YouTube timedtext 请求超时",
      TRANSCRIPT_BUTTON_UNAVAILABLE: "找不到 YouTube 的“显示文字稿”按钮",
      TRANSCRIPT_PANEL_EMPTY: "YouTube 文字稿面板没有返回内容",
      BACKGROUND_TIMEOUT: "下载任务超时",
      DOWNLOAD_FAILED: "TXT 下载失败",
      DOWNLOAD_TIMEOUT: "TXT 下载完成状态确认超时",
      VIDEO_CHANGED: "视频已切换，请重新选择字幕",
      TRACK_UNAVAILABLE: "所选字幕轨道已失效"
    };
    if (messages[value]) return messages[value];
    if (/^TRANSCRIPT_HTTP_/.test(value)) return `YouTube transcript 请求失败（HTTP ${value.replace("TRANSCRIPT_HTTP_", "")}）`;
    return `字幕导出失败（${value}）`;
  }

  function showPageToast(level, message) {
    const oldToast = document.getElementById("ytse-export-toast");
    if (oldToast) oldToast.remove();

    const toast = document.createElement("div");
    toast.id = "ytse-export-toast";
    toast.setAttribute("role", "status");
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      zIndex: "2147483647",
      maxWidth: "min(420px, calc(100vw - 40px))",
      padding: "14px 18px",
      borderRadius: "10px",
      color: "#ffffff",
      background: level === "error" ? "#b91c1c" : "#15803d",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.3)",
      font: "600 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      overflowWrap: "anywhere",
      cursor: "pointer"
    });
    toast.title = "点击关闭";
    toast.addEventListener("click", () => toast.remove());
    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => toast.remove(), 9000);
  }

  function requestMainWorldData(timeoutMs) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, timeoutMs || 1000);

      function onMessage(event) {
        if (event.source !== window || !event.data || event.data.type !== RESPONSE || event.data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(event.data.payload || null);
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ type: REQUEST, requestId }, "*");
    });
  }

  function requestCaptionInPage(baseUrl, timeoutMs) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, code: "FETCH_TIMEOUT" });
      }, timeoutMs || 30000);

      function onMessage(event) {
        if (event.source !== window || !event.data || event.data.type !== CAPTION_RESPONSE || event.data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(event.data.payload || { ok: false, code: "FETCH_FAILED" });
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ type: CAPTION_REQUEST, requestId, baseUrl }, "*");
    });
  }

  async function getVideoInfo() {
    const videoId = YouTube.getVideoId(location.href);
    if (!videoId) return { ok: false, code: "NOT_VIDEO_PAGE" };

    // A short retry covers the interval between an SPA URL change and player initialization.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const data = await requestMainWorldData(900);
      if (data && (!data.videoId || data.videoId === videoId)) {
        return {
          ok: true,
          data: {
            videoId,
            title: data.title || document.title.replace(/\s+-\s+YouTube$/, "") || "YouTube Video",
            tracks: YouTube.normalizeTracks(data.tracks),
            translationLanguages: data.translationLanguages || [],
            navigationVersion
          }
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return { ok: false, code: "PLAYER_DATA_UNAVAILABLE", videoId };
  }

  async function runExport(request) {
    exportState = {
      status: "running",
      message: "正在后台读取并整理字幕……",
      videoId: request.videoId || "",
      filename: ""
    };

    try {
      const info = await getVideoInfo();
      if (!info.ok || info.data.videoId !== request.videoId) throw new Error("VIDEO_CHANGED");
      const track = info.data.tracks.find((candidate) => sameTrack(candidate, request.track));
      if (!track) throw new Error("TRACK_UNAVAILABLE");

      const response = await requestCaptionInPage(track.baseUrl, 30000);
      if (!response || !response.ok) throw new Error(response && response.code || "FETCH_FAILED");
      const cues = Subtitle.parseSubtitle(response.body, response.contentType);
      const text = Subtitle.toPlainText(cues);
      if (!text) throw new Error("EMPTY_SUBTITLE");

      const filename = YouTube.buildFilename(info.data.title, track.label);
      exportState = {
        status: "downloading",
        message: "字幕已整理完成，正在保存 TXT……",
        videoId: info.data.videoId,
        filename
      };
      const download = await sendRuntimeMessage({ type: "DOWNLOAD_TEXT", text, filename }, 60000);
      if (!download || !download.ok) throw new Error(download && download.code || "DOWNLOAD_FAILED");

      exportState = {
        status: "success",
        message: `导出成功：${filename}`,
        videoId: info.data.videoId,
        filename
      };
      showPageToast("success", `字幕导出成功：${filename}`);
    } catch (error) {
      const message = errorMessage(error && error.message);
      exportState = {
        status: "error",
        message,
        videoId: request.videoId || "",
        filename: ""
      };
      showPageToast("error", message);
      try {
        await sendRuntimeMessage({ type: "SHOW_NOTIFICATION", level: "error", message }, 5000);
      } catch (_notificationError) {
        // The state remains available when the Popup is opened again.
      }
    } finally {
      activeExport = null;
    }
  }

  function startExport(request) {
    if (activeExport) return false;
    activeExport = runExport(request);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === "GET_VIDEO_INFO") {
      getVideoInfo().then(sendResponse).catch(() => sendResponse({ ok: false, code: "UNEXPECTED_ERROR" }));
      return true;
    }
    if (message.type === "FETCH_CAPTION_IN_PAGE") {
      requestCaptionInPage(message.baseUrl, 30000).then(sendResponse)
        .catch(() => sendResponse({ ok: false, code: "FETCH_FAILED" }));
      return true;
    }
    if (message.type === "START_EXPORT") {
      const accepted = startExport({ videoId: message.videoId, track: message.track });
      sendResponse({ ok: true, accepted, state: exportState });
      return false;
    }
    if (message.type === "GET_EXPORT_STATE") {
      sendResponse({ ok: true, state: exportState });
      return false;
    }
    return false;
  });

  document.addEventListener("yt-navigate-finish", () => { navigationVersion += 1; }, true);
  window.addEventListener("popstate", () => { navigationVersion += 1; });
})();
