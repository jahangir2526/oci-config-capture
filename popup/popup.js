const elements = {
  statusText: document.getElementById("statusText"),
  captureButton: document.getElementById("captureButton"),
  copyAllButton: document.getElementById("copyAllButton"),
  errorPanel: document.getElementById("errorPanel"),
  warningsPanel: document.getElementById("warningsPanel"),
  tenancyName: document.getElementById("tenancyName"),
  tenancyOcid: document.getElementById("tenancyOcid"),
  identityDomain: document.getElementById("identityDomain"),
  username: document.getElementById("username"),
  userOcid: document.getElementById("userOcid"),
  region: document.getElementById("region"),
  compartmentSearch: document.getElementById("compartmentSearch"),
  compartmentList: document.getElementById("compartmentList"),
  compartmentCount: document.getElementById("compartmentCount"),
  selectedCompartmentPath: document.getElementById("selectedCompartmentPath"),
  selectedCompartmentOcid: document.getElementById("selectedCompartmentOcid")
};

const state = {
  session: {},
  compartments: [],
  selectedCompartmentId: "",
  expandedCompartmentIds: new Set(),
  isRefreshing: false
};

elements.captureButton.addEventListener("click", capture);
elements.copyAllButton.addEventListener("click", copyAllFields);
elements.compartmentSearch.addEventListener("input", renderCompartments);

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => copyField(button));
});

updateCopyButtons();

async function capture() {
  if (state.isRefreshing) {
    return;
  }

  state.isRefreshing = true;
  setLoading(true);
  clearError();
  clearWarnings();

  try {
    const response = await chrome.runtime.sendMessage({ type: "OCI_CAPTURE_ACTIVE_TAB" });
    if (!response?.ok) {
      showError(response?.error || "Unable to read the OCI Console session.");
      resetSession();
      return;
    }

    renderSession(response.session);
    state.session = response.session || {};
    const previousSelection = state.selectedCompartmentId;
    state.compartments = response.compartments || [];
    const rootCompartmentId = state.session.tenancyOcid || "";
    state.selectedCompartmentId = previousSelection && (previousSelection === rootCompartmentId || state.compartments.some((compartment) => compartment.id === previousSelection))
      ? previousSelection
      : rootCompartmentId || state.compartments[0]?.id || "";
    initializeExpandedCompartments();
    renderCompartments();
    renderWarnings(response.warnings);
    elements.statusText.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    showError(error?.message || "Unexpected error while collecting OCI session data.");
    resetSession();
  } finally {
    state.isRefreshing = false;
    setLoading(false);
  }
}

function setLoading(isLoading) {
  elements.captureButton.disabled = isLoading;
  elements.captureButton.textContent = isLoading ? "Capturing..." : "Capture";
  if (isLoading) {
    elements.statusText.textContent = "Reading active tab...";
  }
}

function renderSession(session = {}) {
  setText(elements.tenancyName, session.tenancyName);
  setText(elements.tenancyOcid, session.tenancyOcid);
  setText(elements.identityDomain, session.identityDomain);
  setText(elements.username, session.username);
  setText(elements.userOcid, session.userOcid);
  setText(elements.region, session.region);
  updateCopyButtons();
}

