const fs = require('fs');

/**
 * Reads a config value, preferring a Docker-secret file over a plain env var.
 *
 * Convention (matches `PASSWORD_FILE=/run/secrets/password`):
 *   - If `${name}_FILE` is set, read and trim the file at that path.
 *   - Else fall back to `process.env[name]` directly.
 *   - Else fall back to the provided default (may be undefined).
 *
 * Throws if a `_FILE` var is set but the file can't be read, since that
 * usually means a misconfigured secret mount and should fail loudly rather
 * than silently falling back to an empty/insecure value.
 */
function readSecret(name, fallback) {
  const fileVar = `${name}_FILE`;
  const filePath = process.env[fileVar];

  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(`Could not read secret for ${name} from ${fileVar}=${filePath}: ${err.message}`);
    }
  }

  if (process.env[name] !== undefined && process.env[name] !== '') {
    return process.env[name];
  }

  return fallback;
}

module.exports = { readSecret };
