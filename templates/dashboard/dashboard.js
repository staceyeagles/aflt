'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMarkdown(value, { documentLinks = true } = {}) {
  const engine = typeof module !== 'undefined' && module.exports && typeof document === 'undefined'
    ? require('./marked.min') : marked;
  const headings = new Set();
  const parser = new engine.Marked({
    gfm: true,
    renderer: {
      html: function (html) { return escapeHtml(html); },
      image: function (href, title, text) {
        return '<span class="markdown-image">[Image: ' + escapeHtml(text) + ']</span>';
      },
      link: function (href, title, text) {
        href = String(href || '').trim();
        if (!href || /[\u0000-\u001f\u007f]/.test(href)) return text;
        const label = title ? ' title="' + escapeHtml(title) + '"' : '';
        if (/^(https?:\/\/|mailto:)/i.test(href)) {
          return '<a href="' + escapeHtml(href) + '"' + label +
            ' target="_blank" rel="noopener noreferrer">' + text + '</a>';
        }
        if (/^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(href)) return text;
        if (!documentLinks) return text;
        return '<a href="#" data-document-link="' + escapeHtml(href) + '"' + label + '>' + text + '</a>';
      },
      heading: function (text, level, raw) {
        const slug = raw.toLowerCase().replace(/<[^>]*>/g, '')
          .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
        const base = 'document-heading-' + slug;
        let id = base;
        let count = 0;
        while (headings.has(id)) id = base + '-' + (++count);
        headings.add(id);
        return '<h' + level + ' id="' + escapeHtml(id) + '">' + text + '</h' + level + '>\n';
      },
    },
  });
  return parser.parse(String(value == null ? '' : value));
}

function resolveDocumentLink(projects, fromPath, href) {
  let target;
  let file;
  let fragment;
  try {
    target = new URL(href, 'https://aflt.invalid/' + fromPath);
    file = decodeURIComponent(target.pathname).slice(1);
    fragment = decodeURIComponent(target.hash.slice(1));
  } catch (error) {
    if (error.name !== 'TypeError' && error.name !== 'URIError') throw error;
    return null;
  }
  if (target.origin !== 'https://aflt.invalid') return null;
  for (const project of projects || []) {
    const doc = project.memory && (project.memory.documents || []).find(function (d) {
      return d.path === file;
    });
    if (doc) return { project: project.id, path: doc.path, fragment: fragment };
  }
  return null;
}

function renderProjectMemory(project, memoryState) {
  const context = project && project.memory;
  const errors = [...((memoryState && memoryState.errors) || []), ...((context && context.errors) || [])];
  let html = errors.map(function (error) {
    return '<p class="memory-error">' + escapeHtml(error) + '</p>';
  }).join('');
  if (!project) return html + '<p class="empty">Select a project to review its status and docs.</p>';
  if (!context) {
    return html + '<p class="empty">' +
      (memoryState && memoryState.configured
        ? 'No memory documents found for this project.'
        : 'No memory repo configured. Use aflt memory init to opt in.') + '</p>';
  }
  if (context.summary) {
    html += '<div class="label">Doc Bot summary</div><p>' + escapeHtml(context.summary.moved) +
      '</p><div class="label">Blocked</div><p>' + escapeHtml(context.summary.blocked) + '</p>';
  } else {
    html += '<p class="empty">No Doc Bot summary recorded for this project.</p>';
  }
  const documents = context.documents || [];
  if (!documents.length) return html + '<p class="empty">No project documents recorded yet.</p>';
  html += '<ul class="memory-documents">';
  documents.forEach(function (doc) {
    html += '<li><button type="button" class="document-link" data-document-path="' +
      escapeHtml(doc.path) + '">' + escapeHtml(doc.title) + '</button><small>' +
      escapeHtml(doc.kind === 'status' ? 'Status note · ' + doc.date : doc.kind === 'readme' ? 'README' : 'Project dashboard') +
      (doc.truncated ? ' · preview limited to 32 KiB' : '') + '</small></li>';
  });
  return html + '</ul>';
}

/** Canonical labels — shared by Graph, History, filters, detail, stats. */
const STATE_LABELS = {
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  completed: 'Completed',
  failed: 'Failed',
};

function stateLabel(state) {
  if (state === 'running') return STATE_LABELS.working;
  if (state === 'done') return STATE_LABELS.completed;
  return STATE_LABELS[state] || STATE_LABELS.completed;
}

function activityLabel(item) {
  if (!item) return stateLabel('completed');
  if (item.kind === 'project' || item.sessionCount != null) {
    return stateLabel(item.filterState || item.displayState || 'idle');
  }
  return stateLabel(rowFilterState(item));
}

/**
 * Per-session live filter/badge state (must match lib/dashboard.sessionFilterState).
 * "working" = actually working (OSC working / live runPid) — not bare herdr.runtime.
 */
function rowFilterState(item) {
  if (!item) return 'completed';
  if (item.awaitingInput || item.activityState === 'waiting') return 'waiting';
  if (item.activityState === 'completed') {
    if (item.displayState === 'failed') return 'failed';
    if (item.displayState === 'running' || item.displayState === 'idle') return 'idle';
    return 'completed';
  }
  if (item.activityState === 'working' || item.displayState === 'running') return 'working';
  if (item.displayState === 'failed') return 'failed';
  if (item.displayState === 'idle') return 'idle';
  // Map legacy filter keys if present on the payload.
  if (item.filterState === 'running') return 'working';
  if (item.filterState === 'done') return 'completed';
  if (item.filterState && STATE_LABELS[item.filterState]) return item.filterState;
  return 'completed';
}

/** Project roll-up priority: waiting > working > failed > idle > completed. */
const FILTER_PRIORITY = ['waiting', 'working', 'failed', 'idle', 'completed'];

const HIDE_DORMANT_STORAGE_KEY = 'aflt.dashboard.hideDormant';
const SHOW_ARCHIVED_STORAGE_KEY = 'aflt.dashboard.showArchived';
const DEFAULT_DORMANT_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Dormant = idle/completed roll-up and last activity older than dormantAfterMs
 * (must match lib/dashboard.isDormantProject). working/waiting/failed never dormant.
 * Missing lastActivity is not dormant (nothing older-than to compare).
 */
function isDormantProject(p, nowMs, dormantAfterMs) {
  if (!p) return false;
  const live = p.filterState || p.displayState || 'idle';
  if (live === 'working' || live === 'running' || live === 'waiting' || live === 'failed') {
    return false;
  }
  const last = p.lastActivity != null ? Date.parse(String(p.lastActivity)) : NaN;
  const windowMs = dormantAfterMs != null ? Number(dormantAfterMs) : DEFAULT_DORMANT_AFTER_MS;
  const threshold = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : DEFAULT_DORMANT_AFTER_MS;
  if (!Number.isFinite(last)) return false;
  return nowMs - last > threshold;
}

