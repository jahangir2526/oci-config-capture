(() => {
  if (window.__ociSessionInfoContentLoaded) {
    return;
  }
  window.__ociSessionInfoContentLoaded = true;

  const REQUEST_TIMEOUT_MS = 20000;
  let pendingRequest = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "OCI_COLLECT_SESSION") {
      return false;
    }

    collectFromPage(message.tabUrl)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Unable to collect OCI session details."
        });
      });

    return true;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "oci-session-info-page-probe") {
      return;
    }

    if (!pendingRequest || event.data.requestId !== pendingRequest.requestId) {
      return;
    }

    pendingRequest.resolve(event.data.payload);
    pendingRequest = null;
  });

  async function collectFromPage(tabUrl) {
    const requestId = `oci-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const payload = await new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingRequest = null;
        reject(new Error("Timed out while reading OCI Console session data."));
      }, REQUEST_TIMEOUT_MS);

      pendingRequest = {
        requestId,
        resolve: (data) => {
          window.clearTimeout(timeoutId);
          resolve(data);
        }
      };

      injectProbe(requestId, tabUrl);
    });

    return normalizePayload(payload, tabUrl);
  }

  function injectProbe(requestId, tabUrl) {
    const existing = document.getElementById("oci-session-info-page-probe");
    if (existing) {
      existing.remove();
    }

    const script = document.createElement("script");
    script.id = "oci-session-info-page-probe";
    script.src = chrome.runtime.getURL("src/page-probe.js");
    script.dataset.requestId = requestId;
    script.dataset.tabUrl = tabUrl;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function normalizePayload(payload, tabUrl) {
    if (!payload?.ok) {
      return {
        ok: false,
        code: payload?.code || "COLLECT_FAILED",
        error: payload?.error || "OCI session data could not be read."
      };
    }

    const session = payload.session || {};
    const compartments = Array.isArray(payload.compartments) ? payload.compartments : [];

    return {
      ok: true,
      tabUrl,
      collectedAt: new Date().toISOString(),
      session: {
        tenancyName: cleanValue(session.tenancyName),
        tenancyOcid: cleanValue(session.tenancyOcid),
        identityDomain: cleanValue(session.identityDomain),
        username: cleanValue(session.username),
        userOcid: cleanValue(session.userOcid),
        region: cleanValue(session.region),
        objectStorageNamespace: cleanValue(session.objectStorageNamespace),
        apiKeyFingerprints: Array.isArray(session.apiKeyFingerprints)
          ? session.apiKeyFingerprints.map(cleanValue).filter(Boolean)
          : []
      },
      compartments: compartments
        .filter((compartment) => compartment && compartment.id)
        .map((compartment) => ({
          id: cleanValue(compartment.id),
          name: cleanValue(compartment.name || compartment.displayName),
          description: cleanValue(compartment.description),
          lifecycleState: cleanValue(compartment.lifecycleState),
          parentId: cleanValue(compartment.compartmentId || compartment.parentId || compartment.parentCompartmentId),
          path: cleanValue(compartment.path)
        }))
        .sort((left, right) => (left.name || "").localeCompare(right.name || "")),
      warnings: Array.isArray(payload.warnings) ? payload.warnings : []
    };
  }

  function cleanValue(value) {
    if (value === null || value === undefined) {
      return "";
    }
    return String(value).trim();
  }
})();
