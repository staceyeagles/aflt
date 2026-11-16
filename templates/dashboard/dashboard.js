'use strict';

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
  module.exports = { mergeSimPreserve };
} else {
  (function () {
    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    const svg = document.getElementById('graph');
    const metaEl = document.getElementById('meta');
    const statsEl = document.getElementById('stats');
    const detailEl = document.getElementById('detail');
    const eventsEl = document.getElementById('events');
    const spark24 = document.getElementById('spark24');
    const spark7 = document.getElementById('spark7');
    const hintEl = document.getElementById('hint');

    let state = null;
    let selectedId = null;
    let hoverId = null;
    let sim = null;
    let lastUpdatedAt = Date.now();
    let raf = 0;

    const COLORS = {
      running: '#2dd4bf',
      idle: '#fbbf24',
      done: '#64748b',
      failed: '#f87171',
    };

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
      metaEl.textContent = 'local · updated ' + ago(Date.now() - lastUpdatedAt);
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
        '<div class="stat"><div class="k">running</div><div class="v running">' +
        (st.runningSessions || 0) +
        '</div></div>' +
        '<div class="engines">cursor ' +
        (eng.cursor || 0) +
        ' · copilot ' +
        (eng.copilot || 0) +
        ' · open ' +
        (st.open || 0) +
        ' · idle ' +
        (st.idle || 0) +
        ' · done ' +
        (st.done || 0) +
        ' · failed ' +
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
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

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
      const item = findSelection();
      if (!item) {
        detailEl.innerHTML = '<div class="empty">select a project or session</div>';
        return;
      }
      if (item.sessionCount != null && item.name) {
        detailEl.innerHTML =
          '<div class="label">project</div><h2>' +
          esc(item.name) +
          '</h2><span class="badge ' +
          esc(item.displayState) +
          '">' +
          esc(item.displayState) +
          '</span><dl>' +
          row('sessions', item.sessionCount) +
          row('running', item.runningCount) +
          row('last activity', item.lastActivity || '—') +
          '</dl>';
        return;
      }
      const kids = (item.children || []).length;
      detailEl.innerHTML =
        '<div class="label">session</div><h2>' +
        esc(item.title) +
        '</h2><span class="badge ' +
        esc(item.displayState) +
        '">' +
        esc(item.displayState) +
        '</span><dl>' +
        row('id', item.id) +
        row('project', item.project) +
        row('engine', item.engine) +
        row('status', item.status) +
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
        '</dl>';
    }

    function row(k, v) {
      return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>';
    }

    function buildSim(s) {
      const rect = svg.getBoundingClientRect();
      const w = Math.max(rect.width || 800, 320);
      const h = Math.max(rect.height || 600, 320);
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      const nodes = [];
      const links = [];
      const projects = s.projects || [];
      const sessions = s.sessions || [];
      const n = Math.max(projects.length, 1);
      const hubR = Math.min(w, h) * 0.28;
      const cx = w * 0.5;
      const cy = h * 0.5;

      projects.forEach(function (p, i) {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        nodes.push({
          id: p.id,
          kind: 'project',
          label: p.name,
          displayState: p.displayState,
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
          label: sess.title,
          displayState: sess.displayState,
          recent: !!sess.recent,
          x: parent.x + Math.cos(a) * 70,
          y: parent.y + Math.sin(a) * 70,
          vx: 0,
          vy: 0,
          r: 8,
          project: sess.project,
        });
        links.push({
          source: parent.id || 'project:' + sess.project,
          target: sess.id,
          kind: 'project',
          recent: !!sess.recent,
        });
      });

      (s.links || []).forEach(function (l) {
        if (l.kind === 'parent') {
          links.push({ source: l.from, target: l.to, kind: 'parent', recent: false });
        }
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

    function drawGraph() {
      if (!sim) return;
      const ns = 'http://www.w3.org/2000/svg';
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      const stars = document.createElementNS(ns, 'g');
      for (let i = 0; i < 50; i++) {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', String((i * 97) % sim.w));
        c.setAttribute('cy', String((i * 53) % sim.h));
        c.setAttribute('r', '1');
        c.setAttribute('fill', '#94a3b8');
        c.setAttribute('opacity', String(0.12 + (i % 5) * 0.04));
        stars.appendChild(c);
      }
      svg.appendChild(stars);

      const edgeG = document.createElementNS(ns, 'g');
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
      svg.appendChild(edgeG);

      const nodeG = document.createElementNS(ns, 'g');
      sim.nodes.forEach(function (n) {
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'node-hit');
        g.setAttribute('data-id', n.id);

        if (n.kind === 'project') {
          const c = document.createElementNS(ns, 'circle');
          c.setAttribute('cx', n.x);
          c.setAttribute('cy', n.y);
          c.setAttribute('r', n.r);
          c.setAttribute('class', 'hub');
          c.setAttribute('stroke', COLORS[n.displayState] || COLORS.done);
          g.appendChild(c);
          const label = document.createElementNS(ns, 'text');
          label.setAttribute('x', n.x);
          label.setAttribute('y', n.y + n.r + 14);
          label.setAttribute('text-anchor', 'middle');
          label.setAttribute('class', 'hub-label');
          label.textContent = n.label;
          g.appendChild(label);
        } else {
          const c = document.createElementNS(ns, 'circle');
          c.setAttribute('cx', n.x);
          c.setAttribute('cy', n.y);
          c.setAttribute('r', n.r);
          c.setAttribute(
            'class',
            'leaf ' +
              (n.displayState || 'done') +
              (n.displayState === 'running' && !reduced ? ' pulse' : '')
          );
          g.appendChild(c);
        }

        if (hoverId === n.id && n.kind === 'session') {
          const tipBg = document.createElementNS(ns, 'rect');
          const tip = document.createElementNS(ns, 'text');
          tip.setAttribute('x', n.x);
          tip.setAttribute('y', n.y - 16);
          tip.setAttribute('text-anchor', 'middle');
          tip.setAttribute('class', 'tooltip-text');
          tip.textContent = n.label;
          g.appendChild(tip);
          const bb = { width: Math.min(220, n.label.length * 6.2 + 16), height: 18 };
          tipBg.setAttribute('x', n.x - bb.width / 2);
          tipBg.setAttribute('y', n.y - 28);
          tipBg.setAttribute('width', bb.width);
          tipBg.setAttribute('height', bb.height);
          tipBg.setAttribute('rx', '4');
          tipBg.setAttribute('class', 'tooltip');
          g.insertBefore(tipBg, tip);
        }

        g.addEventListener('mouseenter', function () {
          hoverId = n.id;
          hintEl.textContent = n.label;
        });
        g.addEventListener('mouseleave', function () {
          if (hoverId === n.id) hoverId = null;
          hintEl.textContent = 'hover a node · click for details';
        });
        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          selectedId = n.id;
          renderDetail();
        });
        nodeG.appendChild(g);
      });
      svg.appendChild(nodeG);
    }

    function loop() {
      if (sim && !reduced) stepSim(sim);
      drawGraph();
      raf = requestAnimationFrame(loop);
    }

    function applyState(next, opts) {
      opts = opts || {};
      state = next;
      lastUpdatedAt = Date.now();
      tickMeta();
      renderStats(state);
      drawSpark(spark24, state.sparkline24h, '#2dd4bf');
      drawSpark(spark7, state.sparkline7d, '#38bdf8');
      renderEvents(state);
      renderDetail();
      const built = buildSim(state);
      if (!sim || opts.forceRebuild) {
        sim = Object.assign({}, built, { alpha: 1, nodeSetChanged: true });
      } else {
        sim = mergeSimPreserve(sim, built, { preserveAlpha: true, reheatAlpha: 0.85 });
      }
    }

    svg.addEventListener('click', function () {
      selectedId = null;
      renderDetail();
    });

    window.addEventListener('resize', function () {
      if (state) applyState(state, { forceRebuild: true });
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

    fetch('/api/state')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        applyState(data, { forceRebuild: true });
        if (!raf) raf = requestAnimationFrame(loop);
        connectSse();
      })
      .catch(function () {
        metaEl.textContent = 'local · failed to load';
        connectSse();
        if (!raf) raf = requestAnimationFrame(loop);
      });
  })();
}