function isHerdrFocusLocal(loc) {
  const source = loc || (typeof location !== 'undefined' ? location : null);
  // Missing hostname (tests / file://) → treat as local; only explicit remote hosts are blocked.
  if (!source || source.hostname == null || String(source.hostname).trim() === '') return true;
  const host = String(source.hostname).replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function renderTaskCompletion(completion) {
  if (!completion) return '';
  return '<section class="task-completion"><div class="label">Latest Task Complete</div>' +
    '<p class="completion-meta">' + escapeHtml(completion.sessionTitle) + ' · ' +
    escapeHtml(completion.at) + '</p><div class="completion-body">' +
    renderMarkdown(completion.summary, { documentLinks: false }) + '</div>' +
    (completion.truncated ? '<p class="completion-meta">Preview truncated; the full message is saved in the project note when capture is enabled.</p>' : '') +
    (completion.saveError ? '<p class="memory-error">Could not save completion: ' + escapeHtml(completion.saveError) + '</p>' : '') +
    (completion.notePath ? '<p class="completion-meta">Captured in project docs: <code>' +
      escapeHtml(completion.notePath) + '</code></p>' : '') + '</section>';
}

function renderGraphHint(project, session) {
  if (session) {
    return '<p>State: <strong>' + escapeHtml(activityLabel(session)) + '</strong></p>' +
      '<p>Session ID: <code>' + escapeHtml(session.id) + '</code></p>' +
      '<p>Engine: <strong>' + escapeHtml(session.engine || 'unknown') + '</strong></p>' +
      '<p>Status: <strong>' + escapeHtml(session.status || 'unknown') + '</strong></p>' +
      '<p>Herdr status: <strong>' + escapeHtml(session.herdr && session.herdr.runtime || 'unknown') + '</strong></p>';
  }
  if (!project) return '';
  const summary = project.memory && project.memory.summary;
  return '<div class="label">Doc Bot summary</div><p>' +
    escapeHtml(summary ? summary.moved : 'No Doc Bot summary recorded for this project.') + '</p>';
}

/**
 * Preserve force-sim positions across SSE updates (shared algorithm with lib/dashboard.js).
 * Exported for hermetic Node tests when required without a DOM.
 */
function mergeSimPreserve(prevSim, nextBuilt, opts) {
  opts = opts || {};
  const nextNodes = nextBuilt && Array.isArray(nextBuilt.nodes) ? nextBuilt.nodes : [];
  const nextLinks = nextBuilt && Array.isArray(nextBuilt.links) ? nextBuilt.links : [];
  const prevNodes = prevSim && Array.isArray(prevSim.nodes) ? prevSim.nodes : [];
  const prevById = {};
  for (let i = 0; i < prevNodes.length; i++) {
    const n = prevNodes[i];
    if (n && n.id != null) prevById[n.id] = n;
  }
  const prevIds = Object.keys(prevById);
  const nextIds = {};
  for (let i = 0; i < nextNodes.length; i++) {
    if (nextNodes[i] && nextNodes[i].id != null) nextIds[nextNodes[i].id] = true;
  }
  let nodeSetChanged = prevIds.length !== Object.keys(nextIds).length;
  if (!nodeSetChanged) {
    for (let i = 0; i < prevIds.length; i++) {
      if (!nextIds[prevIds[i]]) {
        nodeSetChanged = true;
        break;
      }
    }
  }

  const nodes = nextNodes.map(function (n) {
    const prev = prevById[n.id];
    if (!prev) return n;
    return Object.assign({}, n, {
      x: prev.x,
      y: prev.y,
      vx: prev.vx != null ? prev.vx : 0,
      vy: prev.vy != null ? prev.vy : 0,
      fixed: prev.fixed != null ? prev.fixed : n.fixed,
    });
  });

  const byId = {};
  for (let i = 0; i < nodes.length; i++) byId[nodes[i].id] = nodes[i];
  const links = nextLinks
    .map(function (l) {
      var source = typeof l.source === 'object' && l.source ? l.source : byId[l.source];
      var target = typeof l.target === 'object' && l.target ? l.target : byId[l.target];
      var src =
        source && source.id != null && byId[source.id] ? byId[source.id] : source;
      var tgt =
        target && target.id != null && byId[target.id] ? byId[target.id] : target;
      if (!src || !tgt) return null;
      return {
        source: src,
        target: tgt,
        kind: l.kind,
        recent: l.recent,
      };
    })
    .filter(Boolean);

  var alpha;
  if (opts.preserveAlpha && prevSim && typeof prevSim.alpha === 'number' && !nodeSetChanged) {
    alpha = prevSim.alpha;
  } else if (nodeSetChanged || !prevSim) {
    alpha = opts.reheatAlpha != null ? opts.reheatAlpha : 1;
  } else {
    alpha = typeof prevSim.alpha === 'number' ? prevSim.alpha : 1;
  }

  return {
    nodes: nodes,
    links: links,
    w: nextBuilt.w,
    h: nextBuilt.h,
    cx: nextBuilt.cx,
    cy: nextBuilt.cy,
    alpha: alpha,
    nodeSetChanged: nodeSetChanged,
  };
}

if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
  module.exports = {
    mergeSimPreserve, renderProjectMemory, renderGraphHint, renderMarkdown, resolveDocumentLink,
    renderTaskCompletion, activityLabel, rowFilterState, stateLabel, isHerdrFocusLocal, isDormantProject,
    STATE_LABELS, FILTER_PRIORITY,
    HIDE_DORMANT_STORAGE_KEY, SHOW_ARCHIVED_STORAGE_KEY, DEFAULT_DORMANT_AFTER_MS,
  };
} else {
  (function () {
    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    const svg = document.getElementById('graph');
    const stage = document.getElementById('stage');
    const metaEl = document.getElementById('meta');
    const statsEl = document.getElementById('stats');
    const detailEl = document.getElementById('detail');
    const eventsEl = document.getElementById('events');
    const spark24 = document.getElementById('spark24');
    const spark7 = document.getElementById('spark7');
    const hintEl = document.getElementById('hint');
    const actionStatus = document.getElementById('action-status');
    const graphTooltip = document.getElementById('graph-tooltip');
    const projectSelect = document.getElementById('project-select');
    const memoryEl = document.getElementById('project-memory');
    const documentDialog = document.getElementById('document-dialog');
    const documentTitle = document.getElementById('document-title');
    const documentPath = document.getElementById('document-path');
    const documentContent = document.getElementById('document-content');
    const documentNotice = document.getElementById('document-notice');
    const documentToggle = document.getElementById('document-toggle');
    const snapshotData = document.getElementById('aflt-dashboard-data');
    const historyViewEl = document.getElementById('history-view');
    const historyTreeEl = document.getElementById('history-tree');
    const ganttAxisEl = document.getElementById('gantt-axis');
    const graphViewEl = document.getElementById('graph-view');
    const viewHistoryBtn = document.getElementById('view-history');
    const viewGraphBtn = document.getElementById('view-graph');
    const sortSelect = document.getElementById('history-sort');
    const hideDormantEl = document.getElementById('hide-dormant');
    const dormantHiddenCountEl = document.getElementById('dormant-hidden-count');
    const showArchivedEl = document.getElementById('show-archived');
    const confirmDialog = document.getElementById('confirm-dialog');
    const confirmTitle = document.getElementById('confirm-title');
    const confirmBody = document.getElementById('confirm-body');
    const confirmOk = document.getElementById('confirm-ok');
    const confirmCancel = document.getElementById('confirm-cancel');
    const confirmClose = document.getElementById('confirm-close');
    const leftoffPanel = document.getElementById('leftoff-panel');
    const leftoffEl = document.getElementById('leftoff');
    const historyPanel = document.getElementById('history-panel');
    const historyFeed = document.getElementById('history-feed');
    const historyFilterEl = document.getElementById('history-filter');
    const historyTooltip = document.getElementById('history-tooltip');
    const historyHintEl = document.getElementById('history-hint');
    const herdrRemoteNote = document.getElementById('herdr-remote-note');

    let hideDormant = true;
    let showArchived = false;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        const stored = localStorage.getItem(HIDE_DORMANT_STORAGE_KEY);
        if (stored === '0' || stored === 'false') hideDormant = false;
        else if (stored === '1' || stored === 'true') hideDormant = true;
        const archivedStored = localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY);
        if (archivedStored === '1' || archivedStored === 'true') showArchived = true;
        else if (archivedStored === '0' || archivedStored === 'false') showArchived = false;
      }
    } catch (_) {
      /* ignore quota / private mode */
    }
    if (hideDormantEl) hideDormantEl.checked = hideDormant;
    if (showArchivedEl) showArchivedEl.checked = showArchived;

    // Prefer updating a trailing text node so the legend element stays intact.
    // Fall back to textContent when the host DOM is a minimal test double.
    const hintTextNode = (function () {
      if (!hintEl) return null;
      const nodes = hintEl.childNodes;
      if (nodes && nodes.length) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (nodes[i] && nodes[i].nodeType === 3) return nodes[i];
        }
      }
      if (typeof document.createTextNode === 'function' && typeof hintEl.appendChild === 'function') {
        try {
          const t = document.createTextNode('');
          hintEl.appendChild(t);
          return t;
        } catch (_) {
          /* fall through */
        }
      }
      return null;
    })();
    function setHintText(text) {
      if (hintTextNode) hintTextNode.nodeValue = '\n          ' + text + '\n        ';
      else if (hintEl) hintEl.textContent = text;
    }

    let currentView = 'history';
    let simStale = true;
    let sortMode = 'recent';
    let sortTouched = false;
    let stateFilter = '';
    const collapseOverride = new Map();
    let historyReq = 0;
    let historyLoaded = null;
    const expandedReplies = new Set();

    let state = null;
    let selectedId = null;
    let hoverId = null;
    let focusId = null;
    let tooltipId = null;
    let tooltipHovered = false;
    let tooltipHideTimer = null;
    let historyHoverId = null;
    let historyFocusId = null;
    let historyTooltipId = null;
    let historyTooltipHovered = false;
    let historyTooltipHideTimer = null;
    let sim = null;
    let graphLayers = null;
    const graphNodes = new Map();
    let lastUpdatedAt = Date.now();
    let raf = 0;
    let selectedDocument = null;
    let documentSource = false;
    let openingHerdr = false;

    function updateHerdrRemoteNote() {
      if (!herdrRemoteNote) return;
      const remote = !snapshotData && !isHerdrFocusLocal();
      herdrRemoteNote.hidden = !remote;
      if (remote) {
        herdrRemoteNote.textContent =
          'Opening Herdr and archive/delete only work on the Mini — open this dashboard at 127.0.0.1 locally.';
      }
    }

    function actionToken() {
      if (!state || !state.actions) return null;
      return state.actions.actionToken || state.actions.herdrFocusToken || null;
    }

    function actionsAllowed() {
      return !snapshotData && Boolean(actionToken()) && isHerdrFocusLocal();
    }

    function setActionMessage(text, isError) {
      if (!actionStatus) return;
      actionStatus.hidden = false;
      actionStatus.setAttribute('class', isError ? 'action-status error' : 'action-status');
      actionStatus.textContent = text;
    }

    function confirmAction(opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        if (!confirmDialog || typeof confirmDialog.showModal !== 'function') {
          const ok =
            typeof window !== 'undefined' && typeof window.confirm === 'function'
              ? window.confirm(String(opts.body || opts.title || 'Confirm?'))
              : false;
          resolve(ok);
          return;
        }
        if (confirmTitle) confirmTitle.textContent = opts.title || 'Confirm';
        if (confirmBody) confirmBody.textContent = opts.body || '';
        if (confirmOk) confirmOk.textContent = opts.okLabel || 'OK';
        let settled = false;
        function finish(ok) {
          if (settled) return;
          settled = true;
          confirmOk && confirmOk.removeEventListener('click', onOk);
          confirmCancel && confirmCancel.removeEventListener('click', onCancel);
          confirmClose && confirmClose.removeEventListener('click', onCancel);
          confirmDialog.removeEventListener('cancel', onCancel);
          try {
            if (confirmDialog.open) confirmDialog.close();
          } catch (_) {
            /* ignore */
          }
          resolve(ok);
        }
        function onOk(ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          finish(true);
        }
        function onCancel(ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          finish(false);
        }
        confirmOk && confirmOk.addEventListener('click', onOk);
        confirmCancel && confirmCancel.addEventListener('click', onCancel);
        confirmClose && confirmClose.addEventListener('click', onCancel);
        confirmDialog.addEventListener('cancel', onCancel);
        confirmDialog.showModal();
      });
    }

    async function postDashboardAction(pathname, body) {
      if (!actionsAllowed()) {
        setActionMessage(
          'Archive/delete only work on the Mini — open this dashboard at 127.0.0.1 locally.',
          true
        );
        updateHerdrRemoteNote();
        throw new Error('actions require local dashboard');
      }
      const response = await fetch(pathname, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aflt-Action-Token': actionToken(),
        },
        body: JSON.stringify(body || {}),
      });
      const result = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(result.error || 'Request failed');
      if (result.state) applyState(result.state, { forceRebuild: true });
      return result;
    }

    async function openInHerdr(id) {
      if (openingHerdr) return;
      const session = (state.sessions || []).find(function (s) { return s.id === id; });
      if (!session) return;
      setActionMessage('Opening ' + session.title + ' in Herdr...', false);
      if (snapshotData || !actionToken()) {
        setActionMessage('Open the live local dashboard to select this agent in Herdr.', false);
        return;
      }
      if (!isHerdrFocusLocal()) {
        setActionMessage(
          'Opening Herdr only works on the Mini — open this dashboard at 127.0.0.1 locally.',
          true
        );
        updateHerdrRemoteNote();
        return;
      }
      openingHerdr = true;
      try {
        const response = await fetch('/api/herdr/focus/' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'X-Aflt-Action-Token': actionToken() },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to open the agent in Herdr.');
        setActionMessage('Selected ' + session.title + ' in Herdr.', false);
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      } finally {
        openingHerdr = false;
      }
    }

    async function archiveSession(id, withChildren) {
      setActionMessage(withChildren ? 'Archiving with sub-agents…' : 'Archiving…', false);
      try {
        const result = await postDashboardAction('/api/session/archive', {
          id: id,
          withChildren: !!withChildren,
        });
        setActionMessage(
          'Archived ' + ((result.archived && result.archived[0] && result.archived[0].title) || id) + '.',
          false
        );
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    async function unarchiveSession(id, withChildren) {
      setActionMessage('Unarchiving…', false);
      try {
        await postDashboardAction('/api/session/unarchive', {
          id: id,
          withChildren: !!withChildren,
        });
        setActionMessage('Unarchived ' + id + '.', false);
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    async function deleteSession(id, title) {
      const label = title || id;
      const ok = await confirmAction({
        title: 'Delete session?',
        body:
          'Remove "' +
          label +
          '" from the registry? Run logs under ~/.agentfleet/runs/ are kept. This cannot be undone from the dashboard.',
        okLabel: 'Delete',
      });
      if (!ok) return;
      setActionMessage('Deleting…', false);
      try {
        await postDashboardAction('/api/session/delete', { id: id });
        if (selectedId === id) selectedId = null;
        setActionMessage('Deleted ' + label + ' (logs kept).', false);
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    async function archiveIdleInProject(projectName) {
      const ok = await confirmAction({
        title: 'Archive idle/done sessions?',
        body:
          'Archive all idle and done sessions in project "' +
          projectName +
          '"? Running, waiting, and failed sessions stay visible. You can unarchive later.',
        okLabel: 'Archive idle/done',
      });
      if (!ok) return;
      setActionMessage('Archiving idle/done sessions…', false);
      try {
        const result = await postDashboardAction('/api/project/archive-idle', {
          project: projectName,
        });
        const n = (result.archived || []).length;
        setActionMessage(
          n === 0 ? 'No idle/done sessions to archive.' : 'Archived ' + n + ' session' + (n === 1 ? '' : 's') + '.',
          false
        );
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    function sessionActionButtonsHtml(session) {
      if (!session || snapshotData) return '';
      const local = actionsAllowed();
      const disabled = local ? '' : ' disabled title="Only on the Mini (127.0.0.1)"';
      if (session.archived) {
        return (
          '<div class="session-actions">' +
          '<button type="button" data-action="unarchive" data-id="' +
          esc(session.id) +
          '"' +
          disabled +
          '>Unarchive</button>' +
          '<button type="button" class="danger" data-action="delete" data-id="' +
          esc(session.id) +
          '" data-title="' +
          esc(session.title || session.id) +
          '"' +
          disabled +
          '>Delete</button></div>'
        );
      }
      const kids = (session.children || []).length;
      return (
        '<div class="session-actions">' +
        '<button type="button" data-action="archive" data-id="' +
        esc(session.id) +
        '"' +
        disabled +
        '>Archive</button>' +
        (kids
          ? '<button type="button" data-action="archive-children" data-id="' +
            esc(session.id) +
            '"' +
            disabled +
            '>Archive with sub-agents</button>'
          : '') +
        '<button type="button" class="danger" data-action="delete" data-id="' +
        esc(session.id) +
        '" data-title="' +
        esc(session.title || session.id) +
        '"' +
        disabled +
        '>Delete</button></div>'
      );
    }

    function projectActionButtonsHtml(project) {
      if (!project || snapshotData || !(project.sessionCount > 0 || project.archivedCount > 0)) return '';
      const local = actionsAllowed();
      const disabled = local ? '' : ' disabled title="Only on the Mini (127.0.0.1)"';
      return (
        '<div class="project-actions">' +
        '<button type="button" data-action="archive-idle" data-project="' +
        esc(project.name) +
        '"' +
        disabled +
        '>Archive all idle/done sub-agents</button></div>'
      );
    }

    function rowActionsHtml(enriched, isProject) {
      if (snapshotData) return '';
      const local = actionsAllowed();
      const disabled = local ? '' : ' disabled title="Only on the Mini (127.0.0.1)"';
      if (isProject) {
        if (!(enriched.sessionCount > 0 || enriched.archivedCount > 0)) return '';
        return (
          '<span class="row-actions">' +
          '<button type="button" data-action="archive-idle" data-project="' +
          esc(enriched.name) +
          '"' +
          disabled +
          '>Archive idle/done</button></span>'
        );
      }
      if (enriched.archived) {
        return (
          '<span class="row-actions">' +
          '<button type="button" data-action="unarchive" data-id="' +
          esc(enriched.id) +
          '"' +
          disabled +
          '>Unarchive</button>' +
          '<button type="button" class="danger" data-action="delete" data-id="' +
          esc(enriched.id) +
          '" data-title="' +
          esc(enriched.title || enriched.id) +
          '"' +
          disabled +
          '>Delete</button></span>'
        );
      }
      const kids = (enriched.children || []).length;
      return (
        '<span class="row-actions">' +
        '<button type="button" data-action="archive" data-id="' +
        esc(enriched.id) +
        '"' +
        disabled +
        '>Archive</button>' +
        (kids
          ? '<button type="button" data-action="archive-children" data-id="' +
            esc(enriched.id) +
            '"' +
            disabled +
            '>Archive+</button>'
          : '') +
        '<button type="button" class="danger" data-action="delete" data-id="' +
        esc(enriched.id) +
        '" data-title="' +
        esc(enriched.title || enriched.id) +
        '"' +
        disabled +
        '>Delete</button></span>'
      );
    }

    const COLORS = {
      working: 'var(--state-working)',
      waiting: 'var(--state-waiting)',
      idle: 'var(--state-idle)',
      completed: 'var(--state-completed)',
      failed: 'var(--state-failed)',
      // Legacy aliases
      running: 'var(--state-working)',
      done: 'var(--state-completed)',
    };
    const markerPayload = new Map();

    function ago(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      return Math.floor(m / 60) + 'h ago';
    }

    function tickMeta() {
      if (!state) {
        metaEl.textContent = 'local · connecting…';
        return;
      }
      if (snapshotData) {
        metaEl.textContent = 'snapshot · ' + state.generatedAt;
        return;
      }
      if (state.error) {
        metaEl.textContent = 'dashboard error · ' + state.error;
        return;
      }
      if (state.completions && state.completions.errors.length) {
        metaEl.textContent = 'completion error · ' + state.completions.errors.join('; ');
        return;
      }
      metaEl.textContent = 'local · updated ' + ago(Date.now() - lastUpdatedAt) +
        (state.completions && state.completions.captureEnabled ? ' · completion capture on' : '');
    }
    setInterval(tickMeta, 1000);

    function sparkPath(series, w, h) {
      const vals = series || [];
      if (!vals.length) return '';
      const max = Math.max(1, ...vals);
      const step = w / Math.max(vals.length - 1, 1);
      return vals
        .map(function (v, i) {
          const x = i * step;
          const y = h - (v / max) * (h - 4) - 2;
          return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
        })
        .join(' ');
    }

    function drawSpark(el, series, color) {
      const w = 280;
      const h = 40;
      const d = sparkPath(series, w, h);
      el.innerHTML =
        '<path d="' +
        d +
        '" fill="none" stroke="' +
        color +
        '" stroke-width="1.6" stroke-linejoin="round"/>';
    }

    function renderStats(s) {
      const st = s.stats || {};
      const eng = st.engines || {};
      statsEl.innerHTML =
        '<div class="stat"><div class="k">active projects</div><div class="v">' +
        (st.activeProjects || 0) +
        '</div></div>' +
        '<div class="stat"><div class="k">Working</div><div class="v working">' +
        (st.workingSessions != null ? st.workingSessions : st.runningSessions || 0) +
        '</div></div>' +
        '<div class="engines">cursor ' +
        (eng.cursor || 0) +
        ' · copilot ' +
        (eng.copilot || 0) +
        ' · Working ' +
        (st.open || 0) +
        ' · Waiting ' +
        (st.waiting || 0) +
        ' · Idle ' +
        (st.idle || 0) +
        ' · Completed ' +
        (st.completed != null ? st.completed : st.done || 0) +
        ' · Failed ' +
        (st.failed || 0) +
        '</div>';
    }

    function renderEvents(s) {
      const events = s.events || [];
      eventsEl.innerHTML = events
        .map(function (ev) {
          const when = String(ev.at || '')
            .replace('T', ' ')
            .slice(0, 19);
          return (
            '<li><span class="when">' +
            esc(when) +
            '</span>' +
            esc(ev.text || '') +
            '</li>'
          );
        })
        .join('');
    }

    function esc(s) {
      return escapeHtml(s);
    }

    function currentProject() {
      const item = findSelection();
      if (!item) return null;
      return item.name && item.sessionCount != null ? item : (state.projects || []).find(function (p) {
        return p.name === item.project;
      });
    }

    function renderMemory() {
      const project = currentProject();
      const options = '<option value="">Select a project</option>' + (state.projects || []).map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
      }).join('');
      if (projectSelect.innerHTML !== options) projectSelect.innerHTML = options;
      projectSelect.value = project ? project.id : '';
      const html = renderProjectMemory(project, state.memory);
      if (memoryEl.innerHTML !== html) memoryEl.innerHTML = html;
      if (documentDialog.open && selectedDocument) showDocument(selectedDocument);
    }

    function showDocument(selection) {
      const project = (state.projects || []).find(function (p) { return p.id === selection.project; });
      const doc = project && project.memory && project.memory.documents.find(function (d) {
        return d.path === selection.path;
      });
      documentTitle.textContent = doc ? doc.title : 'Document unavailable';
      documentPath.textContent = selection.path;
      const content = doc ? doc.content : 'This document is no longer available. Close this reader and select another document.';
      const html = documentSource
        ? '<pre class="markdown-source">' + escapeHtml(content) + '</pre>'
        : renderMarkdown(content);
      if (documentContent.innerHTML !== html) documentContent.innerHTML = html;
      documentToggle.textContent = documentSource ? 'Render Markdown' : 'View source';
      documentNotice.textContent = 'Read-only ' + (documentSource ? 'Markdown source' : 'Markdown preview') +
        ' · sensitive values redacted' +
        (doc && doc.truncated ? ' · truncated to 32 KiB. Open the source file for the full document.' : '') +
        (documentSource ? '' : ' · images shown as text');
    }

    documentToggle.addEventListener('click', function () {
      documentSource = !documentSource;
      if (selectedDocument) showDocument(selectedDocument);
    });
    documentContent.addEventListener('click', function (event) {
      const link = event.target.closest('a[data-document-link]');
      if (!link || !selectedDocument) return;
      event.preventDefault();
      const target = resolveDocumentLink(state.projects, selectedDocument.path, link.dataset.documentLink);
      if (!target) {
        documentNotice.textContent = 'This linked document is not included in the read-only preview. Open it from the source repository.';
        return;
      }
      selectedDocument = { project: target.project, path: target.path };
      showDocument(selectedDocument);
      if (target.fragment) {
        const heading = document.getElementById('document-heading-' + target.fragment);
        if (heading) heading.scrollIntoView({ block: 'start' });
        else documentNotice.textContent = 'The linked heading was not found in this preview.';
      }
    });

    projectSelect.addEventListener('change', function () {
      selectedId = projectSelect.value || null;
      renderDetail();
    });
    memoryEl.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-document-path]');
      const project = currentProject();
      if (!button || !project) return;
      selectedDocument = { project: project.id, path: button.dataset.documentPath };
      showDocument(selectedDocument);
      documentDialog.showModal();
    });
    document.getElementById('document-close').addEventListener('click', function () {
      documentDialog.close();
    });

    function findSelection() {
      if (!selectedId || !state) return null;
      if (String(selectedId).startsWith('project:')) {
        const name = String(selectedId).slice('project:'.length);
        return (state.projects || []).find(function (p) {
          return p.name === name || p.id === selectedId;
        });
      }
      return (state.sessions || []).find(function (s) {
        return s.id === selectedId;
      });
    }

    function renderDetail() {
      renderMemory();
      syncHistoryPanel();
      markSelectedRows();
      const item = findSelection();
      if (!item) {
        detailEl.innerHTML = '<div class="empty">select a project or session</div>';
        return;
      }
      if (item.sessionCount != null && item.name) {
        const projectState = item.filterState || item.displayState || 'idle';
        detailEl.innerHTML =
          '<div class="label">project</div><h2>' +
          esc(item.name) +
          '</h2><span class="badge ' +
          esc(projectState) +
          '">' +
          esc(stateLabel(projectState)) +
          '</span><dl>' +
          row('sessions', item.sessionCount) +
          row('archived', item.archivedCount || 0) +
          row('Working', item.workingCount != null ? item.workingCount : item.runningCount) +
          row('last activity', item.lastActivity || '—') +
          '</dl>' +
          projectActionButtonsHtml(item) +
          renderTaskCompletion(item.completion);
        return;
      }
      const kids = (item.children || []).length;
      const liveState = rowFilterState(item);
      detailEl.innerHTML =
        '<div class="label">session</div><h2>' +
        esc(item.title) +
        '</h2><span class="badge ' +
        esc(liveState) +
        '">' +
        esc(activityLabel(item)) +
        '</span><dl>' +
        row('id', item.id) +
        row('project', item.project) +
        row('engine', item.engine) +
        row('status', item.status) +
        row('archived', item.archived ? 'yes' : 'no') +
        row('worker', item.workerStatus || '—') +
        row('cwd', item.cwd || '—') +
        row('model', item.model || '—') +
        row('last used', item.lastUsed || '—') +
        row('last exit', item.lastExit == null ? '—' : item.lastExit) +
        row('error', item.lastError || '—') +
        row(
          'herdr',
          item.herdr && item.herdr.runtime
            ? item.herdr.runtime + (item.herdr.name ? ' · ' + item.herdr.name : '')
            : '—'
        ) +
        row('children', kids) +
        '</dl>' +
        sessionActionButtonsHtml(item) +
        renderTaskCompletion(item.completion);
    }

    function row(k, v) {
      return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>';
    }

    function stateNowMs(s) {
      const t = s && s.generatedAt != null ? Date.parse(String(s.generatedAt)) : NaN;
      return Number.isFinite(t) ? t : Date.now();
    }

    function dormantWindowMs(s) {
      const n = s && s.dormantAfterMs != null ? Number(s.dormantAfterMs) : DEFAULT_DORMANT_AFTER_MS;
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DORMANT_AFTER_MS;
    }

    function countDormantProjects(list, s) {
      const nowMs = stateNowMs(s);
      const windowMs = dormantWindowMs(s);
      let n = 0;
      (list || []).forEach(function (p) {
        if (isDormantProject(p, nowMs, windowMs)) n += 1;
      });
      return n;
    }

    function filterGraphProjects(list, s) {
      const nowMs = stateNowMs(s);
      const windowMs = dormantWindowMs(s);
      return (list || []).filter(function (p) {
        if (!p) return false;
        if (p.fromMemoryOnly || !(p.sessionCount > 0)) return false;
        if (hideDormant && isDormantProject(p, nowMs, windowMs)) return false;
        return true;
      });
    }

    function updateDormantHiddenCount() {
      if (!dormantHiddenCountEl) return;
      if (!hideDormant || !state) {
        dormantHiddenCountEl.hidden = true;
        dormantHiddenCountEl.textContent = '';
        return;
      }
      // Count session-bearing dormant hubs removed from Graph/History (not the No-sessions group).
      const n = countDormantProjects(
        (state.projects || []).filter(function (p) {
          return p && !p.fromMemoryOnly && p.sessionCount > 0;
        }),
        state
      );
      if (n <= 0) {
        dormantHiddenCountEl.hidden = true;
        dormantHiddenCountEl.textContent = '';
        return;
      }
      dormantHiddenCountEl.hidden = false;
      dormantHiddenCountEl.textContent = n === 1 ? '1 dormant hidden' : n + ' dormant hidden';
    }

    function buildSim(s) {
      const rect = svg.getBoundingClientRect();
      const w = Math.max(rect.width || 800, 320);
      const h = Math.max(rect.height || 600, 320);
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      const nodes = [];
      const links = [];
      // Sessionless memory-only projects stay out; optionally hide dormant hubs.
      const projects = filterGraphProjects(s.projects || [], s);
      const visibleNames = {};
      projects.forEach(function (p) { visibleNames[p.name] = true; });
      const sessions = (s.sessions || []).filter(function (sess) {
        if (!sess || !visibleNames[sess.project]) return false;
        if (sess.archived && !showArchived) return false;
        return true;
      });
      const n = Math.max(projects.length, 1);
      const hubR = Math.min(w, h) * 0.28;
      const cx = w * 0.5;
      const cy = h * 0.5;

      projects.forEach(function (p, i) {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const projectState = p.filterState || p.displayState || 'idle';
        nodes.push({
          id: p.id,
          kind: 'project',
          label: p.name,
          displayState: projectState,
          filterState: projectState,
          x: cx + Math.cos(angle) * hubR,
          y: cy + Math.sin(angle) * hubR,
          vx: 0,
          vy: 0,
          r: 20,
          fixed: reduced,
        });
      });

      const hub = {};
      nodes.forEach(function (n) {
        if (n.kind === 'project') hub[n.label] = n;
      });

      sessions.forEach(function (sess, idx) {
        const parent = hub[sess.project] || { x: cx, y: cy };
        const a = ((idx % 12) / 12) * Math.PI * 2;
        nodes.push({
          id: sess.id,
          kind: 'session',
          label: sess.nodeLabel || sess.id,
          displayState: sess.displayState,
          activityState: sess.activityState,
          awaitingInput: !!sess.awaitingInput,
          recent: !!sess.recent,
          x: parent.x + Math.cos(a) * 70,
          y: parent.y + Math.sin(a) * 70,
          vx: 0,
          vy: 0,
          r: 8,
          project: sess.project,
        });
      });

      const sessionById = new Map(sessions.map(function (sess) { return [sess.id, sess]; }));
      (s.links || []).forEach(function (l) {
        links.push({
          source: l.from, target: l.to, kind: l.kind,
          recent: !!(sessionById.get(l.to) || {}).recent,
        });
      });

      const byId = {};
      nodes.forEach(function (n) {
        byId[n.id] = n;
      });
      const resolved = links
        .map(function (l) {
          return {
            source: byId[l.source],
            target: byId[l.target],
            kind: l.kind,
            recent: l.recent,
          };
        })
        .filter(function (l) {
          return l.source && l.target;
        });

      return { nodes: nodes, links: resolved, w: w, h: h, cx: cx, cy: cy, alpha: 1 };
    }

    function stepSim(model) {
      if (reduced) return;
      if (model.alpha == null) model.alpha = 1;
      if (model.alpha < 0.002) {
        for (let i = 0; i < model.nodes.length; i++) {
          model.nodes[i].vx = 0;
          model.nodes[i].vy = 0;
        }
        return;
      }
      const alpha = model.alpha;
      const nodes = model.nodes;
      const links = model.links;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy || 1;
          const dist = Math.sqrt(d2);
          const min = (a.r + b.r) * 2.2;
          if (dist < min) {
            const f = ((min - dist) / dist) * 0.04 * alpha;
            dx *= f;
            dy *= f;
            if (!a.fixed) {
              a.vx -= dx;
              a.vy -= dy;
            }
            if (!b.fixed) {
              b.vx += dx;
              b.vy += dy;
            }
          } else {
            const f = (18 / d2) * alpha;
            dx *= f;
            dy *= f;
            if (!a.fixed) {
              a.vx -= dx;
              a.vy -= dy;
            }
            if (!b.fixed) {
              b.vx += dx;
              b.vy += dy;
            }
          }
        }
      }
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        const a = l.source;
        const b = l.target;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const ideal = l.kind === 'parent' ? 90 : 70;
        const f = ((dist - ideal) / dist) * 0.02 * alpha;
        dx *= f;
        dy *= f;
        if (!a.fixed) {
          a.vx += dx;
          a.vy += dy;
        }
        if (!b.fixed) {
          b.vx -= dx;
          b.vy -= dy;
        }
      }
      let ke = 0;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.kind === 'project') {
          const dx = model.cx - n.x;
          const dy = model.cy - n.y;
          n.vx += dx * 0.002 * alpha;
          n.vy += dy * 0.002 * alpha;
        }
        if (n.fixed) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx *= 0.86;
        n.vy *= 0.86;
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.max(n.r + 8, Math.min(model.w - n.r - 8, n.x));
        n.y = Math.max(n.r + 8, Math.min(model.h - n.r - 8, n.y));
        ke += n.vx * n.vx + n.vy * n.vy;
      }
      if (ke < 0.00005) {
        model.alpha = 0;
      } else {
        model.alpha *= 0.988;
      }
    }

    function positionGraphTooltip() {
      if (!tooltipId || !sim || tooltipHovered) return;
      const node = sim.nodes.find(function (n) { return n.id === tooltipId; });
      if (!node) return;
      const graphRect = svg.getBoundingClientRect();
      const tipRect = graphTooltip.getBoundingClientRect();
      const sx = graphRect.width / sim.w;
      const sy = graphRect.height / sim.h;
      let left = (node.x + node.r) * sx + 12;
      if (left + tipRect.width > graphRect.width - 12) {
        left = (node.x - node.r) * sx - tipRect.width - 12;
      }
      graphTooltip.style.left = Math.max(12, Math.min(left, graphRect.width - tipRect.width - 12)) + 'px';
      graphTooltip.style.top = Math.max(12, Math.min(node.y * sy - tipRect.height / 2,
        graphRect.height - tipRect.height - 12)) + 'px';
    }

    function cancelTooltipHide() {
      if (tooltipHideTimer !== null) clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }

    function dismissGraphTooltip() {
      cancelTooltipHide();
      hoverId = null;
      focusId = null;
      tooltipId = null;
      tooltipHovered = false;
      renderGraphTooltip();
    }

    function scheduleTooltipHide() {
      cancelTooltipHide();
      if (hoverId || focusId || tooltipHovered) return;
      tooltipHideTimer = setTimeout(function () {
        tooltipHideTimer = null;
        if (!hoverId && !focusId && !tooltipHovered) dismissGraphTooltip();
      }, 450);
    }

    function renderGraphTooltip() {
      const id = hoverId || focusId || tooltipId;
      const session = state && (state.sessions || []).find(function (s) { return s.id === id; });
      const project = state && (state.projects || []).find(function (p) {
        return p.id === id || (session && p.name === session.project);
      });
      const nextId = session || project ? id : null;
      if (tooltipHovered && nextId && tooltipId === nextId) return;
      tooltipId = nextId;
      if (!tooltipId) {
        tooltipHovered = false;
        cancelTooltipHide();
      }
      graphTooltip.hidden = !tooltipId;
      const html = renderGraphHint(project, session);
      if (graphTooltip.innerHTML !== html) graphTooltip.innerHTML = html;
      setHintText(tooltipId
        ? 'click for details · double-click an agent for Herdr · Esc to dismiss hint'
        : 'hover a node · click for details · double-click an agent for Herdr');
      positionGraphTooltip();
    }

    function drawGraph() {
      if (!sim) return;
      const ns = 'http://www.w3.org/2000/svg';
      if (!graphLayers) {
        graphLayers = ['stars', 'edges', 'nodes'].map(function () {
          const group = document.createElementNS(ns, 'g');
          svg.appendChild(group);
          return group;
        });
      }
      const stars = graphLayers[0];
      const edgeG = graphLayers[1];
      const nodeG = graphLayers[2];
      while (stars.firstChild) stars.removeChild(stars.firstChild);
      while (edgeG.firstChild) edgeG.removeChild(edgeG.firstChild);

      for (let i = 0; i < 50; i++) {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', String((i * 97) % sim.w));
        c.setAttribute('cy', String((i * 53) % sim.h));
        c.setAttribute('r', '1');
        c.setAttribute('fill', 'var(--cp-text-muted)');
        c.setAttribute('opacity', String(0.12 + (i % 5) * 0.04));
        stars.appendChild(c);
      }
      sim.links.forEach(function (l) {
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', l.source.x);
        line.setAttribute('y1', l.source.y);
        line.setAttribute('x2', l.target.x);
        line.setAttribute('y2', l.target.y);
        line.setAttribute(
          'class',
          'edge ' + l.kind + (l.recent ? ' recent' : '')
        );
        edgeG.appendChild(line);

        if (!reduced && l.recent) {
          const t = (Date.now() / 1000) % 1;
          const tx = l.source.x + (l.target.x - l.source.x) * t;
          const ty = l.source.y + (l.target.y - l.source.y) * t;
          const dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', tx);
          dot.setAttribute('cy', ty);
          dot.setAttribute('r', '2.2');
          dot.setAttribute('class', 'traveler');
          edgeG.appendChild(dot);
        }
      });
      const visibleIds = new Set(sim.nodes.map(function (n) { return n.id; }));
      graphNodes.forEach(function (entry, id) {
        if (!visibleIds.has(id)) {
          nodeG.removeChild(entry.group);
          graphNodes.delete(id);
        }
      });
      sim.nodes.forEach(function (n) {
        let entry = graphNodes.get(n.id);
        if (!entry) {
          const g = document.createElementNS(ns, 'g');
          const circle = document.createElementNS(ns, 'circle');
          const label = document.createElementNS(ns, 'text');
          g.setAttribute('data-id', n.id);
          g.setAttribute('role', 'button');
          g.setAttribute('tabindex', '0');
          g.setAttribute('aria-describedby', 'graph-tooltip');
          g.appendChild(circle);
          g.appendChild(label);
          let waiting = null;
          let working = null;
          if (n.kind === 'session') {
            const indicator = document.createElementNS(ns, 'g');
            const ring = document.createElementNS(ns, 'circle');
            const badge = document.createElementNS(ns, 'circle');
            const mark = document.createElementNS(ns, 'text');
            indicator.setAttribute('class', 'waiting-indicator');
            indicator.setAttribute('aria-hidden', 'true');
            ring.setAttribute('class', 'waiting-ring');
            badge.setAttribute('class', 'waiting-badge');
            badge.setAttribute('r', '7');
            mark.setAttribute('class', 'waiting-mark');
            mark.textContent = '?';
            indicator.appendChild(ring);
            indicator.appendChild(badge);
            indicator.appendChild(mark);
            g.appendChild(indicator);
            waiting = { group: indicator, ring: ring, badge: badge, mark: mark };
            working = document.createElementNS(ns, 'circle');
            working.setAttribute('class', 'working-indicator');
            working.setAttribute('aria-hidden', 'true');
            working.setAttribute('pathLength', '100');
            g.appendChild(working);
          }
          g.addEventListener('mouseenter', function () {
            cancelTooltipHide();
            focusId = null;
            hoverId = n.id;
            renderGraphTooltip();
          });
          g.addEventListener('mouseleave', function () {
            if (hoverId === n.id) hoverId = null;
            scheduleTooltipHide();
          });
          g.addEventListener('focus', function () {
            cancelTooltipHide();
            if (hoverId !== n.id) focusId = n.id;
            renderGraphTooltip();
          });
          g.addEventListener('blur', function () {
            if (focusId === n.id) focusId = null;
            scheduleTooltipHide();
          });
          function selectNode(ev) {
            ev.stopPropagation();
            selectedId = n.id;
            renderDetail();
          }
          g.addEventListener('click', selectNode);
          if (n.kind === 'session') {
            g.addEventListener('dblclick', function (ev) {
              ev.stopPropagation();
              openInHerdr(n.id);
            });
          }
          g.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
              dismissGraphTooltip();
            }
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              selectNode(ev);
            }
          });
          nodeG.appendChild(g);
          entry = { group: g, circle: circle, label: label, waiting: waiting, working: working };
          graphNodes.set(n.id, entry);
        }
        const g = entry.group;
        const c = entry.circle;
        const label = entry.label;
        g.setAttribute('class', 'node-hit' + (selectedId === n.id ? ' selected' : ''));
        g.setAttribute('aria-label', n.kind === 'session' ? n.id + ' — ' + activityLabel(n) : n.label);
        g.setAttribute('aria-pressed', String(selectedId === n.id));
        c.setAttribute('cx', n.x);
        c.setAttribute('cy', n.y);
        c.setAttribute('r', n.r);
        const live =
          n.kind === 'project'
            ? n.filterState || n.displayState || 'idle'
            : rowFilterState(n);
        c.setAttribute('style', '--cp-node-color: ' + (COLORS[live] || COLORS.idle));
        label.setAttribute('x', n.x);
        label.setAttribute('text-anchor', 'middle');
        label.textContent = n.label;

        if (n.kind === 'project') {
          c.setAttribute('class', 'hub');
          c.setAttribute('stroke', COLORS[live] || COLORS.idle);
          label.setAttribute('y', n.y + n.r + 14);
          label.setAttribute('class', 'hub-label');
          label.setAttribute('visibility', 'visible');
        } else {
          c.setAttribute(
            'class',
            'leaf ' +
              live +
              (live === 'waiting' ? ' awaiting-input' : '') +
              (live === 'working' && !reduced ? ' pulse' : '')
          );
          label.setAttribute('y', n.y + n.r + 14);
          label.setAttribute('class', 'session-label');
          label.setAttribute('visibility', 'visible');
          const waiting = entry.waiting;
          waiting.group.setAttribute('visibility', live === 'waiting' ? 'visible' : 'hidden');
          waiting.ring.setAttribute('cx', n.x);
          waiting.ring.setAttribute('cy', n.y);
          waiting.ring.setAttribute('r', n.r + 4);
          waiting.badge.setAttribute('cx', n.x + n.r + 6);
          waiting.badge.setAttribute('cy', n.y - n.r - 2);
          waiting.mark.setAttribute('x', n.x + n.r + 6);
          waiting.mark.setAttribute('y', n.y - n.r + 2);
          entry.working.setAttribute('visibility', live === 'working' ? 'visible' : 'hidden');
          entry.working.setAttribute('cx', n.x);
          entry.working.setAttribute('cy', n.y);
          entry.working.setAttribute('r', n.r + 4);
        }
      });
      positionGraphTooltip();
    }

    /* ---------- history view ---------- */

    function setShown(el, shown) {
      if (!el) return;
      el.hidden = !shown;
      if (el.style) el.style.display = shown ? '' : 'none';
    }

    function timeMs(value) {
      const t = Date.parse(value || '');
      return isNaN(t) ? 0 : t;
    }

    function agoLabel(value) {
      const t = Date.parse(value || '');
      if (isNaN(t)) return '';
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      const h = Math.floor(m / 60);
      if (h < 48) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    }

    function sessionSortFn(mode) {
      return function (a, b) {
        if (mode === 'name') return String(a.title || '').localeCompare(String(b.title || ''));
        if (mode === 'created') {
          return timeMs(b.created) - timeMs(a.created) ||
            String(a.title || '').localeCompare(String(b.title || ''));
        }
        return timeMs(b.lastActivity) - timeMs(a.lastActivity) ||
          String(a.title || '').localeCompare(String(b.title || ''));
      };
    }

    function sortSessionNodes(list, mode) {
      return (list || []).slice().sort(sessionSortFn(mode)).map(function (node) {
        return Object.assign({}, node, { children: sortSessionNodes(node.children, mode) });
      });
    }

    function newestCreated(node) {
      let best = node.kind === 'session' ? timeMs(node.created) : 0;
      (node.children || []).forEach(function (c) {
        best = Math.max(best, newestCreated(c));
      });
      return best;
    }

    function sortProjectNodes(projects, mode) {
      const sorted = (projects || []).slice().sort(function (a, b) {
        const byName = String(a.name || '').localeCompare(String(b.name || ''));
        if (mode === 'name' || mode === 'project') return byName;
        if (mode === 'created') {
          return newestCreated(b) - newestCreated(a) ||
            timeMs(b.lastActivity) - timeMs(a.lastActivity) || byName;
        }
        if (!!a.active !== !!b.active) return a.active ? -1 : 1;
        return timeMs(b.lastActivity) - timeMs(a.lastActivity) || byName;
      });
      return sorted.map(function (p) {
        return Object.assign({}, p, { children: sortSessionNodes(p.children, mode) });
      });
    }

    function rollupFilterState(states) {
      if (!states || !states.length) return 'idle';
      for (let i = 0; i < FILTER_PRIORITY.length; i++) {
        if (states.indexOf(FILTER_PRIORITY[i]) !== -1) return FILTER_PRIORITY[i];
      }
      return 'idle';
    }

    function collectSessionFilterStates(node) {
      const enriched = enrichHistoryNode(node);
      const out = [];
      if (enriched.kind === 'session') out.push(rowFilterState(enriched));
      (enriched.children || []).forEach(function (c) {
        Array.prototype.push.apply(out, collectSessionFilterStates(c));
      });
      return out;
    }

    function projectFilterRollup(node) {
      // Live child roll-up so SSE session enrichments win over a stale project badge.
      return rollupFilterState(collectSessionFilterStates(node));
    }

    function isCollapsed(node) {
      if (collapseOverride.has(node.id)) return collapseOverride.get(node.id);
      if (node && node.kind === 'no-sessions-group') {
        // Sessionless memory projects: collapsed by default; override survives SSE.
        return node.collapsed !== false;
      }
      if (node && node.kind === 'project') {
        const rollup = projectFilterRollup(node);
        // Expand when any session is working or waiting; dormant projects start collapsed.
        return !(rollup === 'waiting' || rollup === 'working' || rollup === 'running');
      }
      return !!node.collapsed;
    }

    function historyRoots() {
      const tree = state && state.historyTree;
      const list = (tree && tree.projects) || [];
      if (tree && tree.noSessions) return list.concat([tree.noSessions]);
      return list;
    }

    function collectMarkers(node) {
      let list = (node.markers || []).slice();
      (node.children || []).forEach(function (c) {
        list = list.concat(collectMarkers(c));
      });
      return list;
    }

    function ganttHtml(markers, range, rowId) {
      const start = range ? Date.parse(range.start) : NaN;
      const end = range ? Date.parse(range.end) : NaN;
      const span = end - start;
      let html = '<div class="gantt-track">';
      if (span > 0) {
        (markers || []).forEach(function (m, idx) {
          if (!m || (m.state !== 'completed' && m.state !== 'failed')) return;
          const a = Date.parse(m.at);
          if (isNaN(a)) return;
          const left = ((a - start) / span) * 100;
          if (left < 0 || left > 100) return;
          const mid = 'm-' + String(rowId || 'row') + '-' + idx + '-' + String(m.at);
          markerPayload.set(mid, {
            state: m.state,
            at: m.at,
            prompt: m.prompt || '',
            reply: m.reply || '',
            sessionId: m.sessionId || null,
          });
          html +=
            '<button type="button" class="gantt-marker ' +
            esc(m.state) +
            '" style="left:' +
            left.toFixed(2) +
            '%" data-marker-id="' +
            esc(mid) +
            '" aria-label="' +
            esc(stateLabel(m.state) + ' · ' + (m.at || '')) +
            '"></button>';
        });
      }
      return html + '</div>';
    }

    function renderGanttAxis(range) {
      if (!ganttAxisEl) return;
      const start = range ? Date.parse(range.start) : NaN;
      const end = range ? Date.parse(range.end) : NaN;
      const span = end - start;
      if (!(span > 0)) {
        ganttAxisEl.innerHTML = '';
        return;
      }
      const short = span < 2 * 24 * 60 * 60 * 1000;
      let html = '';
      for (let i = 0; i <= 4; i++) {
        const t = new Date(start + (span * i) / 4);
        const label = short
          ? String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
          : (t.getMonth() + 1) + '/' + t.getDate();
        html += '<span style="left:' + (i * 25) + '%">' + esc(label) + '</span>';
      }
      if (ganttAxisEl.innerHTML !== html) ganttAxisEl.innerHTML = html;
    }

    function enrichHistoryNode(node) {
      if (!node || node.kind !== 'session' || !state) return node;
      const sess = (state.sessions || []).find(function (s) { return s.id === node.id; });
      if (!sess) return node;
      return Object.assign({}, node, {
        awaitingInput: !!sess.awaitingInput,
        activityState: sess.activityState || node.activityState,
        displayState: sess.displayState || node.displayState,
        status: sess.status || node.status,
        engine: sess.engine || node.engine,
        herdr: sess.herdr || node.herdr || null,
        title: sess.title || node.title,
      });
    }

    function nodeMatchesFilter(node) {
      if (!stateFilter) return true;
      if (node.kind === 'project') {
        return (node.children || []).some(function (c) {
          return nodeMatchesFilter(enrichHistoryNode(c));
        });
      }
      return rowFilterState(enrichHistoryNode(node)) === stateFilter;
    }

    function filterTree(nodes) {
      return (nodes || []).map(function (n) {
        if (n.kind === 'no-sessions-group') {
          const kids = filterTree(n.children || []);
          if (stateFilter && !kids.length) return null;
          return Object.assign({}, n, { children: kids });
        }
        if (n.kind === 'project') {
          const kids = filterTree(n.children || []);
          if (!showArchived && !(n.sessionCount > 0) && !(n.fromMemoryOnly)) {
            // Archived-only project: hide unless Show archived is on.
            if (!(n.archivedCount > 0)) return null;
            return null;
          }
          if (stateFilter) {
            const sessionless = n.fromMemoryOnly || !(n.sessionCount > 0);
            if (sessionless) {
              const fs = n.filterState || n.displayState || 'idle';
              if (fs !== stateFilter) return null;
              return Object.assign({}, n, { children: kids });
            }
            if (!kids.length) return null;
          } else if (!showArchived && !kids.length && !(n.fromMemoryOnly)) {
            return null;
          }
          return Object.assign({}, n, { children: kids });
        }
        const enriched = enrichHistoryNode(n);
        if (enriched.archived && !showArchived) return null;
        const kids = filterTree(enriched.children || []);
        // Keep ancestors when a matching child is nested underneath.
        if (stateFilter && !nodeMatchesFilter(enriched) && !kids.length) return null;
        return Object.assign({}, enriched, { children: kids });
      }).filter(Boolean);
    }

    function historyRowHtml(node, range) {
      const enriched = enrichHistoryNode(node);
      const isGroup = enriched.kind === 'no-sessions-group';
      const isProject = enriched.kind === 'project';
      const kids = enriched.children || [];
      const collapsed = isCollapsed(enriched);
      const depth = Math.max(0, enriched.depth || 0);
      const label = isGroup
        ? (enriched.label || 'No sessions')
        : isProject
          ? enriched.name
          : enriched.title || enriched.id;
      const filterKey = isGroup
        ? 'idle'
        : isProject
          ? projectFilterRollup(enriched)
          : rowFilterState(enriched);
      const bits = [];
      if (isGroup) {
        bits.push((kids.length || 0) + ' projects');
      } else if (isProject) {
        bits.push((enriched.sessionCount != null ? enriched.sessionCount : kids.length) + ' sessions');
        const wc = enriched.workingCount != null ? enriched.workingCount : enriched.runningCount;
        if (wc) bits.push(wc + ' Working');
      } else {
        bits.push(enriched.engine || '');
      }
      const when = agoLabel(enriched.lastActivity);
      if (when) bits.push(when);
      const markers = isGroup ? [] : isProject ? collectMarkers(enriched) : enriched.markers || [];
      const waiting = !isProject && !isGroup && filterKey === 'waiting';
      const working = !isProject && !isGroup && filterKey === 'working';
      const stateClass = (isGroup ? 'muted' : filterKey) +
        (waiting ? ' waiting awaiting-input' : '') +
        (working ? ' working' : '');
      const ariaState = isGroup ? 'no sessions' : activityLabel(enriched);
      const archivedClass = !isProject && !isGroup && enriched.archived ? ' archived' : '';
      let html = '<div class="history-row ' +
        (isGroup ? 'group no-sessions' : isProject ? 'project' : 'session') +
        ' ' + stateClass + archivedClass +
        (selectedId === enriched.id ? ' selected' : '') +
        '" role="treeitem" tabindex="0" data-id="' + esc(enriched.id) +
        '" data-kind="' + esc(enriched.kind) +
        '" data-filter-state="' + esc(filterKey) +
        '" data-archived="' + (enriched.archived ? '1' : '0') +
        '" aria-level="' + (depth + 1) +
        '" aria-selected="' + String(selectedId === enriched.id) + '"' +
        ' aria-label="' + esc((isProject || isGroup ? label : enriched.id) + ' — ' + ariaState) + '"' +
        (kids.length ? ' aria-expanded="' + String(!collapsed) + '"' : '') +
        ' style="padding-left:' + (1 + depth * 1.25).toFixed(2) + 'rem">' +
        '<div class="history-label"><button type="button" class="twist" data-twist="' + esc(enriched.id) +
        '" tabindex="-1" aria-label="' + (collapsed ? 'Expand ' : 'Collapse ') + esc(label) + '"' +
        (kids.length ? '' : ' disabled') + '>' +
        (kids.length ? (collapsed ? '&#9656;' : '&#9662;') : '&middot;') + '</button>' +
        '<span class="row-markers" aria-hidden="true">' +
        '<span class="row-waiting-mark">?</span><span class="row-working-mark"></span></span>' +
        '<span class="title" title="' + esc(label) + '">' + esc(label) + '</span>' +
        (isGroup
          ? ''
          : '<span class="history-state ' + esc(filterKey) + '">' + esc(ariaState) + '</span>') +
        '<span class="meta-bits">' + esc(bits.filter(Boolean).join(' · ')) + '</span>' +
        rowActionsHtml(enriched, isProject) +
        '</div>' +
        ganttHtml(markers, range, enriched.id) +
        // Issue #2: reserved lane for future message markers (messaging not implemented here).
        '<div class="message-markers" hidden></div></div>';
      if (!collapsed) {
        kids.forEach(function (child) {
          html += historyRowHtml(child, range);
        });
      }
      return html;
    }

    function syncFilterChips() {
      if (!historyFilterEl || typeof historyFilterEl.querySelectorAll !== 'function') return;
      const chips = historyFilterEl.querySelectorAll('.filter-chip');
      for (let i = 0; i < chips.length; i++) {
        const on = (chips[i].getAttribute('data-state') || '') === stateFilter;
        toggleBtnClass(chips[i], 'active', on);
        chips[i].setAttribute('aria-pressed', String(on));
      }
    }

    function renderHistoryTree() {
      if (!state || !historyTreeEl) return;
      markerPayload.clear();
      const tree = state.historyTree;
      if (!sortTouched) {
        sortMode = (tree && tree.sort) || state.historySort || 'recent';
        if (sortSelect && sortSelect.value !== sortMode) sortSelect.value = sortMode;
      }
      syncFilterChips();
      updateHerdrRemoteNote();
      const hasSessionProjects = tree && (tree.projects || []).length > 0;
      const hasNoSessions = tree && tree.noSessions && (tree.noSessions.children || []).length > 0;
      if (!tree || (!hasSessionProjects && !hasNoSessions)) {
        renderGanttAxis(null);
        const empty = '<p class="empty">No projects or sessions yet.</p>';
        if (historyTreeEl.innerHTML !== empty) historyTreeEl.innerHTML = empty;
        return;
      }
      renderGanttAxis(tree.range);
      const nowMs = stateNowMs(state);
      const windowMs = dormantWindowMs(state);
      let projectNodes = sortProjectNodes(tree.projects || [], sortMode);
      if (hideDormant) {
        projectNodes = projectNodes.filter(function (p) {
          return !isDormantProject(p, nowMs, windowMs);
        });
      }
      const projects = filterTree(projectNodes);
      let html = projects.map(function (p) { return historyRowHtml(p, tree.range); }).join('');
      // Sessionless folders keep their own bottom group (still reachable for notes).
      if (tree.noSessions) {
        const groupFiltered = filterTree([tree.noSessions])[0];
        if (groupFiltered) html += historyRowHtml(groupFiltered, tree.range);
      }
      if (!html) {
        html = hideDormant && !stateFilter
          ? '<p class="empty">No active projects — turn off Hide dormant to see older ones.</p>'
          : '<p class="empty">No sessions match this state filter.</p>';
      }
      updateDormantHiddenCount();
      if (historyTreeEl.innerHTML === html) return;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const keepFocus = active && typeof historyTreeEl.contains === 'function' && historyTreeEl.contains(active)
        ? active.getAttribute('data-id')
        : null;
      historyTreeEl.innerHTML = html;
      if (keepFocus && typeof historyTreeEl.querySelectorAll === 'function') {
        const rows = historyTreeEl.querySelectorAll('.history-row');
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute('data-id') === keepFocus && typeof rows[i].focus === 'function') {
            rows[i].focus();
            break;
          }
        }
      }
    }

    function markSelectedRows() {
      if (!historyTreeEl || typeof historyTreeEl.querySelectorAll !== 'function') return;
      const rows = historyTreeEl.querySelectorAll('.history-row');
      for (let i = 0; i < rows.length; i++) {
        const on = rows[i].getAttribute('data-id') === selectedId;
        toggleBtnClass(rows[i], 'selected', on);
        rows[i].setAttribute('aria-selected', String(on));
      }
    }

    function toggleCollapse(id) {
      let found = null;
      (function walk(list) {
        (list || []).forEach(function (n) {
          if (n.id === id) found = n;
          walk(n.children);
        });
      })(historyRoots());
      if (!found) return;
      collapseOverride.set(id, !isCollapsed(found));
      renderHistoryTree();
    }

    function selectRow(id) {
      selectedId = id;
      renderDetail();
    }

    function cancelHistoryTooltipHide() {
      if (historyTooltipHideTimer !== null) clearTimeout(historyTooltipHideTimer);
      historyTooltipHideTimer = null;
    }

    function dismissHistoryTooltip() {
      cancelHistoryTooltipHide();
      historyHoverId = null;
      historyFocusId = null;
      historyTooltipId = null;
      historyTooltipHovered = false;
      renderHistoryTooltip();
    }

    function scheduleHistoryTooltipHide() {
      cancelHistoryTooltipHide();
      if (historyHoverId || historyFocusId || historyTooltipHovered) return;
      historyTooltipHideTimer = setTimeout(function () {
        historyTooltipHideTimer = null;
        if (!historyHoverId && !historyFocusId && !historyTooltipHovered) dismissHistoryTooltip();
      }, 450);
    }

    function positionMarkerTooltip(anchor) {
      if (!historyTooltip || !historyViewEl || !anchor || historyTooltipHovered) return;
      const viewRect = historyViewEl.getBoundingClientRect
        ? historyViewEl.getBoundingClientRect()
        : { width: 800, height: 600, left: 0, top: 0 };
      const aRect = anchor.getBoundingClientRect
        ? anchor.getBoundingClientRect()
        : { left: 12, top: 12, width: 8, height: 8, right: 20, bottom: 20 };
      const tipRect = historyTooltip.getBoundingClientRect
        ? historyTooltip.getBoundingClientRect()
        : { width: 320, height: 160 };
      let left = aRect.left - viewRect.left + 12;
      let top = aRect.bottom - viewRect.top + 6;
      if (left + tipRect.width > viewRect.width - 12) {
        left = Math.max(12, viewRect.width - tipRect.width - 12);
      }
      if (top + tipRect.height > viewRect.height - 12) {
        top = Math.max(12, aRect.top - viewRect.top - tipRect.height - 6);
      }
      historyTooltip.style.left = left + 'px';
      historyTooltip.style.top = top + 'px';
    }

    function renderMarkerTooltipHtml(payload) {
      if (!payload) return '';
      return (
        '<p><strong>' +
        esc(stateLabel(payload.state)) +
        '</strong> · ' +
        esc(payload.at || '') +
        '</p>' +
        '<div class="label">Prompt</div><p>' +
        esc(payload.prompt || '(no prompt)') +
        '</p>' +
        '<div class="label">Reply</div><p>' +
        esc(payload.reply || '(no reply)') +
        '</p>'
      );
    }

    function showMarkerTooltip(markerId, anchor) {
      if (!historyTooltip) return;
      const payload = markerPayload.get(markerId);
      if (!payload) {
        dismissHistoryTooltip();
        return;
      }
      cancelHistoryTooltipHide();
      historyTooltipId = markerId;
      historyHoverId = markerId;
      historyTooltip.hidden = false;
      const html = renderMarkerTooltipHtml(payload);
      if (historyTooltip.innerHTML !== html) historyTooltip.innerHTML = html;
      if (anchor) positionMarkerTooltip(anchor);
    }

    function renderHistoryTooltip() {
      // History row hover popups are disabled; only timeline marker popups use this element.
      if (!historyTooltipId || !markerPayload.has(historyTooltipId)) {
        if (historyTooltip) historyTooltip.hidden = true;
      }
    }

    if (historyTreeEl) {
      historyTreeEl.addEventListener('click', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const actionBtn = closest('[data-action]');
        if (actionBtn && actionBtn.getAttribute && actionBtn.getAttribute('data-action')) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          handleDashboardAction(actionBtn);
          return;
        }
        const markerBtn = closest('.gantt-marker');
        if (markerBtn) {
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          const mid = markerBtn.getAttribute('data-marker-id');
          if (mid) showMarkerTooltip(mid, markerBtn);
          return;
        }
        const twist = closest('button[data-twist]');
        if (twist) {
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          if (!twist.disabled) toggleCollapse(twist.getAttribute('data-twist'));
          return;
        }
        const row = closest('.history-row');
        if (row) {
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          const kind = row.getAttribute('data-kind');
          if (kind === 'no-sessions-group') {
            toggleCollapse(row.getAttribute('data-id'));
            return;
          }
          // Project rows (including sessionless memory folders) stay clickable for notes/docs.
          selectRow(row.getAttribute('data-id'));
        }
      });
      historyTreeEl.addEventListener('dblclick', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const row = closest('.history-row');
        if (!row || row.getAttribute('data-kind') !== 'session') return;
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        openInHerdr(row.getAttribute('data-id'));
      });
      historyTreeEl.addEventListener('mouseover', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const marker = closest('.gantt-marker');
        if (!marker) return;
        const mid = marker.getAttribute('data-marker-id');
        if (!mid) return;
        showMarkerTooltip(mid, marker);
      });
      historyTreeEl.addEventListener('mouseout', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const marker = closest('.gantt-marker');
        if (!marker) return;
        const related = ev.relatedTarget;
        if (related && typeof marker.contains === 'function' && marker.contains(related)) return;
        if (related && historyTooltip && typeof historyTooltip.contains === 'function' && historyTooltip.contains(related)) {
          return;
        }
        if (historyHoverId === marker.getAttribute('data-marker-id')) historyHoverId = null;
        scheduleHistoryTooltipHide();
      });
      historyTreeEl.addEventListener('focusin', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const marker = closest('.gantt-marker');
        if (!marker) return;
        const mid = marker.getAttribute('data-marker-id');
        if (mid) showMarkerTooltip(mid, marker);
      });
      historyTreeEl.addEventListener('focusout', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const marker = closest('.gantt-marker');
        if (!marker) return;
        if (historyHoverId === marker.getAttribute('data-marker-id')) historyHoverId = null;
        scheduleHistoryTooltipHide();
      });
      historyTreeEl.addEventListener('keydown', function (ev) {
        const row = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('.history-row')
          : null;
        if (!row || ev.target !== row) return;
        const id = row.getAttribute('data-id');
        const expanded = row.getAttribute('aria-expanded');
        if (ev.key === 'Escape') {
          dismissHistoryTooltip();
        } else if (ev.key === 'Enter' || ev.key === ' ') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          selectRow(id);
        } else if (ev.key === 'ArrowRight' && expanded === 'false') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          toggleCollapse(id);
        } else if (ev.key === 'ArrowLeft' && expanded === 'true') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          toggleCollapse(id);
        } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof historyTreeEl.querySelectorAll !== 'function') return;
          const rows = Array.prototype.slice.call(historyTreeEl.querySelectorAll('.history-row'));
          const next = rows[rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)];
          if (next && typeof next.focus === 'function') next.focus();
        }
      });
    }

    if (historyTooltip) {
      historyTooltip.addEventListener('mouseenter', function () {
        cancelHistoryTooltipHide();
        historyHoverId = null;
        historyFocusId = null;
        historyTooltipHovered = true;
      });
      historyTooltip.addEventListener('mouseleave', function () {
        historyTooltipHovered = false;
        scheduleHistoryTooltipHide();
      });
      historyTooltip.addEventListener('click', function (ev) {
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
      });
    }

    if (historyFilterEl) {
      historyFilterEl.addEventListener('click', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const chip = closest('.filter-chip');
        if (!chip) return;
        stateFilter = chip.getAttribute('data-state') || '';
        renderHistoryTree();
      });
    }

    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        sortTouched = true;
        sortMode = sortSelect.value || 'recent';
        renderHistoryTree();
      });
    }

    /* ---------- history panel (left off + prompt history) ---------- */

    function safeMarkdown(text) {
      try {
        return renderMarkdown(text, { documentLinks: false });
      } catch (_) {
        return '<pre class="markdown-source">' + esc(text) + '</pre>';
      }
    }

    function previewLines(text, n) {
      return String(text == null ? '' : text).split('\n').slice(0, n).join('\n');
    }

    function snapshotLeftOff(item, isProject) {
      const project = isProject ? item : (state.projects || []).find(function (p) {
        return p.name === item.project;
      });
      const note = project && project.memory && (project.memory.documents || []).find(function (d) {
        return d.kind === 'status';
      });
      const cps = (state.checkpoints && state.checkpoints.projects) || [];
      const cp = cps.find(function (c) {
        return c && project && (c.project === project.name || c.name === project.name);
      });
      const open = cp && ((cp.state === 'requested' && !cp.completedAt) || cp.missing || cp.overdue);
      return {
        completion: item.completion || null,
        statusNote: note
          ? { path: note.path, title: note.title, date: note.date || null, preview: previewLines(note.content, 8) }
          : null,
        checkpoint: open ? cp : null,
      };
    }

    function renderLeftOff(leftOff) {
      if (!leftOff || (!leftOff.completion && !leftOff.statusNote && !leftOff.checkpoint)) {
        return '<p class="empty">Nothing recorded yet for this selection.</p>';
      }
      let html = renderTaskCompletion(leftOff.completion);
      const note = leftOff.statusNote;
      if (note) {
        html += '<section class="status-note-preview"><div class="label">Latest status note</div>' +
          '<p class="completion-meta">' + esc(note.title || note.path || '') +
          (note.date ? ' · ' + esc(note.date) : '') + '</p><div class="completion-body">' +
          safeMarkdown(note.preview || '') + '</div></section>';
      }
      const cp = leftOff.checkpoint;
      if (cp) {
        const flags = [];
        if (cp.state) flags.push(cp.state);
        if (cp.missing) flags.push('missing');
        if (cp.overdue) flags.push('overdue');
        html += '<section class="checkpoint-preview"><div class="label">Doc checkpoint</div>' +
          '<p class="completion-meta">' + esc(flags.join(' · ') || 'open') +
          (cp.requestedAt ? ' · requested ' + esc(cp.requestedAt) : '') + '</p>' +
          (cp.reason ? '<p>' + esc(cp.reason) + '</p>' : '') + '</section>';
      }
      return html;
    }

    function historyItemKey(ev, idx) {
      return [ev.type, ev.at, ev.sessionId || '', ev.path || '', idx].join('|');
    }

    function renderHistoryItems(items) {
      if (!items || !items.length) return '<p class="empty">No prompt history recorded.</p>';
      return items.map(function (ev, idx) {
        const key = historyItemKey(ev, idx);
        const more = !!ev.replyTruncated || (ev.reply != null && ev.replyPreview != null &&
          String(ev.reply) !== String(ev.replyPreview));
        const expanded = expandedReplies.has(key);
        const body = expanded ? ev.reply : (ev.replyPreview != null ? ev.replyPreview : ev.reply);
        const when = String(ev.at || '').replace('T', ' ').slice(0, 19);
        let html = '<article class="history-feed-item" data-key="' + esc(key) + '">' +
          '<div class="when">' + esc(when) + (ev.sessionTitle ? ' · ' + esc(ev.sessionTitle) : '') +
          '<span class="kind-tag">' + esc(ev.kind || ev.type || '') + '</span></div>';
        if (ev.title) html += '<div class="label">' + esc(ev.title) + '</div>';
        if (ev.prompt) html += '<div class="prompt">' + esc(ev.prompt) + '</div>';
        if (body) {
          html += '<div class="reply' + (more && !expanded ? ' collapsed' : '') + '">' +
            safeMarkdown(body) + '</div>';
          if (more) {
            html += '<button type="button" class="expand-reply" data-key="' + esc(key) +
              '" aria-expanded="' + String(expanded) + '">' + (expanded ? 'Collapse' : 'Expand') + '</button>';
          }
          if (expanded && ev.replyTruncated) {
            html += '<p class="completion-meta">Reply truncated in the stored log.</p>';
          }
        }
        return html + '</article>';
      }).join('');
    }

    function renderHistoryPanel() {
      const loaded = historyLoaded;
      if (!loaded) return;
      const data = loaded.data;
      const leftHtml = data ? renderLeftOff(data.leftOff) : '<p class="empty">Loading…</p>';
      if (leftoffEl && leftoffEl.innerHTML !== leftHtml) leftoffEl.innerHTML = leftHtml;
      let feedHtml = '';
      if (loaded.offline) {
        feedHtml += '<p class="empty">Full prompt history requires the live dashboard server ' +
          '(aflt dashboard --serve). This snapshot only includes the latest completion and status note.</p>';
      } else if (loaded.error) {
        feedHtml += '<p class="memory-error">' + esc(loaded.error) + '</p>';
      } else if (loaded.loading && !data) {
        feedHtml += '<p class="empty">Loading history…</p>';
      }
      if (data && !loaded.offline) feedHtml += renderHistoryItems(data.history);
      if (historyFeed && historyFeed.innerHTML !== feedHtml) historyFeed.innerHTML = feedHtml;
    }

    function syncHistoryPanel() {
      const item = findSelection();
      if (!item) {
        historyReq++;
        historyLoaded = null;
        setShown(leftoffPanel, false);
        setShown(historyPanel, false);
        return;
      }
      setShown(leftoffPanel, true);
      setShown(historyPanel, true);
      const isProject = item.sessionCount != null && !!item.name;
      const sig = [item.id, item.lastUsed || item.lastActivity || '',
        item.completion && item.completion.at || ''].join('|');
      if (historyLoaded && historyLoaded.key === item.id && historyLoaded.sig === sig) return;
      const prev = historyLoaded && historyLoaded.key === item.id ? historyLoaded.data : null;
      if (snapshotData) {
        historyLoaded = {
          key: item.id, sig: sig, offline: true,
          data: { leftOff: snapshotLeftOff(item, isProject), history: [], messages: null },
        };
        renderHistoryPanel();
        return;
      }
      const token = ++historyReq;
      historyLoaded = { key: item.id, sig: sig, loading: true, data: prev };
      renderHistoryPanel();
      let url = '/api/history?' + (isProject
        ? 'project=' + encodeURIComponent(item.name)
        : 'session=' + encodeURIComponent(item.id));
      if (showArchived || item.archived) url += '&includeArchived=1';
      fetch(url)
        .then(function (r) {
          return r.json().then(function (body) {
            if (!r.ok) throw new Error((body && body.error) || 'Unable to load history.');
            return body;
          });
        })
        .then(function (data) {
          if (token !== historyReq) return;
          historyLoaded = { key: item.id, sig: sig, data: data };
          renderHistoryPanel();
        })
        .catch(function (err) {
          if (token !== historyReq) return;
          historyLoaded = { key: item.id, sig: sig, data: prev, error: String(err.message || err) };
          renderHistoryPanel();
        });
    }

    if (historyFeed) {
      historyFeed.addEventListener('click', function (ev) {
        const button = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('button.expand-reply')
          : null;
        if (!button) return;
        const key = button.getAttribute('data-key');
        if (expandedReplies.has(key)) expandedReplies.delete(key);
        else expandedReplies.add(key);
        renderHistoryPanel();
      });
    }

    /* ---------- view switching + graph loop ---------- */

    function loop() {
      if (currentView !== 'graph') {
        raf = 0;
        return;
      }
      if (sim && !reduced) stepSim(sim);
      drawGraph();
      raf = requestAnimationFrame(loop);
    }

    function startLoop() {
      if (currentView !== 'graph') return;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    }

    function updateSim(opts) {
      if (!state) return;
      const built = buildSim(state);
      if (!sim || opts.forceRebuild || simStale) {
        sim = Object.assign({}, built, { alpha: 1, nodeSetChanged: true });
      } else {
        sim = mergeSimPreserve(sim, built, { preserveAlpha: true, reheatAlpha: 0.85 });
      }
      simStale = false;
      renderGraphTooltip();
    }

    function toggleBtnClass(btn, name, on) {
      if (!btn) return;
      if (btn.classList && typeof btn.classList.toggle === 'function') {
        btn.classList.toggle(name, on);
        return;
      }
      const cur = String(btn.className || '').split(/\s+/).filter(Boolean);
      const has = cur.indexOf(name) !== -1;
      if (on && !has) cur.push(name);
      if (!on && has) cur.splice(cur.indexOf(name), 1);
      btn.className = cur.join(' ');
    }

    function setView(name) {
      currentView = name === 'graph' ? 'graph' : 'history';
      const graph = currentView === 'graph';
      setShown(historyViewEl, !graph);
      setShown(graphViewEl, graph);
      toggleBtnClass(viewHistoryBtn, 'active', !graph);
      toggleBtnClass(viewGraphBtn, 'active', graph);
      if (viewHistoryBtn) viewHistoryBtn.setAttribute('aria-pressed', String(!graph));
      if (viewGraphBtn) viewGraphBtn.setAttribute('aria-pressed', String(graph));
      if (stage) stage.setAttribute('aria-label', graph ? 'activity graph' : 'session history');
      updateHerdrRemoteNote();
      if (graph) {
        updateSim({ forceRebuild: true });
        startLoop();
      } else {
        stopLoop();
        dismissGraphTooltip();
        renderHistoryTree();
      }
    }

    if (viewHistoryBtn) viewHistoryBtn.addEventListener('click', function () { setView('history'); });
    if (viewGraphBtn) viewGraphBtn.addEventListener('click', function () { setView('graph'); });
    if (hideDormantEl) {
      hideDormantEl.addEventListener('change', function () {
        hideDormant = !!hideDormantEl.checked;
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(HIDE_DORMANT_STORAGE_KEY, hideDormant ? '1' : '0');
          }
        } catch (_) {
          /* ignore */
        }
        renderHistoryTree();
        updateDormantHiddenCount();
        simStale = true;
        updateSim({ forceRebuild: true });
        drawGraph();
        if (currentView === 'graph') startLoop();
      });
    }
    if (showArchivedEl) {
      showArchivedEl.addEventListener('change', function () {
        showArchived = !!showArchivedEl.checked;
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, showArchived ? '1' : '0');
          }
        } catch (_) {
          /* ignore */
        }
        renderHistoryTree();
        renderDetail();
        simStale = true;
        updateSim({ forceRebuild: true });
        drawGraph();
        if (currentView === 'graph') startLoop();
      });
    }

    async function handleDashboardAction(el) {
      if (!el || !el.getAttribute) return false;
      const action = el.getAttribute('data-action');
      if (!action) return false;
      const id = el.getAttribute('data-id');
      const project = el.getAttribute('data-project');
      const title = el.getAttribute('data-title');
      if (action === 'archive' && id) await archiveSession(id, false);
      else if (action === 'archive-children' && id) await archiveSession(id, true);
      else if (action === 'unarchive' && id) await unarchiveSession(id, false);
      else if (action === 'delete' && id) await deleteSession(id, title);
      else if (action === 'archive-idle' && project) await archiveIdleInProject(project);
      else return false;
      return true;
    }

    if (detailEl) {
      detailEl.addEventListener('click', function (ev) {
        const t = ev.target;
        const btn =
          t && t.getAttribute && t.getAttribute('data-action')
            ? t
            : t && t.closest
              ? t.closest('[data-action]')
              : null;
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        handleDashboardAction(btn);
      });
    }
    setShown(graphViewEl, false);

    function applyState(next, opts) {
      opts = opts || {};
      state = next;
      if (!selectedId) {
        const first = (state.projects || []).find(function (p) {
          return p.memory && (p.memory.summary || (p.memory.documents || []).length);
        });
        if (first) selectedId = first.id;
      }
      lastUpdatedAt = Date.now();
      tickMeta();
      renderStats(state);
      drawSpark(spark24, state.sparkline24h, 'var(--cp-accent)');
      drawSpark(spark7, state.sparkline7d, 'var(--cp-link)');
      renderEvents(state);
      renderHistoryTree();
      renderDetail();
      updateHerdrRemoteNote();
      if (historyTooltipId) renderHistoryTooltip();
      // Always rebuild/draw the graph model so a later switch (or tests) have nodes.
      updateSim(opts);
      drawGraph();
      if (currentView === 'graph') startLoop();
      else {
        // Keep a single queued frame so consumers that drain RAF still see an update
        // while history is the default view; do not spin the force loop.
        if (!raf) {
          raf = requestAnimationFrame(function () {
            raf = 0;
            if (currentView === 'graph') startLoop();
            else drawGraph();
          });
        }
      }
    }

    graphTooltip.addEventListener('mouseenter', function () {
      cancelTooltipHide();
      hoverId = null;
      focusId = null;
      tooltipHovered = true;
    });
    graphTooltip.addEventListener('mouseleave', function () {
      tooltipHovered = false;
      scheduleTooltipHide();
    });
    graphTooltip.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    // Empty graph background dismisses the popup (node clicks stopPropagation).
    // Listen on svg, graph-view, and stage so clicks on the SVG/backdrop clear the
    // selection in both the real DOM and the dashboard test harness.
    function clearGraphSelection() {
      if (currentView !== 'graph') return;
      selectedId = null;
      dismissGraphTooltip();
      renderDetail();
    }
    if (svg) svg.addEventListener('click', clearGraphSelection);
    if (graphViewEl) graphViewEl.addEventListener('click', clearGraphSelection);
    if (stage) stage.addEventListener('click', clearGraphSelection);
    if (historyViewEl) {
      historyViewEl.addEventListener('click', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (closest && closest('.history-row, .graph-tooltip, .filter-chip, .twist, button, a, select')) return;
        selectedId = null;
        dismissHistoryTooltip();
        renderDetail();
      });
    }
    window.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        dismissGraphTooltip();
        dismissHistoryTooltip();
      }
    });

    window.addEventListener('resize', function () {
      if (state && currentView === 'graph') applyState(state, { forceRebuild: true });
    });

    function connectSse() {
      const es = new EventSource('/events');
      es.onmessage = function (msg) {
        try {
          applyState(JSON.parse(msg.data));
        } catch (_) {
          /* ignore */
        }
      };
      es.onerror = function () {
        metaEl.textContent = 'local · reconnecting…';
      };
    }

    function firstState(data) {
      applyState(data, { forceRebuild: true });
      if (data && data.defaultView === 'graph') setView('graph');
    }

    if (snapshotData) {
      firstState(JSON.parse(snapshotData.textContent));
      return;
    }

    fetch('/api/state')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        firstState(data);
        connectSse();
      })
      .catch(function () {
        metaEl.textContent = 'local · failed to load';
        connectSse();
      });
  })();
}
