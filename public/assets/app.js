(function () {
  const listArea = document.getElementById('listArea');
  const emptyState = document.getElementById('emptyState');
  const errorState = document.getElementById('errorState');
  const runningCountEl = document.getElementById('runningCount');
  const nodeCountEl = document.getElementById('nodeCount');
  const swarmStateEl = document.getElementById('swarmState');
  const filterInput = document.getElementById('filterInput');
  const refreshBtn = document.getElementById('refreshBtn');
  const groupStackBtn = document.getElementById('groupStackBtn');
  const groupNodeBtn = document.getElementById('groupNodeBtn');
  const userbox = document.getElementById('userbox');
  const toast = document.getElementById('toast');

  const detailPanel = document.getElementById('detailPanel');
  const scrim = document.getElementById('scrim');
  const closeDetailBtn = document.getElementById('closeDetailBtn');
  const detailName = document.getElementById('detailName');
  const detailSub = document.getElementById('detailSub');
  const taskList = document.getElementById('taskList');
  const forceRestartBtn = document.getElementById('forceRestartBtn');
  const hardRestartBtn = document.getElementById('hardRestartBtn');
  const logsOutput = document.getElementById('logsOutput');
  const autoscrollToggle = document.getElementById('autoscrollToggle');
  const actionOutputSection = document.getElementById('actionOutputSection');
  const actionOutput = document.getElementById('actionOutput');
  const actionOutputLabel = document.getElementById('actionOutputLabel');

  let overview = { swarm: {}, nodes: [], services: [], tasks: [] };
  let groupMode = 'stack';
  let selectedServiceId = null;
  let overviewTimer = null;
  let logsTimer = null;
  let lastLogTimestamp = null;

  function showToast(msg, isErr) {
    toast.textContent = msg;
    toast.className = 'toast show' + (isErr ? ' err' : '');
    setTimeout(() => { toast.className = 'toast'; }, 2800);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  function ledClass(state) {
    const s = (state || '').toLowerCase();
    if (s === 'running') return 'running';
    if (['failed', 'rejected'].includes(s)) return 'failed';
    if (['starting', 'preparing', 'pending', 'assigned', 'accepted', 'ready'].includes(s)) return 'starting';
    if (['shutdown', 'complete', 'remove'].includes(s)) return 'shutdown';
    return 'other';
  }

  async function loadWhoami() {
    try {
      const res = await fetch('/api/whoami');
      const data = await res.json();
      if (data.authEnabled && data.user) {
        userbox.innerHTML = `<span>${escapeHtml(data.user.username)}</span><a href="/logout">sign out</a>`;
      } else if (data.authEnabled) {
        userbox.innerHTML = `<a href="/login">sign in</a>`;
      } else {
        userbox.innerHTML = `<span>auth disabled</span>`;
      }
    } catch (e) { /* non-fatal */ }
  }

  async function loadOverview() {
    try {
      const res = await fetch('/api/overview');
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) throw new Error('request failed');
      overview = await res.json();
      errorState.style.display = 'none';
      render();
    } catch (err) {
      errorState.textContent = 'Could not load swarm data. Is this running on a swarm manager node?';
      errorState.style.display = 'block';
      listArea.innerHTML = '';
    }
  }

  function serviceRunningCount(serviceId) {
    return overview.tasks.filter((t) => t.serviceId === serviceId && t.state === 'running').length;
  }

  function nodeById(id) {
    return overview.nodes.find((n) => n.id === id);
  }

  function render() {
    const swarm = overview.swarm || {};
    if (!swarm.active) {
      swarmStateEl.textContent = 'swarm inactive on this node';
    } else if (!swarm.isManager) {
      swarmStateEl.textContent = 'this node is a worker, not a manager — connect to a manager socket';
    } else {
      swarmStateEl.textContent = 'manager · connected';
    }

    nodeCountEl.textContent = overview.nodes.length;
    const runningServices = overview.services.filter((s) => serviceRunningCount(s.id) > 0).length;
    runningCountEl.textContent = runningServices;

    const q = filterInput.value.trim().toLowerCase();
    const matches = (s) => !q || s.name.toLowerCase().includes(q) || (s.image || '').toLowerCase().includes(q);

    if (overview.services.length === 0) {
      listArea.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';

    listArea.innerHTML = groupMode === 'stack' ? renderByStack(matches) : renderByNode(matches);

    listArea.querySelectorAll('[data-service-id]').forEach((el) => {
      el.addEventListener('click', () => openDetail(el.getAttribute('data-service-id')));
    });

    if (selectedServiceId) {
      listArea.querySelectorAll(`[data-service-id="${selectedServiceId}"]`).forEach((el) => el.classList.add('selected'));
    }
  }

  function renderByStack(matches) {
    const services = overview.services.filter(matches);
    const groups = {};
    services.forEach((s) => {
      const key = s.stack || '(no stack)';
      (groups[key] = groups[key] || []).push(s);
    });
    return Object.keys(groups).sort().map((stackName) => {
      const rows = groups[stackName].map((s) => {
        const running = serviceRunningCount(s.id);
        const desired = s.desiredReplicas ?? '—';
        const anyRunning = running > 0;
        return `
          <div class="row" data-service-id="${s.id}">
            <span class="led ${anyRunning ? 'running' : 'other'}"></span>
            <div class="row-main">
              <div class="row-name">${escapeHtml(s.name)}</div>
              <div class="row-sub">${escapeHtml(s.image)}</div>
            </div>
            <div class="row-meta">
              <div class="replicas">${running}/${desired}</div>
              <div>${escapeHtml(s.mode)}</div>
            </div>
          </div>`;
      }).join('');
      return `<div class="group">
        <div class="group-header">${escapeHtml(stackName)} <span class="badge">${groups[stackName].length}</span></div>
        ${rows}
      </div>`;
    }).join('');
  }

  function renderByNode(matches) {
    const visibleServiceIds = new Set(overview.services.filter(matches).map((s) => s.id));
    const byNode = {};
    overview.tasks
      .filter((t) => visibleServiceIds.has(t.serviceId) && ['running', 'starting', 'preparing', 'pending', 'assigned'].includes(t.state))
      .forEach((t) => {
        (byNode[t.nodeId] = byNode[t.nodeId] || []).push(t);
      });

    return overview.nodes.map((node) => {
      const tasks = byNode[node.id] || [];
      if (tasks.length === 0) return '';
      const rows = tasks.map((t) => {
        const service = overview.services.find((s) => s.id === t.serviceId);
        if (!service) return '';
        return `
          <div class="row" data-service-id="${service.id}">
            <span class="led ${ledClass(t.state)}"></span>
            <div class="row-main">
              <div class="row-name">${escapeHtml(service.name)}</div>
              <div class="row-sub">${escapeHtml(t.state)}${t.slot ? ` · slot ${t.slot}` : ''}</div>
            </div>
            <div class="row-meta">${escapeHtml(service.image)}</div>
          </div>`;
      }).join('');
      return `<div class="group">
        <div class="group-header">${escapeHtml(node.hostname)} <span class="badge">${node.role}${node.leader ? ' · leader' : ''}</span></div>
        ${rows}
      </div>`;
    }).join('');
  }

  function openDetail(serviceId) {
    selectedServiceId = serviceId;
    render();
    detailPanel.classList.add('open');
    scrim.classList.add('open');
    renderDetail();
    resetActionOutput();
    startLogPolling();
  }

  function closeDetail() {
    selectedServiceId = null;
    detailPanel.classList.remove('open');
    scrim.classList.remove('open');
    stopLogPolling();
    resetActionOutput();
    render();
  }

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const expandedTaskIds = new Set();

  function formatTaskTimestamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function taskHasDetail(t) {
    return Boolean(t.message || t.error || (t.exitCode !== null && t.exitCode !== undefined));
  }

  function renderDetail() {
    const service = overview.services.find((s) => s.id === selectedServiceId);
    if (!service) return;
    detailName.textContent = service.name;
    detailSub.textContent = `${service.stack ? service.stack + ' · ' : ''}${service.image}`;

    const cutoff = Date.now() - ONE_WEEK_MS;
    const tasks = overview.tasks
      .filter((t) => t.serviceId === service.id)
      .filter((t) => {
        // Currently-desired tasks (Swarm still wants this one running) stay
        // visible no matter how long they've been up — the timestamp here
        // is "when it entered this state", not "when it stopped", so a
        // healthy 3-week-old running task would otherwise get hidden.
        if (t.desiredState === 'running') return true;
        // Historical/terminal entries (past shutdown/rejected/failed
        // attempts Swarm keeps for debugging) get the 7-day cutoff.
        if (!t.timestamp) return true; // no timestamp to judge by — don't hide it
        const ts = new Date(t.timestamp).getTime();
        return isNaN(ts) || ts >= cutoff;
      })
      .sort((a, b) => {
        // Active (currently-desired) tasks always float above historical
        // ones — a rolling update can start the new task a few seconds
        // *before* stopping the old one, so raw timestamp order alone can
        // put a dead task above the one that's actually running now.
        const activeA = a.desiredState === 'running' ? 1 : 0;
        const activeB = b.desiredState === 'running' ? 1 : 0;
        if (activeA !== activeB) return activeB - activeA;
        return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
      });

    taskList.innerHTML = tasks.length
      ? tasks.map((t) => {
          const node = nodeById(t.nodeId);
          const when = formatTaskTimestamp(t.timestamp);
          const hasDetail = taskHasDetail(t);
          const expanded = expandedTaskIds.has(t.id);

          const detailLines = [];
          if (t.message) detailLines.push(`message: ${t.message}`);
          if (t.error) detailLines.push(`error: ${t.error}`);
          if (t.exitCode !== null && t.exitCode !== undefined) detailLines.push(`exit code: ${t.exitCode}`);

          return `
            <div class="task-row ${hasDetail ? 'clickable' : ''}" data-task-id="${t.id}">
              <span class="led ${ledClass(t.state)}"></span>
              <span class="task-node">${escapeHtml(node ? node.hostname : t.nodeId.slice(0, 12))}</span>
              <span>${escapeHtml(t.state)}</span>
              ${when ? `<span class="task-time">${escapeHtml(when)}</span>` : ''}
              ${hasDetail ? `<span class="task-expand-icon">${expanded ? '▾' : '▸'}</span>` : ''}
            </div>
            ${expanded && hasDetail ? `<div class="task-detail">${detailLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>` : ''}
          `;
        }).join('')
      : '<div class="task-row">no tasks in the last 7 days</div>';
  }

  function resetActionOutput() {
    actionOutputSection.style.display = 'none';
    actionOutput.textContent = '';
    actionOutputLabel.textContent = 'action output';
    actionOutputLabel.classList.remove('running');
  }

  async function doRestart(kind) {
    const service = overview.services.find((s) => s.id === selectedServiceId);
    if (!service) return;

    const label = kind === 'force' ? 'rolling restart' : 'hard restart';
    const msg = kind === 'force'
      ? `Rolling restart "${service.name}"? Swarm will redeploy tasks per its update policy.`
      : `Hard restart "${service.name}"? This scales to 0 replicas then back — it WILL cause downtime for this service.`;
    if (!confirm(msg)) return;

    forceRestartBtn.disabled = true;
    hardRestartBtn.disabled = true;

    actionOutputSection.style.display = 'flex';
    actionOutput.textContent = '';
    actionOutputLabel.textContent = `${label} — running`;
    actionOutputLabel.classList.add('running');

    let fullText = '';
    try {
      const res = await fetch(`/api/services/${service.id}/${kind === 'force' ? 'force-restart' : 'hard-restart'}`, { method: 'POST' });

      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          fullText += chunk;
          actionOutput.textContent += chunk;
          actionOutput.scrollTop = actionOutput.scrollHeight;
        }
      } else {
        // Fallback for browsers/environments without a streaming response body
        fullText = await res.text();
        actionOutput.textContent = fullText;
      }

      const success = !fullText.includes('✖');
      actionOutputLabel.textContent = success ? `${label} — done` : `${label} — failed`;
      showToast(`${service.name} — ${label} ${success ? 'finished' : 'failed'}.`, !success);
    } catch (err) {
      actionOutput.textContent += `\n✖ ${err.message}`;
      actionOutputLabel.textContent = `${label} — failed`;
      showToast(`${service.name} — ${label} failed: ${err.message}`, true);
    } finally {
      actionOutputLabel.classList.remove('running');
      forceRestartBtn.disabled = false;
      hardRestartBtn.disabled = false;
      loadOverview();
    }
  }

  async function fetchLogs() {
    if (!selectedServiceId) return;
    try {
      const params = new URLSearchParams({ tail: '200' });
      if (lastLogTimestamp) params.set('since', String(Math.floor(new Date(lastLogTimestamp).getTime() / 1000)));
      const res = await fetch(`/api/services/${selectedServiceId}/logs?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        logsOutput.textContent = data.error || 'Could not load logs for this service.';
        return;
      }
      const { lines } = await res.json();
      const fresh = lastLogTimestamp
        ? lines.filter((l) => l.timestamp && l.timestamp > lastLogTimestamp)
        : lines;

      if (!lastLogTimestamp) logsOutput.textContent = '';
      if (fresh.length === 0 && !lastLogTimestamp && lines.length === 0) {
        logsOutput.textContent = '(no log output yet)';
      }

      fresh.forEach((l) => {
        const div = document.createElement('div');
        div.className = 'ln';
        const ts = l.timestamp ? `<span class="ts">${escapeHtml(l.timestamp.split('.')[0].replace('T', ' '))}</span>` : '';
        div.innerHTML = ts + escapeHtml(l.text);
        logsOutput.appendChild(div);
        lastLogTimestamp = l.timestamp || lastLogTimestamp;
      });

      if (autoscrollToggle.checked) logsOutput.scrollTop = logsOutput.scrollHeight;
    } catch (err) {
      // transient errors during polling — don't spam the UI
    }
  }

  function startLogPolling() {
    stopLogPolling();
    lastLogTimestamp = null;
    logsOutput.textContent = 'loading logs…';
    fetchLogs();
    logsTimer = setInterval(fetchLogs, 3000);
  }
  function stopLogPolling() {
    if (logsTimer) clearInterval(logsTimer);
    logsTimer = null;
  }

  // Event wiring
  refreshBtn.addEventListener('click', loadOverview);
  filterInput.addEventListener('input', render);
  closeDetailBtn.addEventListener('click', closeDetail);
  scrim.addEventListener('click', closeDetail);
  forceRestartBtn.addEventListener('click', () => doRestart('force'));
  hardRestartBtn.addEventListener('click', () => doRestart('hard'));

  taskList.addEventListener('click', (e) => {
    const row = e.target.closest('.task-row.clickable[data-task-id]');
    if (!row) return;
    const id = row.getAttribute('data-task-id');
    if (expandedTaskIds.has(id)) {
      expandedTaskIds.delete(id);
    } else {
      expandedTaskIds.add(id);
    }
    renderDetail();
  });

  groupStackBtn.addEventListener('click', () => {
    groupMode = 'stack';
    groupStackBtn.classList.add('active');
    groupNodeBtn.classList.remove('active');
    render();
  });
  groupNodeBtn.addEventListener('click', () => {
    groupMode = 'node';
    groupNodeBtn.classList.add('active');
    groupStackBtn.classList.remove('active');
    render();
  });

  loadWhoami();
  loadOverview();
  overviewTimer = setInterval(loadOverview, 5000);
})();
