import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUTOMATIC, MANUAL, ipmi, parseController, parseSensors, speedCommand } from './ipmi.mjs';
import { installConsole } from './console.mjs';

const SENSOR_INTERVAL = 10_000;
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/console.js', ['console.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateConnection(input, saved) {
  const host = typeof input?.host === 'string' ? input.host.trim() : '';
  const user = typeof input?.user === 'string' ? input.user.trim() : '';
  const reusePassword = input?.password === '' && host === saved?.host && user === saved?.user;
  const password = reusePassword ? saved.password : input?.password;
  if (!isIP(host) || host.includes('%')) throw new HttpError(400, 'Enter a valid iDRAC IP address.');
  if (!user || Buffer.byteLength(user) > 16 || /[\x00-\x1f\x7f]/.test(user)) {
    throw new HttpError(400, 'Enter an IPMI username of up to 16 bytes.');
  }
  if (typeof password !== 'string' || !password || password.includes('\0')) {
    throw new HttpError(400, 'Enter the iDRAC password.');
  }
  return { host, user, password };
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  if (!/^application\/json\s*(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Send a JSON request.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8192) {
      request.resume();
      throw new HttpError(413, 'The request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

async function dashboardCredentials(dataDir) {
  const user = process.env.DASHBOARD_USER;
  const password = process.env.DASHBOARD_PASSWORD;
  if (user && password) return { user, password };

  const path = join(dataDir, 'dashboard-login.json');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    const generated = { user: `rv-${randomBytes(4).toString('hex')}`, password: randomBytes(24).toString('base64url') };
    await writeFile(path, `${JSON.stringify(generated)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const generated = JSON.parse(await readFile(path, 'utf8'));
  return { user: user || generated.user, password: password || generated.password };
}

export async function createDashboard({ dataDir, user, password, run = ipmi, ws, novncDir = '/usr/share/novnc' }) {
  if (!user || user.includes(':') || !password) {
    throw new Error('Set DASHBOARD_PASSWORD and a valid DASHBOARD_USER before starting Rackview.');
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configPath = join(dataDir, 'connection.json');
  let connection = null;
  try {
    connection = validateConnection(JSON.parse(await readFile(configPath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('The saved iDRAC connection could not be loaded.');
  }

  const credentials = digest(`${user}:${password}`);
  const csrf = randomBytes(32).toString('base64url');
  let revision = randomBytes(16).toString('hex');
  let lastCommand = null;
  let sensors = [];
  let updatedAt = null;
  let sensorError = null;
  let lastAttempt = 0;
  let reading = null;
  let busy = false;

  async function exclusive(action) {
    if (busy) throw new HttpError(409, 'An iDRAC operation is already in progress. Try again shortly.');
    busy = true;
    try {
      await reading;
      return await action();
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    if (!connection || busy) return;
    if (reading) return reading;
    if (Date.now() - lastAttempt < SENSOR_INTERVAL) return;
    reading = (async () => {
      try {
        const rows = parseSensors(await run(connection, ['sdr', 'elist']));
        if (!rows.length) throw new Error('No sensor records were returned.');
        sensors = rows;
        updatedAt = new Date().toISOString();
        sensorError = null;
      } catch (error) {
        sensorError = error.message;
      } finally {
        lastAttempt = Date.now();
      }
    })();
    try {
      await reading;
    } finally {
      reading = null;
    }
  }

  async function save(next) {
    const temporary = `${configPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temporary, configPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    if (connection?.host !== next.host) lastCommand = null;
    connection = next;
    revision = randomBytes(16).toString('hex');
    sensors = [];
    updatedAt = null;
    sensorError = null;
    lastAttempt = 0;
  }

  async function setFanControl(input) {
    const { mode, percent } = input ?? {};
    if (mode !== 'auto' && (mode !== 'manual' || !Number.isInteger(percent) || percent < 0 || percent > 100)) {
      throw new HttpError(400, 'Choose automatic mode or a whole-number manual speed from 0 to 100%.');
    }
    if (!connection) throw new HttpError(409, 'Save an iDRAC connection first.');
    if (input.revision !== revision) throw new HttpError(409, 'The connection changed. Refresh the dashboard first.');

    try {
      await run(connection, mode === 'manual' ? MANUAL : AUTOMATIC);
      if (mode === 'manual') await run(connection, speedCommand(percent));
      lastCommand = { mode, percent: mode === 'manual' ? percent : null, at: new Date().toISOString() };
    } catch (error) {
      lastCommand = null;
      if (mode === 'auto') throw new HttpError(502, `Could not restore automatic mode. ${error.message}`);
      try {
        await run(connection, AUTOMATIC);
        lastCommand = { mode: 'auto', percent: null, at: new Date().toISOString() };
      } catch (restoreError) {
        throw new HttpError(502, `Manual control failed and automatic mode could not be restored. ${error.message} ${restoreError.message}`);
      }
      throw new HttpError(502, `Manual control failed. Automatic mode was restored. ${error.message}`);
    } finally {
      lastAttempt = 0;
    }
    return lastCommand;
  }

  const server = createServer({ requestTimeout: 30_000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const { method, url } = request;
    if (method === 'GET' && url === '/healthz') return json(response, 200, { ok: true });

    const basic = /^Basic (\S+)$/i.exec(request.headers.authorization ?? '');
    if (!basic || !timingSafeEqual(credentials, digest(Buffer.from(basic[1], 'base64')))) {
      response.setHeader('WWW-Authenticate', 'Basic realm="Rackview", charset="UTF-8"');
      return json(response, 401, { error: 'Sign in to Rackview.' });
    }

    try {
      if (method === 'GET' && assets.has(url.split('?')[0])) {
        const [file, type] = assets.get(url.split('?')[0]);
        const content = await readFile(new URL(`./web/${file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return response.end(content);
      }
      if (method === 'GET' && /^\/novnc\/(?:core|vendor)\/(?:[\w-]+\/)*[\w.-]+\.js$/.test(url)) {
        const content = await readFile(join(novncDir, url.slice('/novnc/'.length))).catch((error) => {
          if (error.code === 'ENOENT') throw new HttpError(404, 'Console library unavailable.');
          throw error;
        });
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return response.end(content);
      }
      if (method === 'GET' && url === '/api/status') {
        await refresh();
        return json(response, 200, {
          connection: connection ? { host: connection.host, user: connection.user } : null,
          csrf, revision, sensors, updatedAt, sensorError, lastCommand, consoleAvailable: !!issueConsoleTicket, pollMs: SENSOR_INTERVAL,
        });
      }
      if (method === 'POST') {
        if (request.headers['x-csrf-token'] !== csrf || request.headers['sec-fetch-site'] === 'cross-site') {
          throw new HttpError(403, 'Refresh Rackview and try again.');
        }
        const input = await readJson(request);
        if (url === '/api/connection/test') {
          const details = await exclusive(async () => {
            const next = validateConnection(input, connection);
            try {
              return parseController(await run(next, ['mc', 'info']));
            } catch (error) {
              throw new HttpError(502, `Connection test failed. ${error.message}`);
            }
          });
          return json(response, 200, { details });
        }
        if (url === '/api/connection') {
          await exclusive(async () => {
            if (input?.revision !== revision) throw new HttpError(409, 'The connection settings changed. Refresh and try again.');
            await save(validateConnection(input, connection));
          });
          return json(response, 200, { ok: true });
        }
        if (url === '/api/fans') {
          return json(response, 200, { lastCommand: await exclusive(() => setFanControl(input)) });
        }
        if (url === '/api/console/ticket') {
          if (!issueConsoleTicket) throw new HttpError(503, 'The console bridge is unavailable.');
          if (!connection || input?.revision !== revision) throw new HttpError(409, 'Save or refresh the iDRAC connection first.');
          const { port, encrypted } = input;
          const fingerprint = typeof input.fingerprint === 'string' ? input.fingerprint.replace(/[:\s]/g, '').toUpperCase() : '';
          if (!Number.isInteger(port) || port < 1024 || port > 65_535 || typeof encrypted !== 'boolean') {
            throw new HttpError(400, 'Enter the iDRAC VNC port and transport.');
          }
          if (fingerprint && (!encrypted || !/^[A-F0-9]{64}$/.test(fingerprint))) {
            throw new HttpError(400, 'Enter a SHA-256 server certificate fingerprint for TLS.');
          }
          const ticket = issueConsoleTicket({ host: connection.host, revision, port, encrypted, fingerprint });
          if (!ticket) throw new HttpError(409, 'A Rackview console session is already open.');
          return json(response, 200, { ticket });
        }
      }
      return json(response, 404, { error: 'Page not found.' });
    } catch (error) {
      if (error instanceof HttpError) return json(response, error.status, { error: error.message });
      console.error('Rackview request failed:', error.code ?? error.name);
      return json(response, 500, { error: 'Rackview could not complete the request. Check the container logs.' });
    }
  });
  const issueConsoleTicket = ws ? installConsole(server, ws, () => revision) : null;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.DATA_DIR || './data';
  const server = await createDashboard({
    dataDir,
    ...await dashboardCredentials(dataDir),
    ws: createRequire(import.meta.url)('/usr/share/nodejs/ws/index.js'),
  });
  server.listen(8080, () => console.log('Rackview listening on port 8080'));
}
