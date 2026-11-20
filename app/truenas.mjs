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

export function readNas(config, WebSocket) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/current', config.url);
    url.protocol = 'wss:';
    const socket = new WebSocket(url, { rejectUnauthorized: !config.fingerprint, followRedirects: false, maxPayload: 4 * 1024 * 1024 });
    let verifiedPin;
    let id = 0;
    let pools;
    function fail(message) {
      clearTimeout(timer);
      reject(new Error(message));
      socket.terminate();
    }
    const timer = setTimeout(() => fail('TrueNAS timed out. Check its HTTPS address and port.'), 15000);
    function call(method, params = []) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
    }
    socket.once('upgrade', response => { verifiedPin = response.socket.getPeerCertificate()?.fingerprint256?.replaceAll(':', ''); });
    socket.once('open', () => {
      if (config.fingerprint && config.fingerprint !== verifiedPin) return fail('The TrueNAS certificate fingerprint does not match.');
      call('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username: config.user, api_key: config.key, login_options: { user_info: true } }]);
    });
    socket.on('message', raw => {
      try {
        const response = JSON.parse(raw);
        if (response.id !== id) return;
        if (response.error) return fail(['', 'TrueNAS rejected the login request.', 'TrueNAS denied the pool query.', 'TrueNAS denied the alert query.'][id]);
        const result = response.result;
        if (id === 1) {
          if (result?.response_type !== 'SUCCESS') return fail('TrueNAS rejected the account or API key.');
          const privilege = result.user_info?.privilege;
          // TrueNAS encodes a Python set as {"$set": [...]} in extended JSON.
          const returned = privilege?.roles;
          const roles = Array.isArray(returned) ? returned : returned?.$set;
          if (!Array.isArray(roles) || !roles.length || typeof privilege.web_shell !== 'boolean' ||
              !roles.every(role => typeof role === 'string' && /^[A-Z][A-Z0-9_]*$/.test(role))) {
            return fail('Login succeeded, but Rackview could not verify the permissions returned by TrueNAS.');
          }
          const extra = roles.filter(role => role !== 'READONLY_ADMIN' && !role.endsWith('_READ'));
          if (extra.length) {
            return fail(`Login succeeded, but TrueNAS granted roles beyond read-only access: ${extra.slice(0, 4).join(', ')}. Check the account’s group privileges.`);
          }
          if (privilege.web_shell) {
            return fail('Login succeeded, but TrueNAS reports web shell access in the account’s effective privileges. Check the privileges assigned to its groups.');
          }
          call('pool.query', [[], { select: ['name', 'status', 'healthy', 'allocated', 'free', 'scan'] }]);
        } else if (id === 2) {
          pools = result.map(p => ({ name: p.name, status: p.status, healthy: p.healthy, allocated: p.allocated, free: p.free,
            scan: p.scan?.function ? { type: p.scan.function, state: p.scan.state, percent: p.scan.percentage } : null }));
          call('alert.list');
        } else {
          const alerts = result.filter(a => !a.dismissed).map(a => ({ level: a.level, message: a.formatted || a.text || a.klass }));
          clearTimeout(timer);
          resolve({ pools, alerts, updatedAt: new Date().toISOString() });
          socket.close();
        }
      } catch { fail('TrueNAS returned an unexpected response. Check API compatibility.'); }
    });
    socket.on('error', () => fail('Could not establish a verified TLS connection to TrueNAS. Check the HTTPS port, certificate, and network.'));
    socket.once('close', () => { clearTimeout(timer); reject(new Error('TrueNAS closed the API connection.')); });
  });
}
