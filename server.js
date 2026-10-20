const express = require('express');
const session = require('express-session');
const path = require('path');

const { readSecret } = require('./lib/secrets');
const { setupAuth, requireAuth } = require('./lib/auth');
const dockerLib = require('./lib/docker');

const app = express();
const PORT = process.env.PORT || 8088;

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : 0);
app.use(express.json());

const sessionSecret = readSecret('SESSION_SECRET');
if (!sessionSecret) {
  console.warn('No SESSION_SECRET (or SESSION_SECRET_FILE) set — using a random secret. Sessions will not survive a restart. Set one via a Docker secret for production.');
}

app.use(session({
  secret: sessionSecret || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8, // 8h
  },
}));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/assets/icons/favicon.ico'));
});

async function bootstrap() {
  let authState;
  try {
    authState = await setupAuth(app);
  } catch (err) {
    console.error('Failed to set up OIDC auth:', err.message);
    process.exit(1);
  }

  if (!authState.enabled) {
    console.warn('⚠️  OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET not fully set — running WITHOUT authentication. Do not expose this beyond localhost/a trusted network.');
  }

  const auth = requireAuth(authState.enabled);

  app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

  app.get('/', auth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
  });

  app.get('/api/whoami', auth, (req, res) => {
    res.json({ authEnabled: authState.enabled, user: req.user || null });
  });

  app.get('/api/overview', auth, async (req, res) => {
    try {
      const [swarm, nodes, services, tasks] = await Promise.all([
        dockerLib.checkSwarm(),
        dockerLib.listNodes(),
        dockerLib.listServices(),
        dockerLib.listTasks(),
      ]);
      res.json({ swarm, nodes, services, tasks });
    } catch (err) {
      console.error('overview error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /** Streams progress lines from a restart action to the client as they
   *  happen (plain text, chunked) instead of waiting for the whole thing to
   *  finish and returning one JSON blob. Errors are written as a final
   *  "✖ ..." line rather than an HTTP error status, since the response has
   *  already started streaming by the time most failures could occur. */
  function streamAction(res, actionFn) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // hint proxies not to buffer chunked output
    const write = (line) => res.write(`${line}\n`);
    actionFn(write)
      .catch((err) => {
        console.error('restart action error:', err.message);
        write(`✖ ${err.message}`);
      })
      .finally(() => res.end());
  }

  app.post('/api/services/:id/force-restart', auth, (req, res) => {
    streamAction(res, (write) => dockerLib.forceRestartService(req.params.id, write));
  });

  app.post('/api/services/:id/hard-restart', auth, (req, res) => {
    streamAction(res, (write) => dockerLib.hardRestartService(req.params.id, write));
  });

  app.get('/api/services/:id/logs', auth, async (req, res) => {
    try {
      const tail = Math.min(parseInt(req.query.tail, 10) || 200, 2000);
      const sinceSeconds = req.query.since ? parseInt(req.query.since, 10) : undefined;
      const lines = await dockerLib.getServiceLogLines(req.params.id, { tail, sinceSeconds });
      res.json({ lines });
    } catch (err) {
      console.error('logs error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`Container Kicker listening on :${PORT} (auth: ${authState.enabled ? 'OIDC via Authentik' : 'DISABLED'})`);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
