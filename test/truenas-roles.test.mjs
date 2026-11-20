import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { readNas } from '../app/truenas.mjs';

// Exercise the JSON on the wire, before a TrueNAS client decodes extended types.
function loginWith(privilege, calls, reporting = true) {
  class TestSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    send(data) {
      const { method, id, params } = JSON.parse(data);
      calls.push(method);
      const results = {
        'auth.login_ex': { response_type: 'SUCCESS', user_info: { privilege } },
        'pool.query': [], 'alert.list': [], 'system.info': { model: 'Test CPU', uptime_seconds: 123 },
        'core.subscribe': 'subscription-id',
      };
      const emit = message => this.emit('message', JSON.stringify({ jsonrpc: '2.0', ...message }));
      queueMicrotask(() => {
        if (method === 'core.subscribe' && !reporting) return emit({ id, error: { code: -32001 } });
        emit({ id, result: results[method] });
        if (method === 'core.subscribe') {
          assert.deepEqual(params, ['reporting.realtime']);
          emit({ method: 'collection_update', params: { collection: 'reporting.realtime', event: 'ADDED', fields: {
            cpu: { cpu: { usage: 0 } }, disks: { read_bytes: 1234, write_bytes: 0 },
            memory: { arc_size: 456, physical_memory_total: 4096, physical_memory_available: 1000 },
            interfaces: { eth0: { received_bytes_rate: 123, sent_bytes_rate: 0, link_state: 'LINK_STATE_UP' } },
          } } });
        }
      });
    }
    close() { this.emit('close'); }
    terminate() { this.close(); }
  }
  return readNas({ url: 'https://nas.invalid' }, TestSocket);
}

test('read-only roles in either wire format can read pools and alerts', async () => {
  const names = ['READONLY_ADMIN', 'POOL_READ', 'ALERT_LIST_READ'];
  for (const roles of [names, { $set: names }]) {
    const calls = [];
    const data = await loginWith({ roles, web_shell: false }, calls);
    assert.deepEqual(calls, ['auth.login_ex', 'pool.query', 'alert.list', 'system.info', 'core.subscribe']);
    assert.deepEqual(data.pools, []);
    assert.equal(data.system.uptime, 123);
    assert.equal(data.sample.cpu, 0);
    assert.equal(data.sample.ramAvailable, 1000);
    assert.equal(data.sample.diskRead, 1234);
    assert.equal(data.sample.interfaces[0].received, 123);
  }
});

test('a rejected telemetry subscription preserves storage, alerts and system information', async () => {
  const result = await loginWith({ roles: ['POOL_READ', 'ALERT_LIST_READ'], web_shell: false }, [], false);
  assert.deepEqual(result.pools, []);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.system.model, 'Test CPU');
  assert.equal(result.sample, null);
});

test('ineligible or unrecognized privileges stop before the first data query', async () => {
  for (const [privilege, message] of [
    [{ roles: { $set: ['READONLY_ADMIN', 'POOL_WRITE'] }, web_shell: false }, /POOL_WRITE/],
    [{ roles: ['FULL_ADMIN'], web_shell: false }, /FULL_ADMIN/],
    [{ roles: { $set: ['READONLY_ADMIN'] }, web_shell: true }, /web shell access/],
    [{ roles: { $set: [] }, web_shell: false }, /could not verify/],
    [{ roles: { $set: 'READONLY_ADMIN' }, web_shell: false }, /could not verify/],
    [{ roles: ['READONLY_ADMIN'] }, /could not verify/],
    [null, /could not verify/],
  ]) {
    const calls = [];
    await assert.rejects(loginWith(privilege, calls), message);
    assert.deepEqual(calls, ['auth.login_ex']);
  }
});
