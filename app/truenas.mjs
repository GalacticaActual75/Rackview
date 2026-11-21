// TrueNAS 25.10 JSON-RPC over TLS WebSocket. Only the methods below are sent.
export function nasConnection(input, saved) {
  let url;
  try { url = new URL(input.url); } catch { throw new Error('Enter the HTTPS address of the TrueNAS web interface.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter the HTTPS origin of TrueNAS, including its HTTPS port if needed.');
  }
  const user = String(input.user ?? '').trim();
  if (!user) throw new Error('Enter the TrueNAS account that owns the key.');
  const fingerprint = String(input.fingerprint ?? '').replace(/[:\s]/g, '').toUpperCase();
  if (fingerprint && !/^[A-F0-9]{64}$/.test(fingerprint)) throw new Error('Enter a verified SHA-256 certificate fingerprint.');
  const same = saved?.url === url.origin && saved.user === user && saved.fingerprint === fingerprint;
  const key = input.key || (same && saved.key);
  if (typeof key !== 'string' || !key.trim()) throw new Error('Enter the API key for this server, account, and certificate.');
  return { url: url.origin, user, fingerprint, key: key.trim() };
}

function checkLogin(login) {
  if (login?.response_type !== 'SUCCESS') throw new Error('TrueNAS rejected the account or API key.');
  const privilege = login.user_info?.privilege;
  const returned = privilege?.roles;
  const roles = Array.isArray(returned) ? returned : returned?.$set;
  if (!Array.isArray(roles) || !roles.length || typeof privilege.web_shell !== 'boolean' ||
      !roles.every(role => typeof role === 'string' && /^[A-Z][A-Z0-9_]*$/.test(role))) {
    throw new Error('Login succeeded, but Rackview could not verify the permissions returned by TrueNAS.');
  }
  const extra = roles.filter(role => role !== 'READONLY_ADMIN' && !role.endsWith('_READ'));
  if (extra.length) throw new Error(`Login succeeded, but TrueNAS granted roles beyond read-only access: ${extra.slice(0, 4).join(', ')}. Check the account’s group privileges.`);
  if (privilege.web_shell) throw new Error('Login succeeded, but TrueNAS reports web shell access in the account’s effective privileges. Check the privileges assigned to its groups.');
}

// Each reader makes sequential RPC calls and optionally waits for a single event.
async function withNas(config, WebSocket, read) {
  const url = new URL('/api/current', config.url);
  url.protocol = 'wss:';
  const socket = new WebSocket(url, { rejectUnauthorized: !config.fingerprint, followRedirects: false, maxPayload: 4 * 1024 * 1024 });
  let id = 0;
  let pending;
  let failure;
  let verifiedPin;
  function fail(message) {
    failure = new Error(message);
    pending?.reject(failure);
  }
  socket.on('error', () => fail('Could not establish a verified TLS connection to TrueNAS. Check the HTTPS port, certificate, and network.'));
  socket.once('close', () => fail('TrueNAS closed the API connection.'));
  socket.once('upgrade', response => { verifiedPin = response.socket.getPeerCertificate()?.fingerprint256?.replaceAll(':', ''); });
  socket.on('message', raw => {
    if (!pending) return;
    try {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        if (msg.error) pending.reject(new Error(pending.errorMessage));
        else if (!pending.event) pending.resolve(msg.result);
      } else if (pending.event && msg.params?.collection === pending.event) {
        if (msg.method === 'notify_unsubscribed') pending.reject(new Error(pending.errorMessage));
        if (msg.method === 'collection_update' && (msg.params.msg === 'added' || msg.params.event === 'ADDED')) pending.resolve(msg.params.fields);
      }
    } catch { fail('TrueNAS returned an unexpected response. Check API compatibility.'); }
  });
  function call(method, params, errorMessage) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, errorMessage, event: method === 'core.subscribe' ? params[0] : null };
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
    });
  }
  const timer = setTimeout(() => {
    fail('TrueNAS timed out. Check its HTTPS address and port.');
    socket.terminate();
  }, 15000);
  try {
    await new Promise((resolve, reject) => { pending = { reject }; socket.once('open', resolve); });
    if (config.fingerprint && config.fingerprint !== verifiedPin) throw new Error('The TrueNAS certificate fingerprint does not match.');
    checkLogin(await call('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username: config.user, api_key: config.key, login_options: { user_info: true } }], 'TrueNAS rejected the login request.'));
    return await read(call);
  } finally {
    clearTimeout(timer);
    pending = null;
    socket.close();
  }
}

export function readNas(config, WebSocket) {
  return withNas(config, WebSocket, async call => {
    const rows = await call('pool.query', [[], { select: ['name', 'status', 'healthy', 'allocated', 'free', 'scan'] }], 'TrueNAS denied the pool query.');
    const pools = rows.map(p => ({ name: p.name, status: p.status, healthy: p.healthy, allocated: p.allocated, free: p.free,
      scan: p.scan?.function ? { type: p.scan.function, state: p.scan.state, percent: p.scan.percentage } : null }));
    const messages = await call('alert.list', [], 'TrueNAS denied the alert query.');
    const alerts = messages.filter(a => !a.dismissed).map(a => ({ level: a.level, message: a.formatted || a.text || a.klass }));
    const info = await call('system.info', [], 'System information unavailable.').catch(() => null);
    const system = info ? { model: info.model, uptime: info.uptime_seconds, version: info.version } : {};
    const fields = await call('core.subscribe', ['reporting.realtime'], 'Reporting unavailable.').catch(() => null);
    const sample = fields ? { cpu: fields.cpu?.cpu?.usage, ramTotal: fields.memory?.physical_memory_total,
      ramAvailable: fields.memory?.physical_memory_available, arc: fields.memory?.arc_size,
      diskRead: fields.disks?.read_bytes, diskWrite: fields.disks?.write_bytes,
      interfaces: Object.entries(fields.interfaces ?? {}).map(([name, nic]) =>
        ({ name, received: nic.received_bytes_rate, sent: nic.sent_bytes_rate, state: nic.link_state })) } : null;
    return { pools, alerts, system, sample, updatedAt: new Date().toISOString() };
  });
}

export function readApps(config, WebSocket) {
  return withNas(config, WebSocket, async call => {
    const select = ['id', 'name', 'state', 'human_version', 'upgrade_available', 'image_updates_available'];
    const inventory = await call('app.query', [[], { select }], 'TrueNAS could not list apps. Check that Apps is configured and the account has Apps read access.');
    const fields = inventory.length ? await call('core.subscribe', ['app.stats'], 'App usage unavailable.').catch(() => null) : [];
    const usage = new Map((Array.isArray(fields) ? fields : []).map(app => [app.app_name, app]));
    const apps = inventory.map(app => {
      const stats = usage.get(app.id) ?? usage.get(app.name);
      return { name: app.name || app.id, state: app.state, version: app.human_version,
        update: app.upgrade_available || app.image_updates_available,
        cpu: stats?.cpu_usage ?? null, memory: stats?.memory ?? null };
    });
    return { apps, usageAvailable: Array.isArray(fields), updatedAt: new Date().toISOString() };
  });
}
