(async () => {
  const currentScript = document.currentScript;
  const requestId = currentScript?.dataset?.requestId || "";
  const tabUrl = currentScript?.dataset?.tabUrl || location.href;
  const warnings = [];

  try {
    const storageItems = await readBrowserStorage();
    const textIndex = buildTextIndex(storageItems);
    const session = extractSession(textIndex, tabUrl, storageItems);
    const endpointHints = extractEndpointHints(textIndex);
    const cachedCompartments = extractCachedCompartments(storageItems);

    await enrichSessionWithApis(session, endpointHints, warnings);
    const compartments = await loadCompartments(session, endpointHints, cachedCompartments, warnings);

    postResult({
      ok: true,
      session,
      compartments,
      warnings
    });
  } catch (error) {
    postResult({
      ok: false,
      error: error?.message || "Unable to inspect the OCI Console session."
    });
  }

  function postResult(payload) {
    window.postMessage(
      {
        source: "oci-session-info-page-probe",
        requestId,
        payload
      },
      window.location.origin
    );
  }

  async function readBrowserStorage() {
    const items = [];
    readStorageArea("localStorage", window.localStorage, items);
    readStorageArea("sessionStorage", window.sessionStorage, items);
    readCookies(items);
    readWindowGlobals(items);
    readDocumentText(items);
    readPerformanceRegionHints(items);
    await readIndexedDb(items);
    decodeJwtArtifacts(items);
    return items;
  }

  function readStorageArea(areaName, storageArea, items) {
    if (!storageArea) {
      return;
    }

    for (let index = 0; index < storageArea.length; index += 1) {
      const key = storageArea.key(index);
      const rawValue = storageArea.getItem(key);
      items.push({
        source: `${areaName}:${key}`,
        value: parseMaybeJson(rawValue)
      });
    }
  }

  function readWindowGlobals(items) {
    const names = [
      "__APOLLO_STATE__",
      "__OCI__",
      "__INITIAL_STATE__",
      "__PRELOADED_STATE__",
      "oci",
      "OCI"
    ];

    for (const name of names) {
      try {
        if (window[name]) {
          items.push({ source: `window:${name}`, value: cloneJsonSafe(window[name]) });
        }
      } catch (_error) {
        // Some globals may be protected by page code. They are optional hints.
      }
    }
  }

  function readCookies(items) {
    if (!document.cookie) {
      return;
    }

    for (const pair of document.cookie.split(";")) {
      const [name, ...valueParts] = pair.trim().split("=");
      items.push({
        source: `cookie:${name}`,
        value: decodeURIComponent(valueParts.join("=") || "")
      });
    }
  }

  async function readIndexedDb(items) {
    if (!window.indexedDB?.databases) {
      return;
    }

    let databases = [];
    try {
      databases = await window.indexedDB.databases();
    } catch (_error) {
      return;
    }

    for (const databaseInfo of databases.slice(0, 30)) {
      if (!databaseInfo?.name) {
        continue;
      }

      const database = await openIndexedDb(databaseInfo.name).catch(() => null);
      if (!database) {
        continue;
      }

      try {
        for (const storeName of Array.from(database.objectStoreNames).slice(0, 30)) {
          await readIndexedDbStore(database, storeName, items);
        }
      } finally {
        database.close();
      }
    }
  }

  function openIndexedDb(name) {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  function readIndexedDbStore(database, storeName, items) {
    return new Promise((resolve) => {
      let transaction;
      try {
        transaction = database.transaction(storeName, "readonly");
      } catch (_error) {
        resolve();
        return;
      }

      const store = transaction.objectStore(storeName);
      const records = [];
      const request = store.openCursor();

      request.onerror = () => resolve();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= 500) {
          for (const record of records) {
            items.push({
              source: `indexedDB:${database.name}:${storeName}:${String(record.key)}`,
              value: parseMaybeJson(record.value)
            });
          }
          resolve();
          return;
        }

        records.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
    });
  }

  function readDocumentText(items) {
    const bodyText = document.body?.innerText || "";
    if (bodyText) {
      items.push({ source: "document:bodyText", value: bodyText.slice(0, 250000) });
    }
    readApiKeyTableText(items);

    const title = document.title || "";
    if (title) {
      items.push({ source: "document:title", value: title });
    }

    for (const meta of Array.from(document.querySelectorAll("meta[name], meta[property]")).slice(0, 100)) {
      const key = meta.getAttribute("name") || meta.getAttribute("property");
      const content = meta.getAttribute("content");
      if (key && content) {
        items.push({ source: `document:meta:${key}`, value: content });
      }
    }

    for (const script of Array.from(document.scripts).slice(0, 150)) {
      const text = script.textContent || "";
      if (text && /tenancy|tenant|region|namespace|username|userName|preferred_username|identityDomain/i.test(text)) {
        items.push({ source: "document:inlineScript", value: text.slice(0, 250000) });
      }
    }

    for (const element of Array.from(document.querySelectorAll("[aria-label], [title], [data-testid], [data-test-id]")).slice(0, 500)) {
      const descriptor = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid"),
        element.getAttribute("data-test-id")
      ].filter(Boolean).join(" ");

      if (/profile|user|account|avatar|principal|identity/i.test(descriptor)) {
        items.push({
          source: `document:profileElement:${element.tagName.toLowerCase()}`,
          value: {
            ariaLabel: element.getAttribute("aria-label") || "",
            title: element.getAttribute("title") || "",
            testId: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || "",
            text: (element.textContent || "").trim().slice(0, 500)
          }
        });
      }
    }
  }

  function readApiKeyTableText(items) {
    const pageText = document.body?.innerText || "";
    if (!/api keys/i.test(pageText) || !/fingerprint/i.test(pageText)) {
      return;
    }

    const fingerprints = new Set();
    for (const row of Array.from(document.querySelectorAll("tr, [role='row']")).slice(0, 1000)) {
      const rowText = row.innerText || row.textContent || "";
      for (const fingerprint of extractFingerprintsFromText(rowText)) {
        fingerprints.add(fingerprint);
      }
    }

    if (!fingerprints.size) {
      for (const fingerprint of extractFingerprintsFromText(pageText)) {
        fingerprints.add(fingerprint);
      }
    }

    if (fingerprints.size) {
      items.push({
        source: "document:apiKeysTable",
        value: {
          fingerprints: [...fingerprints].sort()
        }
      });
    }
  }

  function extractFingerprintsFromText(text) {
    const fingerprintPattern = /\b(?:[a-f0-9]{2}:){15}[a-f0-9]{2}\b/gi;
    return [...new Set([...String(text || "").matchAll(fingerprintPattern)].map((match) => match[0].toLowerCase()))];
  }

  function readPerformanceRegionHints(items) {
    if (!window.performance?.getEntriesByType) {
      return;
    }

    const regionUrls = [];
    for (const entry of window.performance.getEntriesByType("resource").slice(-500)) {
      const name = String(entry.name || "");
      if (extractRegionFromText(name)) {
        regionUrls.push(name);
      }
    }

    if (regionUrls.length) {
      items.push({
        source: "performance:regionUrls",
        value: regionUrls.slice(0, 100)
      });
    }
  }

  function parseMaybeJson(rawValue) {
    if (!rawValue) {
      return rawValue;
    }

    try {
      return JSON.parse(rawValue);
    } catch (_error) {
      try {
        return JSON.parse(decodeURIComponent(rawValue));
      } catch (_decodeError) {
        return rawValue;
      }
    }
  }

  function decodeJwtArtifacts(items) {
    const jwtPattern = /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*/g;
    const decodedItems = [];

    for (const item of items) {
      const text = typeof item.value === "string" ? item.value : JSON.stringify(item.value);
      if (!text) {
        continue;
      }

      const matches = text.match(jwtPattern) || [];
      for (const token of matches.slice(0, 20)) {
        const payload = decodeJwtPayload(token);
        if (payload) {
          decodedItems.push({
            source: `${item.source}:jwtPayload`,
            value: payload
          });
        }
      }
    }

    items.push(...decodedItems);
  }

  function decodeJwtPayload(token) {
    try {
      const payload = token.split(".")[1];
      const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
      return JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    } catch (_error) {
      return null;
    }
  }

  function cloneJsonSafe(value) {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => {
        if (typeof item === "function") {
          return undefined;
        }
        return item;
      })
    );
  }

  function buildTextIndex(items) {
    const flattened = [];
    for (const item of items) {
      outputSourceHints(item.source, flattened);
      flatten(item.value, item.source, flattened, 0);
    }

    return {
      items,
      flattened,
      joined: flattened.map((entry) => `${entry.path} ${entry.value}`).join("\n")
    };
  }

  function outputSourceHints(source, output) {
    if (!source) {
      return;
    }

    output.push({ path: "sourceHint", value: source });
    for (const part of source.split(/[:/|]/).filter(Boolean)) {
      output.push({ path: "sourcePart", value: part });
    }
  }

  function flatten(value, path, output, depth) {
    if (depth > 8 || value === null || value === undefined) {
      return;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output.push({ path, value: String(value) });
      if (typeof value === "string" && depth < 6 && value.length < 250000) {
        const parsed = parseNestedString(value);
        if (parsed !== value) {
          flatten(parsed, `${path}:parsed`, output, depth + 1);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      value.slice(0, 300).forEach((item, index) => flatten(item, `${path}[${index}]`, output, depth + 1));
      return;
    }

    if (typeof value === "object") {
      Object.entries(value)
        .slice(0, 500)
        .forEach(([key, item]) => flatten(item, `${path}.${key}`, output, depth + 1));
    }
  }

  function parseNestedString(value) {
    const trimmed = value.trim();
    if (!trimmed) {
      return value;
    }

    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      return parseMaybeJson(trimmed);
    }

    if (trimmed.includes("%7B") || trimmed.includes("%5B") || trimmed.includes("%22")) {
      return parseMaybeJson(trimmed);
    }

    return value;
  }

  function extractSession(textIndex, sourceUrl, storageItems) {
    const url = new URL(sourceUrl);
    const regionFromHost = extractRegionFromHost(url.hostname);
    const regionFromPath = extractRegionFromPath(url.pathname);
    const namespaceFromUrl = extractNamespaceFromText(textIndex.joined) || extractNamespaceFromText(sourceUrl);
    const identityDomain = findIdentityDomain(textIndex);
    const identityPrincipal = findIdentityDomainPrincipal(storageItems, identityDomain);
    const userOcid = identityPrincipal.userOcid || findCurrentUserOcid(textIndex);

    const session = {
      tenancyName:
        findByKeys(textIndex, [
          "tenancyName",
          "tenantName",
          "tenant_name",
          "accountName",
          "account_name",
          "tenantDisplayName",
          "tenant_display_name",
          "user_tenantname",
          "res_tenant_name",
          "bmc_tenancy"
        ]) || findTenancyNameFromConsoleKeys(textIndex),
      tenancyOcid: findOcid(textIndex, "tenancy") || findOcidByKeys(textIndex, "tenancy", ["tenantId", "tenancyId", "tenancyOcid", "tenantOcid", "tenant", "res_tenant"]),
      userOcid,
      username: identityPrincipal.username || findUsernameFromIdentityDomain(storageItems, identityDomain, userOcid) || findUsername(textIndex) || findUsernameFromCachedUsers(storageItems, userOcid),
      identityDomain,
      region:
        findRegion(textIndex) ||
        extractRegionFromText(sourceUrl) ||
        extractRegionFromText(textIndex.joined) ||
        extractRegionDisplayNameFromText(textIndex.joined) ||
        regionFromPath ||
        regionFromHost,
      objectStorageNamespace:
        findObjectStorageNamespace(textIndex) ||
        namespaceFromUrl,
      apiKeyFingerprints: findApiKeyFingerprints(textIndex)
    };

    if (!session.objectStorageNamespace && session.tenancyName) {
      // Older OCI tenancies often use the lower-case tenancy name as the namespace.
      session.objectStorageNamespace = session.tenancyName.toLowerCase();
    }

    return session;
  }

  function findApiKeyFingerprints(textIndex) {
    const values = new Set();

    const addMatches = (text) => {
      for (const fingerprint of extractFingerprintsFromText(text)) {
        values.add(fingerprint);
      }
    };

    addMatches(textIndex.joined);
    for (const entry of textIndex.flattened) {
      if (/fingerprint|api.?key|public.?key/i.test(entry.path)) {
        addMatches(entry.value);
      }
    }

    return [...values].sort();
  }

  function findByKeys(textIndex, keys) {
    const loweredKeys = keys.map((key) => key.toLowerCase());
    const scored = [];

    for (const entry of textIndex.flattened) {
      const lowerPath = entry.path.toLowerCase();
      const lowerValue = entry.value.toLowerCase();
      if (!entry.value || entry.value.length > 300) {
        continue;
      }

      for (let index = 0; index < loweredKeys.length; index += 1) {
        const key = loweredKeys[index];
        const priority = loweredKeys.length - index;
        const isExactTail = lowerPath.endsWith(`.${key}`) || lowerPath.endsWith(`:${key}`);
        if (isExactTail || lowerPath.includes(key)) {
          scored.push({ score: (isExactTail ? 20 : 10) + priority, value: entry.value });
        }
      }

      if (/^(tenancy|tenant|region|domain|user|namespace)$/i.test(entry.path) && lowerValue) {
        scored.push({ score: 1, value: entry.value });
      }
    }

    scored.sort((left, right) => right.score - left.score);
    return sanitizeValue(scored[0]?.value || "");
  }

  function findUsername(textIndex) {
    const username = findStrictUsername(textIndex.flattened);

    return username && !username.startsWith("ocid1.") ? username : "";
  }

  function findStrictUsername(entries) {
    const keys = [
      "preferred_username",
      "preferredusername",
      "user_name",
      "username",
      "username",
      "email",
      "mail",
      "upn",
      "unique_name",
      "userprincipalname",
      "principalname"
    ];
    const scored = [];

    for (const entry of entries) {
      const path = entry.path.toLowerCase();
      const value = sanitizeValue(entry.value);
      if (!isLikelyIamUsername(value) || isGroupLikePath(path)) {
        continue;
      }

      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (path.endsWith(`.${key}`) || path.endsWith(`:${key}`)) {
          scored.push({ score: keys.length - index, value });
        }
      }
    }

    scored.sort((left, right) => right.score - left.score);
    return scored[0]?.value || "";
  }

  function findUsernameFromIdentityDomain(items, identityDomain, userOcid) {
    return findIdentityDomainPrincipal(items, identityDomain, userOcid).username;
  }

  function findIdentityDomainPrincipal(items, identityDomain, userOcid = "") {
    const candidates = [];
    for (const item of items) {
      collectIdentityDomainPrincipals(item.value, item.source, identityDomain, userOcid, candidates, 0);
    }

    candidates.sort((left, right) => right.score - left.score);
    return {
      username: candidates.find((candidate) => candidate.username)?.username || "",
      userOcid: candidates.find((candidate) => candidate.userOcid)?.userOcid || ""
    };
  }

  function collectIdentityDomainPrincipals(value, source, identityDomain, userOcid, candidates, depth) {
    if (!value || depth > 8 || isGroupLikePath(source)) {
      return;
    }

    if (typeof value === "string") {
      const parsed = parseNestedString(value);
      if (parsed !== value) {
        collectIdentityDomainPrincipals(parsed, source, identityDomain, userOcid, candidates, depth + 1);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) {
        collectIdentityDomainPrincipals(item, source, identityDomain, userOcid, candidates, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const objectText = JSON.stringify(value).toLowerCase();
    const sourceText = source.toLowerCase();
    const id = sanitizeValue(value.id || value.userId || value.userOcid || value.ocid || value.sub);
    const isJwt = sourceText.includes("jwtpayload");
    const isCurrentUser = userOcid && id === userOcid;
    const isDomainMatch = identityDomain && objectText.includes(identityDomain.toLowerCase());
    const isProfileLike = /(profile|current.?user|principal|session|account|opc-key-store-v2)/i.test(source);

    if (isJwt || isCurrentUser || isDomainMatch || isProfileLike) {
      const username = pickIamUsernameFromObject(value);
      const principalUserOcid = pickUserOcidFromObject(value);
      if (username || principalUserOcid) {
        candidates.push({
          username,
          userOcid: principalUserOcid,
          score: (isJwt ? 80 : 0) + (isCurrentUser ? 60 : 0) + (isDomainMatch ? 40 : 0) + (isProfileLike ? 20 : 0) + (username ? 5 : 0) + (principalUserOcid ? 5 : 0)
        });
      }
    }

    for (const [key, nested] of Object.entries(value).slice(0, 500)) {
      if (isGroupLikePath(key)) {
        continue;
      }
      collectIdentityDomainPrincipals(nested, `${source}.${key}`, identityDomain, userOcid, candidates, depth + 1);
    }
  }

  function pickIamUsernameFromObject(value) {
    const candidates = [
      value.preferred_username,
      value.preferredUsername,
      value.userName,
      value.username,
      value.user_name,
      value.userDisplayName,
      value.user_display_name,
      value.email,
      value.mail,
      value.upn,
      value.unique_name,
      value.userPrincipalName,
      value.principalName,
      value.ariaLabel,
      value.title,
      value.text,
      value.displayName,
      value.display_name,
      value.name
    ];

    for (const candidate of candidates) {
      const username = sanitizeValue(candidate);
      if (isLikelyIamUsername(username)) {
        return username;
      }

      const extractedUsername = extractIamUsernameFromText(candidate);
      if (extractedUsername) {
        return extractedUsername;
      }
    }

    return "";
  }

  function extractIamUsernameFromText(value) {
    const text = sanitizeValue(value);
    if (!text) {
      return "";
    }

    const emailMatch = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    if (emailMatch && isLikelyIamUsername(emailMatch[0])) {
      return emailMatch[0];
    }

    const labeledMatch = text.match(/\b(?:user(?:name)?|principal|account)\s*[:=]\s*([a-z0-9._%+-]{3,})\b/i);
    if (labeledMatch && isLikelyIamUsername(labeledMatch[1])) {
      return labeledMatch[1];
    }

    return "";
  }

  function pickUserOcidFromObject(value) {
    const candidates = [
      value.userOcid,
      value.userOCID,
      value.userId,
      value.user_id,
      value.principalId,
      value.principal_id,
      value.id,
      value.ocid,
      value.sub
    ];

    for (const candidate of candidates) {
      const userOcid = sanitizeValue(candidate);
      if (userOcid.startsWith("ocid1.user.")) {
        return userOcid;
      }
    }

    return "";
  }

  function isLikelyIamUsername(value) {
    const username = sanitizeValue(value);
    if (!username || username.startsWith("ocid1.") || normalizeRegion(username)) {
      return false;
    }

    if (isGroupLikeUsername(username) || /^(orchestration|objectstorage|namespace|region|tenancy|compartment|bucket|oraclecloud)$/i.test(username)) {
      return false;
    }

    return username.includes("@") || /^[a-z0-9._%+-]{3,}$/i.test(username);
  }

  function isGroupLikePath(path) {
    return /(^|[.:_\-/\[\]])(group|groups|grp|roles|role|members|membership|policies|policy)([.:_\-/\[\]]|$)/i.test(path);
  }

  function isGroupLikeUsername(value) {
    const username = sanitizeValue(value).toLowerCase();
    const localPart = username.split("@")[0] || username;
    return /(^|[_\-.])(grp|group|groups|admins|operators|readers|writers|policies|policy)([_\-.]|$)/i.test(localPart);
  }

  function findUsernameFromCachedUsers(items, userOcid) {
    if (!userOcid) {
      return "";
    }

    for (const item of items) {
      const username = findUsernameInObject(item.value, userOcid, 0);
      if (username) {
        return username;
      }
    }

    return "";
  }

  function findUsernameInObject(value, userOcid, depth) {
    if (!value || depth > 10) {
      return "";
    }

    if (typeof value === "string") {
      const parsed = parseNestedString(value);
      if (parsed !== value) {
        return findUsernameInObject(parsed, userOcid, depth + 1);
      }
      return "";
    }

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 1000)) {
        const username = findUsernameInObject(item, userOcid, depth + 1);
        if (username) {
          return username;
        }
      }
      return "";
    }

    if (typeof value !== "object") {
      return "";
    }

    const id = value.id || value.userId || value.userOcid || value.ocid;
    if (id === userOcid) {
      return pickIamUsernameFromObject(value);
    }

    for (const nested of Object.values(value).slice(0, 500)) {
      const username = findUsernameInObject(nested, userOcid, depth + 1);
      if (username) {
        return username;
      }
    }

    return "";
  }

  function findIdentityDomain(textIndex) {
    const domain = findByKeys(textIndex, [
      "identityDomain",
      "identity_domain",
      "identityDomainName",
      "identity_domain_name",
      "domainName",
      "domain_name",
      "idcsDomain",
      "idcs_domain",
      "idcsDomainName",
      "idcs_domain_name",
      "last_used_domain"
    ]);

    if (!domain || domain.includes("@") || domain.startsWith("ocid1.")) {
      return "";
    }

    return domain;
  }

  function findRegion(textIndex) {
    const region = findByKeys(textIndex, [
      "activeRegionID",
      "activeRegionId",
      "active_region_id",
      "region",
      "regionId",
      "region_id",
      "regionName",
      "region_name",
      "selectedRegion",
      "selected_region",
      "currentRegion",
      "current_region",
      "realmRegion",
      "homeRegion"
    ]);

    return normalizeRegion(region);
  }

  function normalizeRegion(value) {
    const region = sanitizeValue(value).toLowerCase();
    const match = region.match(/[a-z]+-[a-z]+-\d+/);
    if (match) {
      return match[0];
    }

    const compact = region.replace(/[^a-z0-9]/g, "");
    const regionMap = {
      ams: "eu-amsterdam-1",
      arn: "eu-stockholm-1",
      auh: "me-abudhabi-1",
      australiaeastsydney: "ap-sydney-1",
      australiasoutheastmelbourne: "ap-melbourne-1",
      bog: "sa-bogota-1",
      bom: "ap-mumbai-1",
      brazileastsaopaulo: "sa-saopaulo-1",
      brazilsoutheastvinhedo: "sa-vinhedo-1",
      canadacentralmontreal: "ca-montreal-1",
      canadacentral: "ca-montreal-1",
      canadasoutheasttoronto: "ca-toronto-1",
      canadasoutheast: "ca-toronto-1",
      cdg: "eu-paris-1",
      chilecentralsantiago: "sa-santiago-1",
      colombiacentralbogota: "sa-bogota-1",
      dfw: "us-dallas-1",
      dxb: "me-dubai-1",
      francecentralparis: "eu-paris-1",
      fra: "eu-frankfurt-1",
      germanycentralfrankfurt: "eu-frankfurt-1",
      gru: "sa-saopaulo-1",
      hyd: "ap-hyderabad-1",
      iad: "us-ashburn-1",
      icn: "ap-seoul-1",
      indiawestmumbai: "ap-mumbai-1",
      indiasouthhyderabad: "ap-hyderabad-1",
      israelcentraljerusalem: "il-jerusalem-1",
      jed: "me-jeddah-1",
      jnb: "af-johannesburg-1",
      japancentralosaka: "ap-osaka-1",
      japaneasttokyo: "ap-tokyo-1",
      kix: "ap-osaka-1",
      lhr: "uk-london-1",
      lin: "eu-milan-1",
      mel: "ap-melbourne-1",
      mexicocentralqueretaro: "mx-queretaro-1",
      mrs: "eu-marseille-1",
      mtz: "mx-queretaro-1",
      netherlandsnorthwestamsterdam: "eu-amsterdam-1",
      nrt: "ap-tokyo-1",
      phx: "us-phoenix-1",
      qro: "mx-queretaro-1",
      ruh: "me-riyadh-1",
      saudiarabiawestjeddah: "me-jeddah-1",
      scl: "sa-santiago-1",
      sin: "ap-singapore-1",
      singapore: "ap-singapore-1",
      sjc: "us-sanjose-1",
      southafricacentraljohannesburg: "af-johannesburg-1",
      southkoreacentral: "ap-seoul-1",
      southkoreacentralseoul: "ap-seoul-1",
      southkoreanorthchuncheon: "ap-chuncheon-1",
      syd: "ap-sydney-1",
      swedencentralstockholm: "eu-stockholm-1",
      switzerlandnorthzurich: "eu-zurich-1",
      uaeeastdubai: "me-dubai-1",
      uaeedubai: "me-dubai-1",
      uknorthnewport: "uk-cardiff-1",
      uksouthlondon: "uk-london-1",
      useastashburn: "us-ashburn-1",
      uswestphoenix: "us-phoenix-1",
      vcp: "sa-vinhedo-1",
      yul: "ca-montreal-1",
      yyz: "ca-toronto-1",
      zrh: "eu-zurich-1"
    };

    if (regionMap[compact]) {
      return regionMap[compact];
    }

    const underscoreRegion = region.replace(/_/g, "-");
    const underscoreMatch = underscoreRegion.match(/[a-z]+-[a-z]+-\d+/);
    if (underscoreMatch) {
      return underscoreMatch[0];
    }

    return match?.[0] || "";
  }

  function findCurrentUserOcid(textIndex) {
    return findOcidByKeys(textIndex, "user", ["userId", "userOcid", "principalId", "sub", "subject"]) ||
      findUserOcidFromConsoleKeys(textIndex) ||
      findOcid(textIndex, "user");
  }

  function findUserOcidFromConsoleKeys(textIndex) {
    for (const entry of textIndex.flattened) {
      const text = sanitizeValue(entry.value);
      if (!/duplo|hg-session|ocid1\.user\./i.test(text)) {
        continue;
      }

      const match = text.match(/ocid1\.user\.[a-z0-9_-]+(?:\.[a-z0-9_-]*)+/i);
      if (match) {
        return match[0];
      }
    }

    return "";
  }

  function findTenancyNameFromConsoleKeys(textIndex) {
    for (const entry of textIndex.flattened) {
      const text = sanitizeValue(entry.value);
      if (!/duplo|hg-session|compartments/i.test(text)) {
        continue;
      }

      const name = extractTenancyNameFromText(text);
      if (name) {
        return name;
      }
    }

    return "";
  }

  function extractTenancyNameFromText(text) {
    const patterns = [
      /duplo\s*[-:]\s*compartments\s+([^/\s:]+)\//i,
      /duplo\s*[-:]\s*([^/\s:]+)\/ocid1\.user\./i,
      /hg-session-([^/\s:]+)\/ocid1\.user\./i,
      /bmc_tenancy[:=]\s*([^;\s]+)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      const value = sanitizeValue(match?.[1] || "");
      if (value && !value.startsWith("ocid1.") && !value.includes(".")) {
        return value;
      }
    }

    return "";
  }

  function findOcid(textIndex, type) {
    const regex = new RegExp(`ocid1\\.${type}\\.[a-z0-9_-]+(?:\\.[a-z0-9_-]*)+`, "i");
    const match = textIndex.joined.match(regex);
    return match?.[0] || "";
  }

  function findOcidByKeys(textIndex, type, keys) {
    const loweredKeys = keys.map((key) => key.toLowerCase());
    for (const entry of textIndex.flattened) {
      const lowerPath = entry.path.toLowerCase();
      const value = sanitizeValue(entry.value);
      if (!value.startsWith(`ocid1.${type}.`)) {
        continue;
      }

      if (loweredKeys.some((key) => lowerPath.endsWith(`.${key}`) || lowerPath.includes(key))) {
        return value;
      }
    }

    return "";
  }

  function extractRegionFromHost(hostname) {
    const match = hostname.match(/(?:console|cloud)\.([a-z]+-[a-z]+-\d+)\.oraclecloud\.com/i);
    return match?.[1] || "";
  }

  function extractRegionFromPath(pathname) {
    const match = pathname.match(/regions\/([a-z]+-[a-z]+-\d+)/i);
    return match?.[1] || "";
  }

  function extractRegionFromText(text) {
    const value = String(text || "");
    const patterns = [
      /\b[a-z0-9-]+\.([a-z]+-[a-z]+-\d+)\.(?:oci\.)?oraclecloud\.com\b/i,
      /[?&](?:region|regionId|regionIdentifier)=([a-z]+-[a-z]+-\d+)/i,
      /\/regions\/([a-z]+-[a-z]+-\d+)/i,
      /"region"\s*:\s*"([a-z]+-[a-z]+-\d+)"/i,
      /"regionId"\s*:\s*"([a-z]+-[a-z]+-\d+)"/i
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      const region = normalizeRegion(match?.[1] || "");
      if (region) {
        return region;
      }
    }

    return "";
  }

  function extractRegionDisplayNameFromText(text) {
    const compact = String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const displayNames = {
      australiaeastsydney: "ap-sydney-1",
      australiasoutheastmelbourne: "ap-melbourne-1",
      brazileastsaopaulo: "sa-saopaulo-1",
      brazilsoutheastvinhedo: "sa-vinhedo-1",
      canadacentralmontreal: "ca-montreal-1",
      canadasoutheasttoronto: "ca-toronto-1",
      chilecentralsantiago: "sa-santiago-1",
      colombiacentralbogota: "sa-bogota-1",
      francecentralparis: "eu-paris-1",
      germanycentralfrankfurt: "eu-frankfurt-1",
      indiawestmumbai: "ap-mumbai-1",
      indiasouthhyderabad: "ap-hyderabad-1",
      israelcentraljerusalem: "il-jerusalem-1",
      japancentralosaka: "ap-osaka-1",
      japaneasttokyo: "ap-tokyo-1",
      mexicocentralqueretaro: "mx-queretaro-1",
      netherlandsnorthwestamsterdam: "eu-amsterdam-1",
      saudiarabiawestjeddah: "me-jeddah-1",
      southafricacentraljohannesburg: "af-johannesburg-1",
      southkoreacentralseoul: "ap-seoul-1",
      southkoreanorthchuncheon: "ap-chuncheon-1",
      swedencentralstockholm: "eu-stockholm-1",
      switzerlandnorthzurich: "eu-zurich-1",
      uaeeastdubai: "me-dubai-1",
      uknorthnewport: "uk-cardiff-1",
      uksouthlondon: "uk-london-1",
      useastashburn: "us-ashburn-1",
      uswestphoenix: "us-phoenix-1"
    };

    for (const [name, region] of Object.entries(displayNames)) {
      if (compact.includes(name)) {
        return region;
      }
    }

    return "";
  }

  function extractNamespaceFromText(text) {
    const match = text.match(/https?:\/\/([a-z0-9_-]+)\.(?:compat\.)?objectstorage\.[a-z0-9-]+\.oraclecloud\.com/i) ||
      text.match(/objectstorage[.\w-]*\.oraclecloud\.com\/n\/([^/\s"'<>]+)/i) ||
      text.match(/\/n\/([^/\s"'<>]+)\/b\//i) ||
      text.match(/namespace(?:Name)?["'\s:=]+([a-z0-9_-]{3,})/i);
    return sanitizeValue(match?.[1] || "");
  }

  function findObjectStorageNamespace(textIndex) {
    const namespace = findByKeys(textIndex, [
      "objectStorageNamespace",
      "objectstorageNamespace",
      "object_storage_namespace",
      "osNamespace",
      "os_namespace",
      "namespaceName",
      "namespace_name"
    ]);

    if (isLikelyNamespace(namespace)) {
      return namespace;
    }

    const fromText = extractNamespaceFromText(textIndex.joined);
    return isLikelyNamespace(fromText) ? fromText : "";
  }

  function isLikelyNamespace(value) {
    const namespace = sanitizeValue(value);
    return /^[a-z0-9_-]{3,}$/.test(namespace) &&
      !namespace.startsWith("ocid1.") &&
      !/^(objectstorage|namespace|region|tenancy|compartment|bucket|oraclecloud)$/i.test(namespace);
  }

  function extractEndpointHints(textIndex) {
    const urls = new Set();
    const regex = /https:\/\/[^\s"'<>]+\/20160918\/(?:compartments|tenancies|users)[^\s"'<>]*/gi;
    let match;
    while ((match = regex.exec(textIndex.joined))) {
      urls.add(match[0].replace(/\\u0026/g, "&"));
    }
    return [...urls];
  }

  async function enrichSessionWithApis(session, endpointHints, warningList) {
    if (session.tenancyOcid) {
      const tenancyEndpoints = buildIdentityEndpoints(
        session,
        endpointHints,
        `/20160918/tenancies/${encodeURIComponent(session.tenancyOcid)}`
      );
      const tenancy = await firstJson(tenancyEndpoints, warningList);
      if (tenancy) {
        session.tenancyName ||= tenancy.name || tenancy.description || "";
        session.tenancyOcid ||= tenancy.id || "";
      }
    }

    if (session.userOcid && !session.username) {
      const userEndpoints = buildIdentityEndpoints(
        session,
        endpointHints,
        `/20160918/users/${encodeURIComponent(session.userOcid)}`
      );
      const user = await firstJson(userEndpoints, warningList);
      if (user) {
        session.username = user.name || user.email || user.description || "";
      }
    }

    if (session.region && !session.objectStorageNamespace) {
      const namespace = await fetchObjectNamespace(session.region, warningList);
      if (namespace) {
        session.objectStorageNamespace = namespace;
      }
    }
  }

  async function loadCompartments(session, endpointHints, cachedCompartments, warningList) {
    if (!session.tenancyOcid) {
      if (cachedCompartments.length) {
        warningList.push("Tenancy OCID was not found, so live compartment refresh was skipped. Showing cached Console compartments.");
        return cachedCompartments;
      }

      warningList.push("Tenancy OCID was not found, so compartments could not be requested.");
      return [];
    }

    const search = new URLSearchParams({
      compartmentId: session.tenancyOcid,
      accessLevel: "ACCESSIBLE",
      compartmentIdInSubtree: "true",
      lifecycleState: "ACTIVE"
    });
    const compartmentsPath = `/20160918/compartments?${search.toString()}`;
    const compartmentsEndpoints = buildIdentityEndpoints(session, endpointHints, compartmentsPath);
    const compartments = await firstJson(compartmentsEndpoints, warningList);
    if (!Array.isArray(compartments)) {
      if (cachedCompartments.length) {
        return ensureRootCompartment(session, cachedCompartments);
      }
      warningList.push("Compartment data could not be retrieved from the OCI API or Console cache.");
      return [];
    }

    return ensureRootCompartment(session, compartments);
  }

  function ensureRootCompartment(session, compartments) {
    const root = {
      id: session.tenancyOcid,
      name: session.tenancyName || "Root tenancy",
      description: "Root tenancy",
      lifecycleState: "ACTIVE"
    };

    if (compartments.some((compartment) => compartment.id === session.tenancyOcid)) {
      return compartments;
    }

    return [root, ...compartments];
  }

  function extractCachedCompartments(items) {
    const byId = new Map();

    for (const item of items) {
      collectCompartmentObjects(item.value, byId, 0);
    }

    return [...byId.values()];
  }

  function collectCompartmentObjects(value, byId, depth) {
    if (!value || depth > 10) {
      return;
    }

    if (typeof value === "string") {
      const parsed = parseNestedString(value);
      if (parsed !== value) {
        collectCompartmentObjects(parsed, byId, depth + 1);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 1000)) {
        collectCompartmentObjects(item, byId, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const id = value.id || value.compartmentId;
    if (typeof id === "string" && id.startsWith("ocid1.compartment.")) {
      byId.set(id, {
        id,
        name: value.name || value.displayName || value.compartmentName || "Unnamed compartment",
        description: value.description || "",
        lifecycleState: value.lifecycleState || value.state || "",
        compartmentId: value.compartmentId || value.parentId || value.parentCompartmentId || "",
        path: value.path || value.compartmentPath || ""
      });
    }

    for (const nested of Object.values(value).slice(0, 500)) {
      collectCompartmentObjects(nested, byId, depth + 1);
    }
  }

  function buildIdentityEndpoints(session, endpointHints, path) {
    const endpoints = new Set();
    const pathResource = path.split("?")[0].split("/").pop();

    for (const hint of endpointHints) {
      if (hint.includes(`/20160918/${pathResource}`)) {
        endpoints.add(createEndpoint(replaceQueryIfNeeded(hint, path), true));
      }
    }

    if (session.region) {
      endpoints.add(createEndpoint(`https://identity.${session.region}.oci.oraclecloud.com${path}`, false));
      endpoints.add(createEndpoint(`https://identity.${session.region}.oraclecloud.com${path}`, false));
    }

    endpoints.add(createEndpoint(path, false));
    return [...endpoints];
  }

  function createEndpoint(url, reportFailures) {
    return JSON.stringify({ url, reportFailures });
  }

  function replaceQueryIfNeeded(hint, path) {
    if (!path.includes("?")) {
      return hint.split("?")[0];
    }
    return `${hint.split("?")[0]}?${path.split("?")[1]}`;
  }

  async function firstJson(endpoints, warningList) {
    const localWarnings = [];
    for (const endpoint of endpoints) {
      const json = await fetchJson(endpoint, localWarnings);
      if (json) {
        return json;
      }
    }
    warningList.push(...localWarnings.slice(0, 3));
    return null;
  }

  async function fetchObjectNamespace(region, warningList) {
    const endpoints = [
      `https://objectstorage.${region}.oraclecloud.com/n`,
      `https://objectstorage.${region}.oraclecloud.com/n/`,
      "/n/"
    ];

    for (const endpoint of endpoints) {
      const value = await fetchText(endpoint, warningList, false);
      if (value && !value.trim().startsWith("<")) {
        return value.trim().replace(/^"|"$/g, "");
      }
    }

    return "";
  }

  async function fetchJson(endpoint, warningList) {
    const endpointInfo = normalizeEndpoint(endpoint);
    const responseText = await fetchText(endpointInfo.url, warningList, endpointInfo.reportFailures);
    if (!responseText) {
      return null;
    }

    try {
      return JSON.parse(responseText);
    } catch (_error) {
      if (endpointInfo.reportFailures && !looksLikeHtml(responseText)) {
        warningList.push(`Received a non-JSON response from ${endpointInfo.url}.`);
      }
      return null;
    }
  }

  function normalizeEndpoint(endpoint) {
    if (typeof endpoint !== "string") {
      return endpoint;
    }

    try {
      return JSON.parse(endpoint);
    } catch (_error) {
      return {
        url: endpoint,
        reportFailures: true
      };
    }
  }

  function looksLikeHtml(value) {
    const trimmed = value.trim().slice(0, 100).toLowerCase();
    return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html") || trimmed.includes("<head");
  }

  async function fetchText(endpoint, warningList, recordWarnings) {
    try {
      const response = await fetch(endpoint, {
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest"
        }
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return "";
        }

        if (recordWarnings) {
          warningList.push(`${endpoint} returned HTTP ${response.status}.`);
        }
        return "";
      }

      return response.text();
    } catch (error) {
      if (recordWarnings) {
        warningList.push(`${endpoint} could not be requested: ${error?.message || "request failed"}.`);
      }
      return "";
    }
  }

  function sanitizeValue(value) {
    if (value === null || value === undefined) {
      return "";
    }

    return String(value)
      .replace(/^["']|["']$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
})();
