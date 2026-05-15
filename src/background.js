const OCI_HOST_RE = /(^|\.)((console\.)?[^/]*oraclecloud\.com|oci\.oraclecloud\.com|oracle\.com)$/i;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "OCI_CAPTURE_ACTIVE_TAB") {
    return false;
  }

  captureActiveTab()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "Unable to inspect the active tab."
      });
    });

  return true;
});

async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active browser tab was found.");
  }

  const url = new URL(tab.url);
  if (!OCI_HOST_RE.test(url.hostname)) {
    return {
      ok: false,
      code: "NOT_OCI_CONSOLE",
      error: "Open an OCI Console tab, sign in, then reopen this popup."
    };
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content.js"]
  });

  return chrome.tabs.sendMessage(tab.id, {
    type: "OCI_COLLECT_SESSION",
    tabUrl: tab.url
  });
}