function renderCompartments() {
  const query = elements.compartmentSearch.value.trim().toLowerCase();
  const treeRows = buildCompartmentTreeRows(state.compartments, query, state.session);

  if (treeRows.length && !treeRows.some((row) => row.compartment.id === state.selectedCompartmentId)) {
    state.selectedCompartmentId = treeRows[0].compartment.id;
  }

  elements.compartmentCount.textContent = String(treeRows.length);
  elements.compartmentList.replaceChildren();

  if (!treeRows.length) {
    const empty = document.createElement("div");
    empty.className = "compartment-row";
    empty.textContent = state.compartments.length ? "No matching compartments." : "No compartments found.";
    elements.compartmentList.append(empty);
    setText(elements.selectedCompartmentPath, getSelectedCompartmentPath());
    setText(elements.selectedCompartmentOcid, getSelectedCompartment()?.id);
    updateCopyButtons();
    return;
  }

  for (const rowData of treeRows) {
    const { compartment, depth, hasChildren, isExpanded, matchesQuery, isLast } = rowData;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "compartment-row";
    row.style.setProperty("--tree-depth", String(depth));
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(compartment.id === state.selectedCompartmentId));
    row.setAttribute("aria-level", String(depth + 1));
    row.dataset.match = String(matchesQuery);
    row.dataset.depth = String(depth);
    row.dataset.last = String(isLast);
    row.setAttribute("aria-expanded", hasChildren ? String(isExpanded) : "false");
    row.addEventListener("mouseenter", () => {
      row.focus();
    });
    row.addEventListener("click", () => {
      state.selectedCompartmentId = compartment.id;
      setText(elements.selectedCompartmentPath, getSelectedCompartmentPath());
      setText(elements.selectedCompartmentOcid, compartment.id);
      renderCompartments();
    });

    const branch = document.createElement("span");
    branch.className = "tree-branch";
    branch.textContent = hasChildren ? (isExpanded ? "▼" : "▶") : "";
    branch.setAttribute("aria-hidden", "true");

    if (hasChildren) {
      branch.classList.add("tree-branch-toggle");
      branch.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleCompartment(compartment.id);
      });
    }

    const content = document.createElement("span");
    content.className = "compartment-content";

    const name = document.createElement("span");
    name.className = "compartment-name";
    name.textContent = compartment.name || "Unnamed compartment";

    content.append(name);
    row.append(branch, content);
    elements.compartmentList.append(row);
  }

  setText(elements.selectedCompartmentPath, getSelectedCompartmentPath());
  setText(elements.selectedCompartmentOcid, getSelectedCompartment()?.id);
  updateCopyButtons();
}

function getSelectedCompartment() {
  if (state.session.tenancyOcid && state.selectedCompartmentId === state.session.tenancyOcid) {
    return {
      id: state.session.tenancyOcid,
      name: state.session.tenancyName ? `${state.session.tenancyName} (root)` : "Root tenancy"
    };
  }
  return state.compartments.find((compartment) => compartment.id === state.selectedCompartmentId);
}

function getSelectedCompartmentPath() {
  if (!state.selectedCompartmentId) {
    return "";
  }

  const normalized = normalizeCompartments(state.compartments, state.session);
  const byId = new Map(normalized.map((compartment) => [compartment.id, compartment]));
  const root = state.session.tenancyOcid ? byId.get(state.session.tenancyOcid) : normalized.find((compartment) => !compartment.parentId);
  if (root) {
    const childrenByParent = buildChildrenByParent(normalized, byId);
    attachRootFallbackChildren(normalized, root, byId, childrenByParent);
  }

  const path = [];
  const visited = new Set();
  let current = byId.get(state.selectedCompartmentId) || getSelectedCompartment();
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.name || "Unnamed compartment");
    current = current.parentId ? byId.get(current.parentId) : null;
  }

  return path.join(":");
}

function buildCompartmentTreeRows(compartments, query, session = {}) {
  const normalized = normalizeCompartments(compartments, session);
  const byId = new Map(normalized.map((compartment) => [compartment.id, compartment]));
  const childrenByParent = buildChildrenByParent(normalized, byId);
  const roots = normalized.filter((compartment) => !compartment.parentId || !byId.has(compartment.parentId) || compartment.parentId === compartment.id);
  roots.sort((left, right) => compareRootCompartments(left, right, session.tenancyOcid));

  const root = (session.tenancyOcid && byId.get(session.tenancyOcid)) || roots[0];
  if (!root) {
    return [];
  }

  attachRootFallbackChildren(normalized, root, byId, childrenByParent);

  const matches = new Set();
  const include = new Set();
  if (query) {
    for (const compartment of normalized) {
      if (compartmentMatches(compartment, query)) {
        matches.add(compartment.id);
        include.add(compartment.id);
        let parentId = compartment.parentId;
        while (parentId && byId.has(parentId) && !include.has(parentId)) {
          include.add(parentId);
          parentId = byId.get(parentId).parentId;
        }
      }
    }
  }

  if (query && !include.has(root.id) && !matches.has(root.id)) {
    return [];
  }

  const rows = [];
  appendTreeRows(root, 0, rows, new Set(), childrenByParent, query, include, matches, true);
  return rows;
}

