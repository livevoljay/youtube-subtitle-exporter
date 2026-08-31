(function initSubtitleUtils(global) {
  "use strict";

  const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    lrm: "", rlm: "", hellip: "…", ndash: "–", mdash: "—"
  };

  function decodeEntities(value) {
    return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower[0] === "#") {
        const hex = lower[1] === "x";
        const codePoint = Number.parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10);
        try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match; }
        catch (_error) { return match; }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : match;
    });
  }

  function cleanCueText(value) {
    return decodeEntities(String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
      .replace(/\r/g, ""))
      .split("\n")
      .map((line) => line.replace(/[\t\u00A0 ]+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function finiteMilliseconds(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function makeCue(text, startMs, endMs) {
    const cleaned = cleanCueText(text);
    if (!cleaned) return null;
    const start = finiteMilliseconds(startMs, 0);
    const end = finiteMilliseconds(endMs, start);
    return { text: cleaned, startMs: start, endMs: Math.max(start, end) };
  }

  function parseJson3Timed(input) {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if (!data || !Array.isArray(data.events)) return [];
    return data.events.map((event) => {
      if (!event || !Array.isArray(event.segs)) return null;
      const startMs = finiteMilliseconds(event.tStartMs, 0);
      const durationMs = finiteMilliseconds(event.dDurationMs, 0);
      return makeCue(event.segs.map((seg) => seg && seg.utf8 || "").join(""), startMs, startMs + durationMs);
    }).filter(Boolean);
  }

  function attributeValue(attributes, name) {
    const match = String(attributes || "").match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"));
    return match ? match[1] : "";
  }

  function parseXmlTimed(input) {
    const text = String(input || "");
    const cues = [];
    const pattern = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = pattern.exec(text))) {
      const attributes = match[2];
      const startSeconds = Number.parseFloat(attributeValue(attributes, "start"));
      const durationSeconds = Number.parseFloat(attributeValue(attributes, "dur"));
      const startMs = Number.isFinite(startSeconds)
        ? startSeconds * 1000
        : finiteMilliseconds(attributeValue(attributes, "t"), 0);
      const durationMs = Number.isFinite(durationSeconds)
        ? durationSeconds * 1000
        : finiteMilliseconds(attributeValue(attributes, "d"), 0);
      cues.push(makeCue(match[3], startMs, startMs + durationMs));
    }
    return cues.filter(Boolean);
  }

  function parseTimestamp(value) {
    const normalized = String(value || "").trim().replace(",", ".");
    const parts = normalized.split(":");
    if (parts.length < 2 || parts.length > 3) return null;
    const seconds = Number.parseFloat(parts.pop());
    const minutes = Number(parts.pop());
    const hours = parts.length ? Number(parts.pop()) : 0;
    if (![hours, minutes, seconds].every(Number.isFinite)) return null;
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }

  function parseVttOrSrtTimed(input) {
    const blocks = String(input || "").replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      if (lines.some((line) => /^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(line.trim()))) continue;
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      let startMs = 0;
      let endMs = 0;
      let textLines = lines;
      if (timeIndex >= 0) {
        const times = lines[timeIndex].split("-->");
        startMs = parseTimestamp(times[0]);
        endMs = parseTimestamp(String(times[1] || "").trim().split(/\s+/)[0]);
        textLines = lines.slice(timeIndex + 1);
      } else {
        textLines = lines.filter((line) => !/^\d+$/.test(line.trim()));
      }
      const cue = makeCue(textLines.join("\n"), startMs || 0, endMs || startMs || 0);
      if (cue) cues.push(cue);
    }
    return cues;
  }

  function parseSubtitleTimed(input, contentType) {
    const text = String(input || "").trim();
    if (!text) return [];
    const type = String(contentType || "").toLowerCase();
    if (type.includes("json") || text[0] === "{") {
      try { return parseJson3Timed(text); }
      catch (_error) { /* Continue with text formats. */ }
    }
    if (type.includes("xml") || /^<\?xml|^<transcript|^<timedtext/i.test(text)) return parseXmlTimed(text);
    return parseVttOrSrtTimed(text);
  }

  function parseJson3(input) {
    return parseJson3Timed(input).map((cue) => cue.text);
  }

  function parseXml(input) {
    return parseXmlTimed(input).map((cue) => cue.text);
  }

  function parseVttOrSrt(input) {
    return parseVttOrSrtTimed(input).map((cue) => cue.text);
  }

  function parseSubtitle(input, contentType) {
    return parseSubtitleTimed(input, contentType).map((cue) => cue.text);
  }

  function normalized(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function overlapLength(previous, current) {
    const a = Array.from(normalized(previous));
    const b = Array.from(normalized(current));
    const max = Math.min(a.length, b.length);
    for (let length = max; length >= 1; length -= 1) {
      if (a.slice(-length).join("") === b.slice(0, length).join("")) return length;
    }
    return 0;
  }

  function isMeaningfulOverlap(value, length) {
    if (length < 2) return false;
    const fragment = Array.from(normalized(value)).slice(0, length).join("");
    const wordCount = fragment.split(/\s+/).filter(Boolean).length;
    const containsCjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(fragment);
    return containsCjk ? length >= 3 : wordCount >= 3 || length >= 14;
  }

  function dedupeCues(rawCues) {
    const output = [];
    for (const raw of Array.isArray(rawCues) ? rawCues : []) {
      const cue = cleanCueText(raw);
      if (!cue) continue;
      const current = normalized(cue);
      const previousCue = output[output.length - 1];
      const previous = normalized(previousCue);

      if (!previous) { output.push(cue); continue; }
      if (current === previous) continue;

      // Automatic captions often grow the same rolling line over several events.
      if (current.startsWith(previous) && current.length > previous.length) {
        output[output.length - 1] = cue;
        continue;
      }
      if (previous.startsWith(current) || previous.includes(current)) continue;

      // Remove only substantial suffix/prefix overlaps, preserving intentional short repeats.
      const overlap = overlapLength(previous, current);
      if (isMeaningfulOverlap(current, overlap)) {
        const remainder = Array.from(current).slice(overlap).join("").trim();
        if (remainder) output.push(remainder);
        continue;
      }

      // Suppress exact echoes close to one another without deleting legitimate later refrains.
      if (output.slice(-3).some((item) => normalized(item) === current)) continue;
      output.push(cue);
    }
    return output;
  }

  function dedupeTimedCues(rawCues) {
    const output = [];
    for (const raw of Array.isArray(rawCues) ? rawCues : []) {
      const source = typeof raw === "string" ? { text: raw, startMs: 0, endMs: 0 } : raw || {};
      const cue = makeCue(source.text, source.startMs, source.endMs);
      if (!cue) continue;
      const current = normalized(cue.text);
      const previousCue = output[output.length - 1];
      const previous = normalized(previousCue && previousCue.text);

      if (!previous) { output.push(cue); continue; }
      if (current === previous) {
        previousCue.endMs = Math.max(previousCue.endMs, cue.endMs);
        continue;
      }
      if (current.startsWith(previous) && current.length > previous.length) {
        output[output.length - 1] = {
          ...cue,
          startMs: Math.min(previousCue.startMs, cue.startMs),
          endMs: Math.max(previousCue.endMs, cue.endMs)
        };
        continue;
      }
      if (previous.startsWith(current) || previous.includes(current)) {
        previousCue.endMs = Math.max(previousCue.endMs, cue.endMs);
        continue;
      }

      const overlap = overlapLength(previous, current);
      if (isMeaningfulOverlap(current, overlap)) {
        const remainder = Array.from(current).slice(overlap).join("").trim();
        if (remainder) output.push({ ...cue, text: remainder });
        continue;
      }
      if (output.slice(-3).some((item) => normalized(item.text) === current)) continue;
      output.push(cue);
    }
    return output;
  }

  function cueTimeline(rawCues) {
    const cues = dedupeTimedCues(rawCues).map((cue) => ({ ...cue }));
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index];
      if (!Number.isFinite(cue.startMs)) cue.startMs = index ? cues[index - 1].endMs : 0;
      if (!(cue.endMs > cue.startMs)) {
        const nextStart = cues[index + 1] && cues[index + 1].startMs;
        cue.endMs = Number.isFinite(nextStart) && nextStart > cue.startMs ? nextStart : cue.startMs + 2000;
      }
    }
    return cues;
  }

  function formatTimestamp(milliseconds, separator) {
    const total = Math.max(0, Math.round(Number(milliseconds) || 0));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor(total % 3600000 / 60000);
    const seconds = Math.floor(total % 60000 / 1000);
    const millis = total % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator || "."}${String(millis).padStart(3, "0")}`;
  }

  function smartParagraph(parts) {
    return parts.reduce((result, part) => {
      const value = normalized(part);
      if (!value) return result;
      if (!result) return value;
      const boundary = `${Array.from(result).slice(-1)[0] || ""}${Array.from(value)[0] || ""}`;
      const separator = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(boundary) ? "" : " ";
      return result + separator + value;
    }, "");
  }

  function renderText(rawCues, options) {
    const settings = options || {};
    const cues = cueTimeline(rawCues);
    const parts = cues.map((cue) => {
      const text = settings.layout === "paragraph" ? normalized(cue.text) : cue.text;
      if (!settings.includeTimestamps) return text;
      return `[${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}] ${text}`;
    });
    if (settings.layout === "paragraph") return smartParagraph(parts).trim();
    if (settings.layout === "lines") return parts.join("\n").trim();
    return parts.join("\n\n").trim();
  }

  function renderSrt(rawCues) {
    return cueTimeline(rawCues).map((cue, index) => {
      return `${index + 1}\n${formatTimestamp(cue.startMs, ",")} --> ${formatTimestamp(cue.endMs, ",")}\n${cue.text}`;
    }).join("\n\n").trim();
  }

  function renderVtt(rawCues) {
    const body = cueTimeline(rawCues).map((cue) => {
      return `${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}\n${cue.text}`;
    }).join("\n\n");
    return `WEBVTT\n\n${body}`.trim();
  }

  function renderJson(rawCues, metadata) {
    return JSON.stringify({
      version: 1,
      ...metadata,
      cues: cueTimeline(rawCues).map((cue) => ({
        startMs: Math.round(cue.startMs),
        endMs: Math.round(cue.endMs),
        text: cue.text
      }))
    }, null, 2);
  }

  function renderSubtitle(rawCues, options) {
    const settings = options || {};
    if (settings.format === "srt") return renderSrt(rawCues);
    if (settings.format === "vtt") return renderVtt(rawCues);
    if (settings.format === "json") return renderJson(rawCues, settings.metadata || {});
    return renderText(rawCues, settings);
  }

  function toPlainText(rawCues) {
    return renderText(rawCues, { layout: "blocks", includeTimestamps: false });
  }

  global.SubtitleExporterSubtitle = {
    decodeEntities,
    cleanCueText,
    parseJson3,
    parseJson3Timed,
    parseXml,
    parseXmlTimed,
    parseVttOrSrt,
    parseVttOrSrtTimed,
    parseSubtitle,
    parseSubtitleTimed,
    dedupeCues,
    dedupeTimedCues,
    cueTimeline,
    formatTimestamp,
    renderText,
    renderSrt,
    renderVtt,
    renderJson,
    renderSubtitle,
    toPlainText
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
