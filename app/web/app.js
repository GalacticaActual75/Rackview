import { setupConsole } from './console.js';
import { setupNas } from './truenas.js';
import { setupApps } from './apps.js';
import { setupGuide } from './setup.js';

const $ = (id) => document.getElementById(id);
let state;
let formRevision;
let polling;
let timer;
let pending = false;
let dutyPending = false;
let dutyResult;
let editingDuty = false;
let discoveredKey;
let connectionPending = false;
let session = sessionStorage.getItem('rackview.session');
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function display(id, message, kind = '') {
  const field = $(id);
  field.textContent = message;
  field.hidden = !message;
  field.classList.toggle('error', kind === 'error');
  field.classList.toggle('success', kind === 'success');
}

async function request(path, body) {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = state?.csrf ?? '';
  }
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit', headers, body: JSON.stringify(body),
  });
  if (response.status === 401 && path !== '/api/login') {
    sessionStorage.removeItem('rackview.session');
    location.reload();
    throw new Error('Sign in again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

const consoleView = setupConsole({ $, request, display, getStatus: () => state });
const nasView = setupNas({ $, request, display, refresh });
const appsView = setupApps({ $, request });
const guide = setupGuide({ $, request, display, getState: () => state, disconnect: () => consoleView.disconnect() });

function updateFingerprintHelp(isNas) {
  const command = $(isNas ? 'nas-pin-command' : 'vnc-pin-command');
  let host = state?.connection?.host;
  let port = $('vnc-port').valueAsNumber;
  if (isNas) {
    const url = URL.parse($('nas-url').value);
    host = url?.protocol === 'https:' && !url.username && !url.password ? url.hostname : '';
    port = Number(url?.port || 443);
  }
  if (host?.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  // Only insert a hostname/IP and numeric port into the copyable shell command.
  if (!host || !/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    command.textContent = isNas ? 'Enter the TrueNAS HTTPS URL above to show the command.' : 'Save an iDRAC address and enter a valid VNC port to show the command.';
    return;
  }
  command.textContent = `openssl s_client -connect ${host}:${port} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`;
}

for (const [id, isNas] of [['nas-pin-help', true], ['vnc-fingerprint-help', false]]) {
  $(id).addEventListener('beforetoggle', event => {
    if (event.newState === 'open') updateFingerprintHelp(isNas);
  });
}

function navigate() {
  const requested = location.hash.slice(1);
  const page = ['overview', 'sensors', 'apps', 'connection', 'console', 'setup'].includes(requested) ? requested : 'overview';
  if (page === 'setup') guide.render();
  else guide.restore();
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== page;
  for (const link of document.querySelectorAll('nav [data-page]')) {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (page === 'console') consoleView.open();
  else consoleView.disconnect();
  if (page === 'overview' && !dutyResult) void checkDuty();
  if (page === 'connection' && state && formRevision !== state.revision && !connectionPending) resetConnectionForm();
}

function sensorUnit(unit) {
  return unit.replace(/^degrees ([CFK])$/i, '°$1');
}

function renderRows(body, rows, empty) {
  const fragment = document.createDocumentFragment();
  for (const sensor of rows) {
    const row = document.createElement('tr');
    row.insertCell().textContent = sensor.name;
    const reading = row.insertCell();
    reading.className = 'reading';
    const numeric = sensor.value !== null;
    const unit = numeric ? ` ${sensorUnit(sensor.unit)}` : '';
    reading.textContent = sensor.reading === null ? '—' : numeric
      ? [number.format(sensor.value) + unit, sensor.state].filter(Boolean).join(', ') : sensor.reading;
    const status = document.createElement('span');
    const code = sensor.status.toLowerCase();
    status.className = `sensor-status ${code === 'ok' ? 'good' : /^(?:[lu]?(?:nc|cr|nr))$/.test(code) ? 'alert' : ''}`;
    status.textContent = { ok: 'OK', reported: 'Reported', na: 'Unavailable', ns: 'No status', nc: 'Non-critical', cr: 'Critical', nr: 'Non-recoverable', lnc: 'Low warning', unc: 'High warning', lcr: 'Low critical', ucr: 'High critical', lnr: 'Low non-recoverable', unr: 'High non-recoverable' }[code] ?? sensor.status;
    row.insertCell().append(status);
    fragment.append(row);
  }
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.className = 'empty';
    cell.textContent = empty;
    fragment.append(row);
  }
  body.replaceChildren(fragment);
}

// Match the reading's function first. For generic labels like "Presence", use
// the hardware entity from the IPMI sensor record (decimal entity IDs).
const sensorSections = [
  { label: 'Cooling & fans', name: /\bfans?\b|\bfan\d/i, unit: /^RPM$/i, entities: [29, 30] },
  { label: 'Temperatures', name: /temp(?:erature)?\b|thermal/i, unit: /^degrees [CFK]$/i },
  { label: 'Utilization', name: /usage|utilization/i },
  { label: 'Voltage rails', name: /\bPG\b|power good|\bVCORE\b/i },
  { label: 'Storage & backplanes', name: /drive|disk|backplane|\bBP\d|\bSAS\b|RAID|vFlash/i, entities: [4, 15, 26, 50, 51] },
  { label: 'Cables & network', name: /cable|\bNIC\b|ethernet|network/i, entities: [31, 42] },
  { label: 'Power supplies & electrical', name: /power|\bpwr\b|\bPSU?\d*\b|voltage|current|battery/i, unit: /^(volts?|amps?|watts?)$/i, entities: [10, 14, 19, 20, 21, 40] },
  { label: 'Processors & memory', name: /\bCPU|processor|\bDIMM|memory/i, entities: [3, 8, 9, 18, 32, 43, 65] },
  { label: 'Expansion cards & slots', name: /PCIe?|riser|add-in card/i, entities: [11, 16, 48, 49] },
  { label: 'System & chassis' },
];
const systemSection = sensorSections.at(-1);

for (const section of sensorSections) {
  const { label } = section;
  const details = $('sensor-section').content.firstElementChild.cloneNode(true);
  details.querySelector('strong').textContent = label;
  details.querySelector('table').setAttribute('aria-label', label);
  details.open = section === sensorSections[0] || section === sensorSections[1];
  $('sensor-sections').append(details);
  section.details = details;
  $('sensor-kind').add(new Option(label, label));
}

function renderSensors(event) {
  const rows = state?.sensors ?? [];
  const kind = $('sensor-kind').value;
  const query = $('sensor-search').value.trim().toLowerCase();
  const showUnavailable = $('show-unavailable').checked;
  const groups = new Map(sensorSections.map(section => [section, []]));
  let visible = 0;
  for (const sensor of rows) {
    if (!showUnavailable && sensor.reading === null) continue;
    const entity = Number(sensor.entity?.split('.')[0]);
    const section = sensorSections.find(s => s.unit?.test(sensor.unit) || s.name?.test(sensor.name))
      ?? sensorSections.find(s => s.entities?.includes(entity)) ?? systemSection;
    if (kind !== 'all' && kind !== section.label) continue;
    if (!sensor.name.toLowerCase().includes(query) && !section.label.toLowerCase().includes(query)) continue;
    groups.get(section).push(sensor);
    visible++;
  }
  for (const [section, matches] of groups) {
    const { details } = section;
    details.hidden = !matches.length;
    if (!matches.length) continue;
    if (event && (kind !== 'all' || query)) details.open = true;
    details.querySelector('summary span').textContent = `${matches.length} ${matches.length === 1 ? 'sensor' : 'sensors'}`;
    renderRows(details.querySelector('tbody'), matches);
  }
  $('sensor-count').textContent = `${visible} of ${rows.length} sensors`;
  $('sensors-empty').hidden = visible > 0;
  $('sensors-empty').textContent = rows.length ? 'No matching sensors.' : 'No sensor readings yet.';
}

function renderTelemetry() {
  const rows = (state?.sensors ?? []).filter((sensor) => sensor.reading !== null);
  const fans = rows.filter((sensor) => sensor.kind === 'fan');
  const temps = rows.filter((sensor) => sensor.kind === 'temperature');
  const measured = fans.filter((sensor) => sensor.value !== null && sensor.unit.toLowerCase() === 'rpm');
  const celsius = (sensor) => {
    if (sensor.unit.endsWith('F')) return (sensor.value - 32) * 5 / 9;
    if (sensor.unit.endsWith('K')) return sensor.value - 273.15;
    return sensor.value;
  };
  const hottest = temps.filter((sensor) => sensor.value !== null).sort((a, b) => celsius(b) - celsius(a))[0];
  const avg = measured.reduce((total, sensor) => total + sensor.value, 0) / measured.length;
  $('average-rpm').textContent = measured.length ? number.format(Math.round(avg)) : '—';
  $('fan-summary').textContent = measured.length ? `${measured.length} ${measured.length === 1 ? 'fan' : 'fans'} reporting RPM` : 'No RPM readings';
  $('peak-temp').textContent = hottest ? number.format(hottest.value) : '—';
  $('peak-unit').textContent = hottest ? sensorUnit(hottest.unit) : '°C';
  $('temp-summary').textContent = hottest?.name ?? 'No temperature readings';
  const command = state?.lastCommand;
  $('last-mode').textContent = command?.mode === 'manual' ? `Manual · ${command.percent}%` : command?.mode === 'auto' ? 'Automatic' : 'Unknown';
  $('mode-summary').textContent = command ? `Accepted ${new Date(command.at).toLocaleString()}` : 'No saved Rackview command';
  renderRows($('fans-body'), fans, 'No fan readings yet.');
  renderRows($('temps-body'), temps, 'No temperature readings yet.');
  renderSensors();
}

function updateControls() {
  const blocked = pending || dutyPending || !state?.connection;
  for (const id of ['set-manual', 'set-auto', 'speed-range', 'speed-number']) $(id).disabled = blocked;
  $('set-manual').disabled = blocked || !$('speed-number').validity.valid;
  $('speed-range').dataset.empty = String(!$('speed-number').validity.valid);
  $('check-duty').disabled = blocked;
  $('check-duty').hidden = !state?.connection?.sshHostKey;
  $('fan-duty-setup').hidden = !state?.connection || !!state.connection.sshHostKey;
  for (const id of ['test-connection', 'save-connection', 'host', 'user', 'password']) $(id).disabled = connectionPending || !state;
  consoleView.update();
}

function renderDuty() {
  const readings = dutyResult?.fans ?? [];
  const values = readings.map(fan => fan.percent);
  const lo = Math.min(...values), hi = Math.max(...values);
  $('fan-duty-reading').textContent = dutyPending ? 'Checking…' : values.length ? (lo === hi ? lo + '%' : lo + '–' + hi + '%') : 'Unknown';
  let detail = state?.connection?.sshHostKey ? 'Check the PWM reported by iDRAC.' : 'SSH readback is optional. IPMI supplies fan RPM.';
  if (dutyResult?.error) detail = dutyResult.error;
  else if (dutyResult) {
    const when = new Date(dutyResult.at).toLocaleString();
    detail = readings.length ? `Checked ${when} · ${readings.map(f => f.name + ' ' + f.percent + '%').join(', ')}`
      : `Checked ${when} · iDRAC returned no usable fan PWM readings.`;
    if (readings.length && state.lastCommand?.mode === 'manual') {
      detail += values.every(value => value === state.lastCommand.percent) ? ' · Reported duty matches the saved target.' : ' · Reported duty differs from the saved target.';
    }
  }
  $('fan-duty-detail').textContent = dutyPending ? '' : detail;
}

async function checkDuty() {
  if (dutyPending || pending || !state?.connection?.sshHostKey) return;
  const revision = state.revision;
  const commandAt = state.lastCommand?.at;
  dutyPending = true;
  updateControls();
  renderDuty();
  try {
    const result = await request('/api/fans/readback', { revision });
    if (state.revision === revision && state.lastCommand?.at === commandAt) dutyResult = result;
  } catch (error) {
    if (state.revision === revision) dutyResult = { error: error.message };
  } finally {
    dutyPending = false;
    renderDuty();
    updateControls();
  }
}

function renderStatus() {
  let label = 'Setup required';
  let status = 'waiting';
  if (state.sensorError) {
    label = state.updatedAt ? `Stale since ${new Date(state.updatedAt).toLocaleTimeString()}` : 'IPMI unavailable';
    status = 'offline';
  } else if (state.updatedAt) {
    label = `Updated ${new Date(state.updatedAt).toLocaleTimeString()}`;
    status = 'online';
  } else if (state.connection) label = 'Waiting for iDRAC';
  $('status-dot').dataset.state = status;
  $('connection-dot').dataset.state = status;
  $('status-text').textContent = label;
  const host = state.connection?.host;
  $('target-address').textContent = host ?? 'Setup required';
  const idracLink = $('open-idrac');
  idracLink.hidden = !host;
  if (host) idracLink.href = `https://${host.includes(':') ? `[${host}]` : host}/`;
  else idracLink.removeAttribute('href');
  const nasLink = $('open-truenas');
  const nasUrl = state.nas?.url;
  nasLink.hidden = !nasUrl;
  if (nasUrl) nasLink.href = nasUrl;
  else nasLink.removeAttribute('href');
  $('connection-title').textContent = state.connection ? 'Connection' : 'Connect your iDRAC';
  $('connection-intro').textContent = 'Manage the iDRAC and TrueNAS connections Rackview uses.';
  display('app-error', state.sensorError ? `Sensor update failed. ${state.sensorError}` : '', 'error');
}

function resetConnectionForm() {
  $('host').value = state.connection?.host ?? '';
  $('user').value = state.connection?.user ?? '';
  $('password').value = '';
  $('idrac-ssh-key').value = state.connection?.sshHostKey ?? '';
  clearDiscoveredKey();
  $('password-hint').textContent = state.connection ? 'Leave blank to reuse the password for this IP and username.' : 'Enter the password for this iDRAC account.';
  formRevision = state.revision;
}

function clearDiscoveredKey() {
  discoveredKey = undefined;
  $('trust-ssh-key').hidden = true;
  display('ssh-key-result', '');
}

$('find-ssh-key').addEventListener('click', async () => {
  clearDiscoveredKey();
  const revision = state?.revision;
  if (!state?.connection || $('host').value !== state.connection.host) return display('ssh-key-result', 'Save the iDRAC address first.');
  $('find-ssh-key').disabled = true;
  display('ssh-key-result', 'Reading SSH host key…');
  try {
    const key = await request('/api/connection/ssh-host-key', { revision });
    if (state.revision !== revision || $('host').value !== state.connection.host) return;
    discoveredKey = { ...key, revision };
    display('ssh-key-result', key.fingerprint + ' · Compare this fingerprint with a trusted SSH client or your administrator before using this key.');
    $('trust-ssh-key').hidden = false;
  } catch (error) { display('ssh-key-result', error.message, 'error'); }
  finally { $('find-ssh-key').disabled = false; }
});
$('trust-ssh-key').addEventListener('click', async () => {
  if (!discoveredKey || discoveredKey.revision !== state?.revision || $('host').value !== state?.connection?.host) return;
  $('trust-ssh-key').disabled = true;
  try {
    await request('/api/connection/ssh-host-key/save', { revision: discoveredKey.revision, publicKey: discoveredKey.publicKey });
    if (polling) await polling;
    await refresh();
    $('idrac-ssh-key').value = state.connection?.sshHostKey ?? '';
    formRevision = state.revision;
    clearDiscoveredKey();
    display('ssh-key-result', 'Host key saved. Open Overview to see the reported fan duty.');
  } catch (error) { display('ssh-key-result', error.message, 'error'); }
  finally { $('trust-ssh-key').disabled = false; }
});

function refresh() {
  if (polling) return polling;
  clearTimeout(timer);
  $('refresh').disabled = true;
  polling = (async () => {
    try {
      const firstLoad = !state;
      const before = state;
      state = await request('/api/status');
      if (before?.revision !== state.revision || before?.lastCommand?.at !== state.lastCommand?.at) {
        dutyResult = undefined;
        if (before?.revision !== state.revision) editingDuty = false;
        if (!editingDuty) {
          const percent = state.lastCommand?.mode === 'manual' ? state.lastCommand.percent : '';
          $('speed-number').value = percent;
          $('speed-range').value = percent === '' ? 50 : percent;
        }
      }
      if (firstLoad) {
        resetConnectionForm();
        if (state.setupRequired && (!location.hash || location.hash === '#overview')) history.replaceState(null, '', '#setup');
        navigate();
      }
      renderStatus();
      nasView.update(state);
      appsView.update(state);
      renderTelemetry();
      renderDuty();
      updateControls();
      if (!$('overview').hidden && !dutyResult) void checkDuty();
    } catch (error) {
      if (!state) {
        $('target-address').textContent = 'Connection unavailable';
        $('nas-status').textContent = 'Connection unavailable';
      }
      $('status-dot').dataset.state = $('connection-dot').dataset.state = 'offline';
      $('status-text').textContent = 'Dashboard unreachable';
      display('app-error', `Could not refresh Rackview. ${error.message}`, 'error');
    } finally {
      $('refresh').disabled = false;
      timer = setTimeout(refresh, (state?.pollMs ?? 10_000) + 250);
      polling = null;
    }
  })();
  return polling;
}

async function changeFanMode(mode) {
  if (pending) return;
  pending = true;
  updateControls();
  display('command-result', 'Sending command…');
  try {
    const data = await request('/api/fans', { mode, percent: $('speed-number').valueAsNumber, revision: state.revision });
    editingDuty = false;
    dutyResult = undefined;
    state.lastCommand = data.lastCommand;
    if (mode === 'auto') {
      $('speed-number').value = '';
      $('speed-range').value = 50;
    }
    renderDuty();
    renderTelemetry();
    display('command-result', mode === 'manual' ? `Manual speed set to ${data.lastCommand.percent}%.` : 'iDRAC automatic control restored.', 'success');
  } catch (error) {
    display('command-result', error.message, 'error');
  } finally {
    if (polling) await polling;
    await refresh();
    pending = false;
    updateControls();
  }
}

async function configureConnection(test) {
  if (connectionPending || !$('connection-form').reportValidity()) return;
  connectionPending = true;
  const input = { host: $('host').value, user: $('user').value, password: $('password').value, sshHostKey: $('idrac-ssh-key').value, revision: formRevision };
  $('test-details').hidden = true;
  updateControls();
  display('connection-result', test ? 'Testing IPMI credentials…' : 'Saving connection…');
  try {
    const firstConnection = !state.connection;
    const data = await request(test ? '/api/connection/test' : '/api/connection', input);
    if (test) {
      const pairs = ['Firmware Revision', 'IPMI Version', 'Manufacturer Name', 'Product Name'];
      $('test-details').replaceChildren(...pairs.filter((key) => data.details[key]).map((key) => {
        const item = document.createElement('div');
        const term = document.createElement('dt');
        const description = document.createElement('dd');
        term.textContent = key;
        description.textContent = data.details[key];
        item.append(term, description);
        return item;
      }));
      $('test-details').hidden = false;
      display('connection-result', 'Connection succeeded.', 'success');
    } else {
      $('password').value = '';
      display('connection-result', 'Connection saved.', 'success');
      if (polling) await polling;
      await refresh();
      resetConnectionForm();
      if (firstConnection && state.connection && location.hash !== '#setup') location.hash = 'overview';
    }
  } catch (error) {
    display('connection-result', error.message, 'error');
  } finally {
    connectionPending = false;
    updateControls();
  }
}

$('refresh').addEventListener('click', refresh);
window.addEventListener('hashchange', navigate);
$('sensor-search').addEventListener('input', renderSensors);
$('sensor-kind').addEventListener('change', renderSensors);
$('show-unavailable').addEventListener('change', renderSensors);
$('host').addEventListener('input', () => { clearDiscoveredKey(); if ($('host').value !== state?.connection?.host) $('idrac-ssh-key').value = ''; });
$('fan-duty-setup').addEventListener('click', () => { $('fan-ssh-settings').open = true; });
$('check-duty').addEventListener('click', checkDuty);
$('speed-range').addEventListener('input', () => { editingDuty = true; $('speed-number').value = $('speed-range').value; updateControls(); });
$('speed-number').addEventListener('input', () => { editingDuty = true; if ($('speed-number').validity.valid) $('speed-range').value = $('speed-number').value; updateControls(); });
$('fan-form').addEventListener('submit', (event) => { event.preventDefault(); changeFanMode('manual'); });
$('set-auto').addEventListener('click', () => changeFanMode('auto'));
$('connection-form').addEventListener('submit', (event) => { event.preventDefault(); configureConnection(false); });
$('test-connection').addEventListener('click', () => configureConnection(true));
$('connection-form').addEventListener('input', () => {
  $('test-details').hidden = true;
  display('connection-result', '');
});
function openDashboard() {
  $('sign-in').hidden = true;
  $('dashboard').hidden = false;
  navigate();
  renderTelemetry();
  updateControls();
  refresh();
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-submit').disabled = true;
  display('login-error', '');
  try {
    const data = await request('/api/login', { user: $('login-user').value, password: $('login-password').value });
    sessionStorage.setItem('rackview.session', data.token);
    session = data.token;
    $('login-form').reset();
    openDashboard();
  } catch (error) { display('login-error', error.message, 'error'); }
  finally { $('login-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try {
    await request('/api/logout', {});
    sessionStorage.removeItem('rackview.session');
    location.reload();
  } catch (error) { display('app-error', error.message, 'error'); }
});
if (session) openDashboard();
else { $('sign-in').hidden = false; $('login-user').focus(); }
