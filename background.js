"use strict";

function wait(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function showNotification(level, message) {
  const isError = level === "error";
  return new Promise((resolve) => {
    chrome.notifications.getPermissionLevel((permissionLevel) => {
      if (chrome.runtime.lastError || permissionLevel !== "granted") {
        resolve(false);
        return;
      }
      const notificationId = `ytse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: isError ? "YouTube 字幕导出失败" : "YouTube 字幕导出成功",
        message: String(message || (isError ? "请返回视频页面后重试" : "字幕文件已保存到下载目录")),
        priority: isError ? 1 : 0,
        silent: false
      }, (createdId) => {
        const error = chrome.runtime.lastError;
        resolve(Boolean(createdId) && !error);
      });
    });
  });
}

async function showBadge(tabId, level) {
  if (!Number.isInteger(tabId)) return;
  const isError = level === "error";
  await chrome.action.setBadgeBackgroundColor({ tabId, color: isError ? "#b91c1c" : "#15803d" });
  await chrome.action.setBadgeText({ tabId, text: isError ? "!" : "✓" });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}), 10000);
}

async function downloadFile(content, filename, tabId, mimeType, addBom, successMessage) {
  if (typeof content !== "string" || !content.trim()) return { ok: false, code: "EMPTY_SUBTITLE" };
  const allowedTypes = new Set(["text/plain", "application/x-subrip", "text/vtt", "application/json"]);
  const safeType = allowedTypes.has(mimeType) ? mimeType : "text/plain";
  const payload = addBom ? `\uFEFF${content}` : content;
  const dataUrl = `data:${safeType};charset=utf-8,${encodeURIComponent(payload)}`;
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });

  // The open message task keeps the MV3 service worker alive until Chrome
  // reports the real result, so the notification means completed—not queued.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item && item.state === "complete") {
      const notificationShown = await showNotification("success", successMessage || `已保存：${filename}`);
      await showBadge(tabId, "success").catch(() => {});
      return { ok: true, downloadId, state: "complete", notificationShown };
    }
    if (item && item.state === "interrupted") {
      await showNotification("error", `下载中断：${filename}`).catch(() => false);
      await showBadge(tabId, "error").catch(() => {});
      return { ok: false, code: item.error || "DOWNLOAD_INTERRUPTED" };
    }
    await wait(250);
  }

  return { ok: false, code: "DOWNLOAD_TIMEOUT" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === "DOWNLOAD_FILE" || message.type === "DOWNLOAD_TEXT") {
    downloadFile(
      message.content === undefined ? message.text : message.content,
      message.filename,
      sender.tab && sender.tab.id,
      message.mimeType,
      message.addBom !== false,
      message.successMessage
    )
      .then(sendResponse)
      .catch(async () => {
        try {
          await showNotification("error", "字幕文件下载失败，请重试");
          await showBadge(sender.tab && sender.tab.id, "error");
        }
        catch (_error) { /* Ignore notification errors. */ }
        sendResponse({ ok: false, code: "DOWNLOAD_FAILED" });
      });
    return true;
  }
  if (message.type === "SHOW_NOTIFICATION") {
    showNotification(message.level, message.message)
      .then(async (shown) => {
        await showBadge(sender.tab && sender.tab.id, message.level).catch(() => {});
        sendResponse({ ok: true, notificationShown: shown });
      })
      .catch(() => sendResponse({ ok: true, notificationShown: false }));
    return true;
  }
  return false;
});
