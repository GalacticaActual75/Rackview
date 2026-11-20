import { setupConsole } from './console.js';

const $ = (id) => document.getElementById(id);
let state;
let formRevision;
let polling;
let timer;
let pending = false;
let connectionPending = false;
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function display(id, message, kind = '') {
  const field = $(id);
  field.textContent = message;
  field.hidden = !message;
  field.classList.toggle('error', kind === 'error');
  field.classList.toggle('success', kind === 'success');
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrf ?? '' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

const consoleView = setupConsole({ $, request, display, getStatus: () => state });

function navigate() {
  const requested = location.hash.slice(1);
  const defaultPage = state && !state.connection ? 'connection' : 'overview';
  const page = ['overview', 'sensors', 'connection', 'console'].includes(requested) ? requested : defaultPage;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== page;
  for (const link of document.querySelectorAll('nav [data-page]')) {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (page !== 'console') consoleView.disconnect();
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
    reading.textContent = sensor.reading === null ? '—' : `${numeric ? number.format(sensor.value) : sensor.reading}${unit}`;
    const status = document.createElement('span');
    const code = sensor.status.toLowerCase();
    status.className = `sensor-status ${code === 'ok' ? 'good' : ['na', 'ns'].includes(code) ? '' : 'alert'}`;
    status.textContent = { ok: 'OK', na: 'Unavailable', ns: 'No status', nc: 'Non-critical', cr: 'Critical', nr: 'Non-recoverable', lnc: 'Low warning', unc: 'High warning', lcr: 'Low critical', ucr: 'High critical', lnr: 'Low non-recoverable', unr: 'High non-recoverable' }[code] ?? sensor.status;
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

function renderSensors() {
  const rows = state?.sensors ?? [];
  const kind = $('sensor-kind').value;
  const query = $('sensor-search').value.trim().toLowerCase();
  const showUnavailable = $('show-unavailable').checked;
  const filtered = rows.filter((sensor) => (showUnavailable || sensor.reading !== null)
    && (kind === 'all' || sensor.kind === kind) && sensor.name.toLowerCase().includes(query));
  $('sensor-count').textContent = `${filtered.length} of ${rows.length} sensors`;
  renderRows($('sensors-body'), filtered, rows.length ? 'No matching sensors.' : 'No sensor readings yet.');
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
  $('mode-summary').textContent = command ? `Sent at ${new Date(command.at).toLocaleTimeString()}` : 'No confirmed Rackview command';
  renderRows($('fans-body'), fans, 'No fan readings yet.');
  renderRows($('temps-body'), temps, 'No temperature readings yet.');
  renderSensors();
}

function updateControls() {
  const blocked = pending || !state?.connection;
  for (const id of ['set-manual', 'set-auto', 'speed-range', 'speed-number']) $(id).disabled = blocked;
  for (const id of ['test-connection', 'save-connection', 'host', 'user', 'password']) $(id).disabled = connectionPending || !state;
  consoleView.update();
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
  $('target-address').textContent = state.connection?.host ?? 'Setup required';
  $('connection-title').textContent = state.connection ? 'Connection' : 'Connect your iDRAC';
  $('connection-intro').textContent = state.connection ? 'Manage the iDRAC credentials Rackview uses.' : 'Enter your iDRAC login to start monitoring the server.';
  display('app-error', state.sensorError ? `Sensor update failed. ${state.sensorError}` : '', 'error');
}

function resetConnectionForm() {
  $('host').value = state.connection?.host ?? '';
  $('user').value = state.connection?.user ?? '';
  $('password').value = '';
  $('password-hint').textContent = state.connection ? 'Leave blank to reuse the password for this IP and username.' : 'Enter the password for this iDRAC account.';
  formRevision = state.revision;
}

function refresh() {
  if (polling) return polling;
  clearTimeout(timer);
  $('refresh').disabled = true;
  polling = (async () => {
    try {
      const firstLoad = !state;
      state = await request('/api/status');
      if (firstLoad) {
        resetConnectionForm();
        if (state.lastCommand?.mode === 'manual') $('speed-range').value = $('speed-number').value = state.lastCommand.percent;
        navigate();
      }
      renderStatus();
      renderTelemetry();
      updateControls();
    } catch (error) {
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
    state.lastCommand = data.lastCommand;
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
  const input = { host: $('host').value, user: $('user').value, password: $('password').value, revision: formRevision };
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
      if (firstConnection && state.connection) location.hash = 'overview';
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
$('speed-range').addEventListener('input', () => { $('speed-number').value = $('speed-range').value; });
$('speed-number').addEventListener('input', () => { if ($('speed-number').validity.valid) $('speed-range').value = $('speed-number').value; });
$('fan-form').addEventListener('submit', (event) => { event.preventDefault(); changeFanMode('manual'); });
$('set-auto').addEventListener('click', () => changeFanMode('auto'));
$('connection-form').addEventListener('submit', (event) => { event.preventDefault(); configureConnection(false); });
$('test-connection').addEventListener('click', () => configureConnection(true));
$('connection-form').addEventListener('input', () => {
  $('test-details').hidden = true;
  display('connection-result', '');
});
navigate();
renderTelemetry();
updateControls();
refresh();
