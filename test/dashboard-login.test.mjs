import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDashboard } from '../app/server.mjs';

test('form login protects data, signs out and remembers completed setup across restarts', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rackview-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, user: 'example', password: 'test-only' };
  async function start() {
    const server = await createDashboard(config);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const base = await start();
  const post = (route, data, headers = {}) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  const status = (token, host = base) => fetch(host + '/api/status', { headers: { Authorization: 'Bearer ' + token } });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="login-form"/);
  const unauthorized = await status('invalid');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), null);
  assert.equal((await post('/api/login', { user: config.user, password: 'incorrect' })).status, 401);
  const login = await post('/api/login', { user: config.user, password: config.password });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const initial = await (await status(token)).json();
  assert.equal(initial.setupRequired, true);
  const headers = { Authorization: 'Bearer ' + token };
  assert.equal((await post('/api/setup/complete', {}, headers)).status, 403);
  headers['X-CSRF-Token'] = initial.csrf;
  assert.equal((await post('/api/setup/complete', {}, headers)).status, 200);
  assert.equal((await (await status(token)).json()).setupRequired, false);
  assert.equal((await post('/api/logout', {}, headers)).status, 200);
  assert.equal((await status(token)).status, 401);
  const restarted = await start();
  const response = await fetch(restarted + '/api/status', {
    headers: { Authorization: 'Basic ' + Buffer.from(config.user + ':' + config.password).toString('base64') },
  });
  assert.equal((await response.json()).setupRequired, false);
});
