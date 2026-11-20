import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { readNas } from '../app/truenas.mjs';

// Exercise the JSON on the wire, before a TrueNAS client decodes extended types.
function loginWith(privilege, calls) {
  class TestSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    send(data) {
      const { method, id } = JSON.parse(data);
      calls.push(method);
      const result = method === 'auth.login_ex' ? { response_type: 'SUCCESS', user_info: { privilege } } : [];
      queueMicrotask(() => this.emit('message', JSON.stringify({ jsonrpc: '2.0', id, result })));
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
    assert.deepEqual(calls, ['auth.login_ex', 'pool.query', 'alert.list']);
    assert.deepEqual(data.pools, []);
  }
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