function normalizeCompartments(compartments, session = {}) {
  const rootId = session.tenancyOcid || "";
  const rootName = session.tenancyName ? `${session.tenancyName} (root)` : "Root tenancy";
  const byId = new Map();

  if (rootId) {
    byId.set(rootId, {
      id: rootId,
      name: rootName,
      description: "Root tenancy",
      lifecycleState: "ACTIVE",
      parentId: "",
      path: ""
    });
  }

  for (const compartment of compartments) {
    const id = compartment.id;
    if (!id) {
      continue;
    }

    const inferredParentId = compartment.parentId || inferParentIdFromPath(compartment, compartments);
    const isRoot = rootId && id === rootId;
    byId.set(id, {
      ...compartment,
      name: isRoot ? rootName : compartment.name,
      parentId: isRoot ? "" : inferredParentId || rootId
    });
  }

  return [...byId.values()];
}

function buildChildrenByParent(compartments, byId) {
  const childrenByParent = new Map();

  for (const compartment of compartments) {
    const parentId = compartment.parentId;
    if (parentId && byId.has(parentId) && parentId !== compartment.id) {
      if (!childrenByParent.has(parentId)) {
        childrenByParent.set(parentId, []);
      }
      childrenByParent.get(parentId).push(compartment);
    }
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareCompartments);
  }

  return childrenByParent;
}

function attachRootFallbackChildren(compartments, root, byId, childrenByParent) {
  const rootChildren = childrenByParent.get(root.id) || [];
  const rootChildIds = new Set(rootChildren.map((compartment) => compartment.id));

  for (const compartment of compartments) {
    if (!compartment.id || compartment.id === root.id || rootChildIds.has(compartment.id)) {
      continue;
    }

    const parentId = compartment.parentId || "";
    const shouldAttachToRoot = !parentId || !byId.has(parentId) || isDirectRootChildPath(compartment, root);
    if (shouldAttachToRoot) {
      compartment.parentId = root.id;
      rootChildren.push(compartment);
      rootChildIds.add(compartment.id);
    }
  }

  rootChildren.sort(compareCompartments);
  childrenByParent.set(root.id, rootChildren);
}

function isDirectRootChildPath(compartment, root) {
  if (!compartment.path) {
    return false;
  }

  const pathParts = compartment.path.split(/[\\/]/).filter(Boolean);
  if (pathParts.length !== 2) {
    return false;
  }

  const rootName = String(root.name || "").replace(/\s+\(root\)$/i, "");
  return !rootName || pathParts[0] === rootName;
}

function appendTreeRows(compartment, depth, rows, visited, childrenByParent, query, include, matches, isLast) {
  if (visited.has(compartment.id)) {
    return;
  }
  visited.add(compartment.id);

  const children = childrenByParent.get(compartment.id) || [];
  const visibleChildren = query ? children.filter((child) => include.has(child.id)) : children;
  const isExpanded = Boolean(query) || state.expandedCompartmentIds.has(compartment.id);
  const shouldShow = !query || include.has(compartment.id) || matches.has(compartment.id);
  if (shouldShow) {
    rows.push({
      compartment,
      depth,
      hasChildren: visibleChildren.length > 0,
      isExpanded,
      matchesQuery: !query || matches.has(compartment.id),
      isLast
    });
  }

  if (!isExpanded && !query) {
    return;
  }

  visibleChildren.forEach((child, index) => {
    appendTreeRows(child, depth + 1, rows, visited, childrenByParent, query, include, matches, index === visibleChildren.length - 1);
  });
}

function initializeExpandedCompartments() {
  const previousExpanded = new Set(state.expandedCompartmentIds);
  state.expandedCompartmentIds = new Set();
  for (const compartment of state.compartments) {
    if (previousExpanded.has(compartment.id)) {
      state.expandedCompartmentIds.add(compartment.id);
    }
  }
}

function toggleCompartment(compartmentId) {
  if (state.expandedCompartmentIds.has(compartmentId)) {
    state.expandedCompartmentIds.delete(compartmentId);
  } else {
    state.expandedCompartmentIds.add(compartmentId);
  }
  renderCompartments();
}

