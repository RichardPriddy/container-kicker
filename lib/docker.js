const Docker = require('dockerode');
const { PassThrough } = require('stream');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

async function checkSwarm() {
  const info = await docker.info();
  const swarm = info.Swarm || {};
  return {
    active: swarm.LocalNodeState === 'active',
    isManager: swarm.ControlAvailable === true,
    nodeAddr: swarm.NodeAddr || null,
  };
}

async function listNodes() {
  const nodes = await docker.listNodes();
  return nodes.map((n) => ({
    id: n.ID,
    hostname: n.Description?.Hostname || n.ID.slice(0, 12),
    role: n.Spec?.Role || 'unknown',
    availability: n.Spec?.Availability || 'unknown',
    state: n.Status?.State || 'unknown',
    leader: n.ManagerStatus?.Leader === true,
    engineVersion: n.Description?.Engine?.EngineVersion || null,
  }));
}

async function listServices() {
  const services = await docker.listServices();
  return services.map((s) => {
    const labels = s.Spec?.Labels || {};
    const replicated = s.Spec?.Mode?.Replicated;
    const global = s.Spec?.Mode?.Global;
    return {
      id: s.ID,
      name: s.Spec?.Name || s.ID.slice(0, 12),
      stack: labels['com.docker.stack.namespace'] || null,
      image: s.Spec?.TaskTemplate?.ContainerSpec?.Image || 'unknown',
      mode: replicated ? 'replicated' : global ? 'global' : 'unknown',
      desiredReplicas: replicated ? replicated.Replicas : null,
      updatedAt: s.UpdatedAt,
    };
  });
}

async function listTasks() {
  const tasks = await docker.listTasks();
  return tasks.map((t) => ({
    id: t.ID,
    serviceId: t.ServiceID,
    nodeId: t.NodeID,
    slot: t.Slot ?? null,
    state: t.Status?.State || 'unknown',
    desiredState: t.DesiredState || 'unknown',
    message: t.Status?.Message || null,
    error: t.Status?.Err || null,
    exitCode: t.Status?.ContainerStatus?.ExitCode ?? null,
    containerId: t.Status?.ContainerStatus?.ContainerID || null,
    timestamp: t.Status?.Timestamp || t.UpdatedAt || null,
  }));
}

/** Rolling restart: bumps ForceUpdate so swarm redeploys tasks per the
 *  service's existing UpdateConfig (rolling by default). Zero-downtime-ish,
 *  respects update order/parallelism/health checks.
 *  `onProgress(line)` is called with human-readable progress lines as the
 *  restart proceeds, so the caller can stream them to a client in real time. */
async function forceRestartService(id, onProgress = () => {}) {
  const service = docker.getService(id);
  onProgress('▶ Fetching current service spec...');
  const data = await service.inspect();
  const spec = data.Spec;
  const prev = spec.TaskTemplate.ForceUpdate || 0;
  spec.TaskTemplate.ForceUpdate = prev + 1;
  onProgress(`▶ Bumping ForceUpdate ${prev} → ${spec.TaskTemplate.ForceUpdate}, sending update to swarm manager...`);
  await service.update({ version: data.Version.Index, ...spec });
  onProgress('▶ Update accepted. Watching task states...');

  await watchTaskConvergence(id, onProgress, 30000);
  onProgress('✔ Rolling restart complete.');
}

/** Hard restart: scales the service to 0 replicas, waits for tasks to
 *  actually stop, then scales back to the original replica count.
 *  Causes real downtime for that service — only valid for replicated mode. */
async function hardRestartService(id, onProgress = () => {}) {
  const service = docker.getService(id);
  const data = await service.inspect();
  const spec = data.Spec;

  if (!spec.Mode || !spec.Mode.Replicated) {
    throw new Error('Hard restart (scale 0→N) only works for replicated services, not global services.');
  }

  const originalReplicas = spec.Mode.Replicated.Replicas;
  onProgress(`▶ Current replica count: ${originalReplicas}`);

  const specDown = JSON.parse(JSON.stringify(spec));
  specDown.Mode.Replicated.Replicas = 0;
  onProgress('▶ Scaling service to 0 replicas...');
  await service.update({ version: data.Version.Index, ...specDown });

  onProgress('▶ Waiting for tasks to stop...');
  await waitForRunningCount(id, 0, 25000, onProgress);

  const data2 = await service.inspect();
  const specUp = JSON.parse(JSON.stringify(data2.Spec));
  specUp.Mode.Replicated.Replicas = originalReplicas;
  onProgress(`▶ Scaling back to ${originalReplicas} replica(s)...`);
  await service.update({ version: data2.Version.Index, ...specUp });

  onProgress('▶ Watching new tasks start...');
  await watchTaskConvergence(id, onProgress, 30000);
  onProgress('✔ Hard restart complete.');
}

