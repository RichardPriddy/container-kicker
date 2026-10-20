const passport = require('passport');
const { Strategy: OpenIDConnectStrategy } = require('passport-openidconnect');
const { readSecret } = require('./secrets');

async function discover(issuer) {
  const url = issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery request to ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Wires up Authentik (or any standards-compliant OIDC provider) login.
 * Returns { enabled: boolean }. If required env vars are missing, auth is
 * skipped entirely and the app runs open — the caller is responsible for
 * warning loudly about this.
 */
async function setupAuth(app) {
  const issuer = process.env.OIDC_ISSUER;
  const clientID = readSecret('OIDC_CLIENT_ID');
  const clientSecret = readSecret('OIDC_CLIENT_SECRET');
  const callbackPath = process.env.OIDC_CALLBACK_PATH || '/auth/callback';
  const publicURL = process.env.PUBLIC_URL; // e.g. https://dashboard.example.com

  if (!issuer || !clientID || !clientSecret) {
    return { enabled: false };
  }
  if (!publicURL) {
    throw new Error('PUBLIC_URL must be set when OIDC is configured (used to build the callback URL Authentik redirects to).');
  }

  const config = await discover(issuer);
  const callbackURL = publicURL.replace(/\/+$/, '') + callbackPath;

  passport.use('oidc', new OpenIDConnectStrategy(
    {
      issuer,
      authorizationURL: config.authorization_endpoint,
      tokenURL: config.token_endpoint,
      userInfoURL: config.userinfo_endpoint,
      clientID,
      clientSecret,
      callbackURL,
      scope: 'openid profile email',
    },
    (issuer, profile, done) => {
      const user = {
        id: profile.id,
        username: profile.username || profile.displayName || profile.id,
        email: profile.emails?.[0]?.value || null,
      };
      return done(null, user);
    },
  ));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  app.use(passport.initialize());
  app.use(passport.session());

  app.get('/login', passport.authenticate('oidc'));

  app.get(
    callbackPath,
    passport.authenticate('oidc', { failureRedirect: '/login-failed' }),
    (req, res) => res.redirect('/'),
  );

  app.get('/login-failed', (req, res) => {
    res.status(401).send('Sign-in failed. Check the Authentik application config and redirect URI, then try again.');
  });

  app.get('/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => res.redirect('/'));
    });
  });

  return { enabled: true };
}

function requireAuth(authEnabled) {
  return (req, res, next) => {
    if (!authEnabled) return next();
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  };
}

module.exports = { setupAuth, requireAuth };
