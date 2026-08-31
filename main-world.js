(function installMainWorldBridge() {
  "use strict";

  const REQUEST = "YTSE_REQUEST_PLAYER_DATA";
  const RESPONSE = "YTSE_PLAYER_DATA";
  const CAPTION_REQUEST = "YTSE_REQUEST_CAPTION";
  const CAPTION_RESPONSE = "YTSE_CAPTION_DATA";
  // Capture the native fetch function before page scripts can replace it.
  const nativeFetch = window.fetch.bind(window);

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return nativeFetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  function textFromRuns(value) {
    if (!value) return "";
    if (typeof value.simpleText === "string") return value.simpleText;
    if (Array.isArray(value.runs)) return value.runs.map((run) => run && run.text || "").join("");
    return "";
  }

  function getPlayerResponse() {
    const player = document.getElementById("movie_player");
    const candidates = [
      player && typeof player.getPlayerResponse === "function" ? player.getPlayerResponse() : null,
      // The live player response is preferred because initial URLs can expire or
      // lack session-bound parameters after a YouTube SPA navigation.
      window.ytInitialPlayerResponse,
      window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.player_response
    ];

    for (let candidate of candidates) {
      if (typeof candidate === "string") {
        try { candidate = JSON.parse(candidate); }
        catch (_error) { continue; }
      }
      if (candidate && candidate.videoDetails) return candidate;
    }
    return null;
  }

  function safeData() {
    const response = getPlayerResponse();
    if (!response) return null;
    const renderer = response.captions && response.captions.playerCaptionsTracklistRenderer;
    return {
      videoId: response.videoDetails && response.videoDetails.videoId || "",
      title: response.videoDetails && response.videoDetails.title || document.title.replace(/\s+-\s+YouTube$/, ""),
      tracks: Array.isArray(renderer && renderer.captionTracks)
        ? renderer.captionTracks.map((track) => ({
            baseUrl: track.baseUrl || "",
            languageCode: track.languageCode || "",
            name: textFromRuns(track.name),
            kind: track.kind || "",
            vssId: track.vssId || "",
            isTranslatable: Boolean(track.isTranslatable)
          }))
        : [],
      translationLanguages: Array.isArray(renderer && renderer.translationLanguages)
        ? renderer.translationLanguages.map((item) => ({
            languageCode: item.languageCode || "",
            name: textFromRuns(item.languageName)
          }))
        : []
    };
  }

  function captionUrls(baseUrl) {
    const parsed = new URL(baseUrl);
    if (parsed.origin !== "https://www.youtube.com" || parsed.pathname !== "/api/timedtext") {
      throw new Error("INVALID_CAPTION_URL");
    }
    const json3 = new URL(parsed.href);
    json3.searchParams.set("fmt", "json3");
    const urls = [json3.href];
    urls.push(parsed.href);
    return Array.from(new Set(urls));
  }

  function endpointFromObject(value) {
    if (!value || typeof value !== "object") return "";
    const endpoint = value.getTranscriptEndpoint ||
      value.serviceEndpoint && value.serviceEndpoint.getTranscriptEndpoint ||
      value.navigationEndpoint && value.navigationEndpoint.getTranscriptEndpoint ||
      value.continuationEndpoint && value.continuationEndpoint.getTranscriptEndpoint;
    return endpoint && typeof endpoint.params === "string" ? endpoint.params : "";
  }

  function decodedParamsContain(params, text) {
    if (!params || !text) return false;
    try {
      const normalized = decodeURIComponent(params).replace(/-/g, "+").replace(/_/g, "/");
      return atob(normalized).includes(text);
    } catch (_error) {
      return false;
    }
  }

  function findTranscriptParams(videoId) {
    const roots = [window.ytInitialData];
    for (const selector of ["ytd-watch-flexy", "ytd-video-description-transcript-section-renderer"]) {
      const element = document.querySelector(selector);
      if (element && element.data) roots.push(element.data);
    }

    let fallback = "";
    const seen = new WeakSet();
    const stack = roots.filter(Boolean);
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      const params = endpointFromObject(value);
      if (params) {
        if (decodedParamsContain(params, videoId)) return params;
        if (!fallback) fallback = params;
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") stack.push(child);
      }
    }
    return fallback;
  }

  function textValue(value) {
    if (!value) return "";
    if (typeof value.simpleText === "string") return value.simpleText;
    if (Array.isArray(value.runs)) return value.runs.map((run) => run && run.text || "").join("");
    return "";
  }

  function transcriptEvents(response) {
    const events = [];
    const seen = new WeakSet();
    const stack = [response];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      const renderer = value.transcriptSegmentRenderer;
      if (renderer) {
        const text = textValue(renderer.snippet);
        if (text) {
          events.push({
            tStartMs: Number(renderer.startMs) || 0,
            dDurationMs: Math.max(0, (Number(renderer.endMs) || 0) - (Number(renderer.startMs) || 0)),
            segs: [{ utf8: text }]
          });
        }
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") stack.push(child);
      }
    }
    events.sort((left, right) => left.tStartMs - right.tStartMs);
    return events;
  }

  function timestampToMs(value) {
    const parts = String(value || "").trim().split(":").map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
  }

  function transcriptEventsFromPage() {
    const dataRoots = Array.from(document.querySelectorAll(
      "ytd-transcript-renderer, ytd-transcript-segment-list-renderer, " +
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"], ' +
      'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]'
    )).map((element) => element.data).filter(Boolean);

    for (const root of dataRoots) {
      const events = transcriptEvents(root);
      if (events.length) return events;
    }

    const legacyEvents = Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"))
      .map((element, index) => {
        const textElement = element.querySelector(
          ".segment-text, #segment-text, yt-formatted-string.segment-text, [class*='segment-text']"
        );
        const timeElement = element.querySelector(
          ".segment-timestamp, #segment-timestamp, [class*='segment-timestamp']"
        );
        const text = String(textElement && textElement.textContent || "").trim();
        return text ? {
          tStartMs: timestampToMs(timeElement && timeElement.textContent) || index,
          dDurationMs: 0,
          segs: [{ utf8: text }]
        } : null;
      })
      .filter(Boolean);
    if (legacyEvents.length) return legacyEvents;

    // YouTube's 2026 transcript redesign no longer uses the ytd-* segment
    // renderer. Its visible transcript lives in PAmodern_transcript_view and
    // each row is a transcript-segment-view-model custom element.
    return Array.from(document.querySelectorAll(
      'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"] ' +
      "transcript-segment-view-model"
    )).map((element, index) => {
      const textElement = element.querySelector(
        'span[role="text"], .ytAttributedStringHost, [class*="TranscriptSegmentViewModelText"]'
      );
      const timeElement = element.querySelector(
        ".ytwTranscriptSegmentViewModelTimestamp, [class*='TranscriptSegmentViewModelTimestamp']"
      );
      const text = String(textElement && textElement.textContent || "").trim();
      return text ? {
        tStartMs: timestampToMs(timeElement && timeElement.textContent) || index,
        dDurationMs: 0,
        segs: [{ utf8: text }]
      } : null;
    }).filter(Boolean);
  }

  function findTranscriptButton() {
    const direct = document.querySelector(
      "ytd-video-description-transcript-section-renderer button, " +
      "ytd-video-description-transcript-section-renderer yt-button-shape button, " +
      "button[aria-label*='transcript' i]"
    );
    if (direct) return direct;

    const labelPattern = /show transcript|open transcript|transcript|显示文字稿|顯示文字稿|文字記錄|文字记录|查看转录|查看轉錄|文字起こし|스크립트/i;
    return Array.from(document.querySelectorAll("button, tp-yt-paper-button, yt-button-shape"))
      .find((element) => labelPattern.test(String(element.textContent || element.getAttribute("aria-label") || "").trim())) || null;
  }

  function nativeClick(element) {
    if (!element) return;
    const button = element.matches && element.matches("button") ? element : element.querySelector && element.querySelector("button") || element;
    try { HTMLElement.prototype.click.call(button); }
    catch (_error) { if (typeof button.click === "function") button.click(); }
  }

  async function fetchTranscriptFromPage() {
    let events = transcriptEventsFromPage();
    if (events.length) {
      return { ok: true, body: JSON.stringify({ events }), contentType: "application/json", source: "transcript_page_data" };
    }

    let button = findTranscriptButton();
    if (!button) {
      const expand = document.querySelector(
        "ytd-text-inline-expander #expand, #description-inline-expander #expand, tp-yt-paper-button#expand"
      );
      if (expand) {
        nativeClick(expand);
        await new Promise((resolve) => setTimeout(resolve, 250));
        button = findTranscriptButton();
      }
    }
    if (!button) return { ok: false, code: "TRANSCRIPT_BUTTON_UNAVAILABLE" };

    nativeClick(button);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      events = transcriptEventsFromPage();
      if (events.length) {
        return { ok: true, body: JSON.stringify({ events }), contentType: "application/json", source: "transcript_page_data" };
      }
    }
    return { ok: false, code: "TRANSCRIPT_PANEL_EMPTY" };
  }

  async function fetchTranscript(videoId) {
    const params = findTranscriptParams(videoId);
    const config = window.ytcfg;
    const apiKey = config && config.get("INNERTUBE_API_KEY");
    const context = config && config.get("INNERTUBE_CONTEXT");
    const clientName = config && config.get("INNERTUBE_CONTEXT_CLIENT_NAME", 1);
    const clientVersion = config && config.get("INNERTUBE_CLIENT_VERSION", "");
    const visitorData = context && context.client && context.client.visitorData ||
      config && config.get("VISITOR_DATA", "");
    if (!params || !apiKey || !context) return { ok: false, code: "TRANSCRIPT_CONFIG_UNAVAILABLE" };

    try {
      const response = await fetchWithTimeout(`/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": String(clientName),
          "x-youtube-client-version": String(clientVersion),
          "x-goog-visitor-id": String(visitorData),
          "x-youtube-bootstrap-logged-in": config.get("LOGGED_IN", false) ? "true" : "false",
          "x-origin": location.origin
        },
        body: JSON.stringify({ context, params })
      }, 6000);
      if (!response.ok) return { ok: false, code: `TRANSCRIPT_HTTP_${response.status}` };
      const data = await response.json();
      const events = transcriptEvents(data);
      if (!events.length) return { ok: false, code: "TRANSCRIPT_EMPTY" };
      return {
        ok: true,
        body: JSON.stringify({ events }),
        contentType: "application/json",
        source: "get_transcript"
      };
    } catch (_error) {
      return { ok: false, code: "TRANSCRIPT_FETCH_FAILED" };
    }
  }

  async function fetchCaption(baseUrl) {
    let lastCode = "FETCH_FAILED";
    for (const url of captionUrls(baseUrl)) {
      try {
        const response = await fetchWithTimeout(url, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "follow"
        }, 4000);
        if (!response.ok) { lastCode = `HTTP_${response.status}`; continue; }
        const body = await response.text();
        if (!body.trim()) { lastCode = "EMPTY_SUBTITLE"; continue; }
        return { ok: true, body, contentType: response.headers.get("content-type") || "" };
      } catch (error) {
        lastCode = error && error.name === "AbortError" ? "TIMEDTEXT_TIMEOUT" : "FETCH_FAILED";
      }
    }
    const parsed = new URL(baseUrl);
    const currentResponse = getPlayerResponse();
    const videoId = currentResponse && currentResponse.videoDetails && currentResponse.videoDetails.videoId ||
      parsed.searchParams.get("v") || "";
    const transcript = videoId ? await fetchTranscript(videoId) : null;
    if (transcript && transcript.ok) return transcript;
    const pageTranscript = await fetchTranscriptFromPage();
    if (pageTranscript.ok) return pageTranscript;
    return {
      ok: false,
      code: pageTranscript.code || transcript && transcript.code || lastCode
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === REQUEST) {
      window.postMessage({ type: RESPONSE, requestId: event.data.requestId, payload: safeData() }, "*");
      return;
    }
    if (event.data.type === CAPTION_REQUEST) {
      fetchCaption(event.data.baseUrl)
        .then((payload) => window.postMessage({ type: CAPTION_RESPONSE, requestId: event.data.requestId, payload }, "*"))
        .catch(() => window.postMessage({ type: CAPTION_RESPONSE, requestId: event.data.requestId, payload: { ok: false, code: "FETCH_FAILED" } }, "*"));
    }
  });
})();