function inferParentIdFromPath(compartment, compartments) {
  if (!compartment.path) {
    return "";
  }

  const pathParts = compartment.path.split(/[\\/]/).filter(Boolean);
  if (pathParts.length < 2) {
    return "";
  }

  const parentName = pathParts[pathParts.length - 2];
  const parent = compartments.find((candidate) => candidate.name === parentName);
  return parent?.id || "";
}

function compartmentMatches(compartment, query) {
  const haystack = `${compartment.name || ""} ${compartment.id || ""} ${compartment.description || ""} ${compartment.path || ""}`.toLowerCase();
  return haystack.includes(query);
}

function compareCompartments(left, right) {
  return (left.name || "").localeCompare(right.name || "");
}

function compareRootCompartments(left, right, rootId) {
  if (rootId && left.id === rootId) {
    return -1;
  }
  if (rootId && right.id === rootId) {
    return 1;
  }
  return compareCompartments(left, right);
}

function renderWarnings(warnings = []) {
  const visibleWarnings = warnings.filter(Boolean);
  if (!visibleWarnings.length) {
    clearWarnings();
    return;
  }

  elements.warningsPanel.classList.remove("hidden");
  elements.warningsPanel.textContent = visibleWarnings.join(" ");
}

function showError(message) {
  elements.errorPanel.classList.remove("hidden");
  elements.errorPanel.textContent = message;
  elements.statusText.textContent = "Unable to read session";
}

function clearError() {
  elements.errorPanel.classList.add("hidden");
  elements.errorPanel.textContent = "";
}

function clearWarnings() {
  elements.warningsPanel.classList.add("hidden");
  elements.warningsPanel.textContent = "";
}

function resetSession() {
  renderSession({});
  state.session = {};
  state.compartments = [];
  state.selectedCompartmentId = "";
  state.expandedCompartmentIds.clear();
  renderCompartments();
  elements.statusText.textContent = "Click Capture to read the active OCI tab.";
}

function setText(element, value) {
  element.textContent = value || "-";
}

async function copyField(button) {
  const target = document.getElementById(button.dataset.copyTarget);
  const value = getTargetText(target);
  if (!value || value === "-") {
    return;
  }

  const originalText = button.textContent;
  try {
    await copyText(value);
    selectCopiedText(target);
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = originalText;
    }, 1200);
  } catch (_error) {
    button.textContent = "Failed";
    window.setTimeout(() => {
      button.textContent = originalText;
    }, 1200);
  }
}

async function copyAllFields() {
  const text = [
    ["Tenancy name", elements.tenancyName.textContent],
    ["Tenancy OCID", elements.tenancyOcid.textContent],
    ["Identity Domain", elements.identityDomain.textContent],
    ["Username", elements.username.textContent],
    ["User OCID", elements.userOcid.textContent],
    ["Current region", elements.region.textContent],
    ["Selected path", elements.selectedCompartmentPath.value],
    ["Selected OCID", elements.selectedCompartmentOcid.textContent]
  ]
    .map(([key, value]) => `${key}: ${formatCopyValue(value)}`)
    .join("\n");

  const originalText = elements.copyAllButton.textContent;
  try {
    await copyText(text);
    elements.copyAllButton.textContent = "Copied";
    window.setTimeout(() => {
      elements.copyAllButton.textContent = originalText;
    }, 1200);
  } catch (_error) {
    elements.copyAllButton.textContent = "Failed";
    window.setTimeout(() => {
      elements.copyAllButton.textContent = originalText;
    }, 1200);
  }
}

function formatCopyValue(value) {
  const text = String(value || "").trim();
  return text && text !== "-" ? text : "";
}

function getTargetText(target) {
  if (!target) {
    return "";
  }

  if ("value" in target) {
    return String(target.value || "").trim();
  }

  return String(target.textContent || "").trim();
}

function selectCopiedText(target) {
  if (!target) {
    return;
  }

  if (typeof target.select === "function") {
    target.focus();
    target.select();
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function updateCopyButtons() {
  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    const target = document.getElementById(button.dataset.copyTarget);
    const value = getTargetText(target);
    button.disabled = !value || value === "-";
  });
}