async function waitForRunningCount(serviceId, targetCount, timeoutMs, onProgress = () => {}) {
  const start = Date.now();
  let lastRunning = null;
  while (Date.now() - start < timeoutMs) {
    const tasks = await docker.listTasks({ filters: JSON.stringify({ service: [serviceId] }) });
    const running = tasks.filter((t) => t.Status?.State === 'running').length;
    if (running !== lastRunning) {
      onProgress(`  running tasks: ${running}`);
      lastRunning = running;
    }
    if (running <= targetCount) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  onProgress('⚠ Timed out waiting for tasks to stop — proceeding to scale back up anyway.');
  // Don't throw on timeout — proceed to scale back up anyway rather than
  // leaving the service parked at 0 replicas.
}

/** Polls task state for a service and reports each transition as it's
 *  observed (deduped), similar to `docker service update --detach=false`.
 *  Resolves once every currently-desired task reaches 'running', or after
 *  timeoutMs elapses (without throwing — convergence issues are surfaced
 *  as a progress line, not a hard failure of the restart itself). */
async function watchTaskConvergence(serviceId, onProgress, timeoutMs) {
  const start = Date.now();
  const lastState = new Map(); // taskId -> last-seen state
  while (Date.now() - start < timeoutMs) {
    const tasks = await docker.listTasks({ filters: JSON.stringify({ service: [serviceId] }) });
    for (const t of tasks) {
      const state = t.Status?.State || 'unknown';
      if (lastState.get(t.ID) !== state) {
        lastState.set(t.ID, state);
        const shortId = t.ID.slice(0, 12);
        const node = t.NodeID ? t.NodeID.slice(0, 12) : 'unknown';
        onProgress(`  task ${shortId} (node ${node}): ${state}`);
      }
    }
    const desired = tasks.filter((t) => t.DesiredState === 'running');
    const running = desired.filter((t) => t.Status?.State === 'running').length;
    if (desired.length > 0 && running === desired.length) {
      onProgress(`  all ${running} task(s) running.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  onProgress('⚠ Timed out waiting for tasks to converge — check task states manually.');
}

/** Fetches recent log lines for a service (aggregated across all its
 *  tasks/replicas — Swarm doesn't expose true single-container log
 *  streaming through the manager, so this is the honest granularity).
 *
 *  NOTE: dockerode only returns a Node stream from service.logs() when
 *  `follow: true` is set. Without it (what we want for a one-shot tail
 *  fetch), it buffers the whole response internally and resolves with a
 *  plain Buffer instead — so we have to handle both shapes here. */
async function getServiceLogLines(id, { tail = 200, sinceSeconds } = {}) {
  const service = docker.getService(id);
  const opts = { stdout: true, stderr: true, tail, timestamps: true };
  if (sinceSeconds) opts.since = sinceSeconds;

  const result = await service.logs(opts);

  const text = Buffer.isBuffer(result)
    ? demuxBuffer(result)
    : await demuxStreamToText(result);

  return text.split('\n').filter(Boolean).map(parseLogLine);
}

/** Docker multiplexes stdout/stderr with an 8-byte header per frame
 *  ([stream type][3 zero bytes][4-byte big-endian length]) unless the
 *  service's container spec sets TTY: true. Falls back to raw text as soon
 *  as a header doesn't look valid (e.g. TTY-enabled tasks, whose output
 *  isn't framed at all). */
function demuxBuffer(buffer) {
  let out = '';
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer.readUInt8(offset);
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) {
      // Not a real frame header — treat everything from here as raw text.
      out += buffer.slice(offset).toString('utf8');
      return out;
    }
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break; // truncated/partial frame — stop parsing
    out += buffer.slice(start, end).toString('utf8');
    offset = end;
  }
  return out || buffer.toString('utf8');
}

function demuxStreamToText(stream) {
  return new Promise((resolve, reject) => {
    const combined = new PassThrough();
    let buf = '';
    combined.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    combined.on('end', () => resolve(buf));
    combined.on('error', reject);

    try {
      docker.modem.demuxStream(stream, combined, combined);
    } catch (err) {
      return reject(err);
    }
    stream.on('end', () => combined.end());
    stream.on('error', reject);
  });
}

function parseLogLine(raw) {
  // Format: "<RFC3339Nano timestamp> <rest of line>"
  const idx = raw.indexOf(' ');
  if (idx === -1) return { timestamp: null, text: raw };
  return { timestamp: raw.slice(0, idx), text: raw.slice(idx + 1) };
}

module.exports = {
  docker,
  checkSwarm,
  listNodes,
  listServices,
  listTasks,
  forceRestartService,
  hardRestartService,
  getServiceLogLines,
};
