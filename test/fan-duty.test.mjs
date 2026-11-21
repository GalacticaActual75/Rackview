import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFanDuty } from '../app/fan-duty.mjs';
import { AUTOMATIC } from '../app/ipmi.mjs';
import { createDashboard } from '../app/server.mjs';

test('readback uses only valid percentages from the fan PWM column', () => {
  const output = [
    'Sensor Type : FAN', '<Sensor Name> | <Status> | <Reading> | <lc> | <uc> | <PWM %>',
    'System Board Fan1 RPM  Ok  14160RPM  360RPM  NA  80%',
    'System Board Fan2 RPM | Ok | 9600 RPM | 600 RPM | NA | 55%',
    'System Board Fan3 RPM  Ok  0 RPM  600 RPM  NA  0%',
    'System Board Fan4 RPM  Ok  5000 RPM  600 RPM  NA  144%',
    'System Board Fan5 RPM  Ok  5600 RPM  600 RPM  NA  NA',
    'Sensor Type : POWER', 'Other Ok 14000 RPM 600 RPM NA 90%',
  ].join('\n');
  assert.deepEqual(parseFanDuty(output).map(f => [f.name, f.percent]), [
    ['System Board Fan1 RPM', 80], ['System Board Fan2 RPM', 55], ['System Board Fan3 RPM', 0],
  ]);
  assert.deepEqual(parseFanDuty('Fan1 RPM Ok 14160 RPM 100 RPM NA 80%'), []);
});

test('fan history survives restarts, handles failures and belongs to the configured controller', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rackview-fans-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { host: '192.0.2.1', user: 'example', password: 'test-only' };
  await writeFile(join(dataDir, 'connection.json'), JSON.stringify(config));
  const writes = [];
  let failManual = false, failAuto = false;
  const run = async (_, args) => {
    if (args[0] === 'sdr') return 'Fan1 | 30h | ok | 7.1 | 14160 RPM';
    writes.push(args);
    if (args === AUTOMATIC ? failAuto : failManual) throw new Error('simulated rejection');
  };
  const headers = { Authorization: 'Basic ' + Buffer.from('example:test-only').toString('base64'), 'Content-Type': 'application/json' };
  let server, base, snapshot;
  const close = () => new Promise(resolve => server.close(resolve));
  t.after(async () => { if (server?.listening) await close(); });
  const status = async () => { snapshot = await (await fetch(base + '/api/status', { headers })).json(); return snapshot; };
  async function restart() {
    if (server?.listening) await close();
    const count = writes.length;
    const readDuty = async connection => {
      assert.equal(connection.password, config.password);
      return [{ name: 'Fan1', percent: 80 }];
    };
    server = await createDashboard({ dataDir, user: 'example', password: 'test-only', run, readDuty });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    await status();
    assert.equal(writes.length, count);
  }
  const post = (path, values) => fetch(base + path, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': snapshot.csrf },
    body: JSON.stringify({ revision: snapshot.revision, ...values }) });
  await restart();
  assert.equal(snapshot.lastCommand, null);
  assert.equal((await post('/api/fans/readback', {})).status, 409);
  assert.equal((await post('/api/fans', { mode: 'manual', percent: 80 })).status, 200);
  const accepted = (await status()).lastCommand;
  await restart();
  assert.equal(accepted.percent, 80);
  assert.deepEqual(snapshot.lastCommand, accepted);
  assert.equal((await post('/api/connection', config)).status, 200);
  await restart();
  assert.deepEqual(snapshot.lastCommand, accepted);
  const publicKey = 'ssh-ed25519 ' + Buffer.alloc(32, 1).toString('base64');
  assert.equal((await post('/api/connection/ssh-host-key/save', { publicKey })).status, 200);
  await restart();
  assert.deepEqual(snapshot.lastCommand, accepted);
  const duty = await post('/api/fans/readback', {});
  assert.equal(duty.status, 200);
  assert.equal((await duty.json()).fans[0].percent, 80);
  failManual = true;
  assert.equal((await post('/api/fans', { mode: 'manual', percent: 75 })).status, 502);
  await restart();
  assert.equal(snapshot.lastCommand.mode, 'auto');
  failAuto = true;
  assert.equal((await post('/api/fans', { mode: 'auto' })).status, 502);
  await restart();
  assert.equal(snapshot.lastCommand, null);
  failManual = false;
  assert.equal((await post('/api/fans', { mode: 'manual', percent: 0 })).status, 200);
  await restart();
  assert.equal(snapshot.lastCommand.percent, 0);
  assert.equal((await post('/api/connection', { ...config, host: '192.0.2.2' })).status, 200);
  await restart();
  assert.equal(snapshot.lastCommand, null);
});
