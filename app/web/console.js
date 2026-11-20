export function setupConsole({ $, request, display, getStatus }) {
  let viewer;
  let connecting = false;
  let connected = false;
  let attempt = 0;
  let failure = '';
  let consoleRevision;
  let videoStatus = '';
  let videoTimer;
  let profiles = [];
  let formRevision;

  function selectedProfile() {
    return profiles.find(p => p.id === $('vnc-profiles').value);
  }

  function endpoint() {
    return {
      port: $('vnc-port').valueAsNumber,
      encrypted: $('vnc-tls').checked,
      fingerprint: $('vnc-tls').checked ? $('vnc-fingerprint').value.replace(/[:\s]/g, '').toUpperCase() : '',
    };
  }

  function matchesSavedPassword() {
    const p = selectedProfile();
    const current = endpoint();
    return p?.hasPassword && p.port === current.port && p.encrypted === current.encrypted && p.fingerprint === current.fingerprint;
  }

  function updateFields() {
    $('fingerprint-label').hidden = !$('vnc-tls').checked;
    $('vnc-password').required = !matchesSavedPassword();
    $('vnc-password').placeholder = $('vnc-password').required ? '' : 'Use saved password';
  }

  function loadProfile() {
    const p = selectedProfile();
    $('vnc-port').value = p?.port ?? 5901;
    $('vnc-tls').checked = p?.encrypted ?? true;
    $('vnc-fingerprint').value = p?.fingerprint ?? '';
    $('vnc-password').value = '';
    $('vnc-remember').checked = !!p?.hasPassword;
    $('forget-console').hidden = !p;
    updateFields();
  }

  function showProfiles(list, preferred) {
    profiles = list;
    const select = $('vnc-profiles');
    select.replaceChildren(new Option('New connection', ''));
    for (const p of profiles) {
      const pin = p.fingerprint ? ` · ${p.fingerprint.slice(0, 12)}…` : '';
      select.add(new Option(`${getStatus().connection.host} · ${p.port} · ${p.encrypted ? 'TLS' : 'Plain VNC'}${pin}`, p.id));
    }
    select.value = preferred ?? profiles[0]?.id ?? '';
    loadProfile();
  }

  function update() {
    const state = getStatus();
    if ((viewer || connecting) && state?.revision !== consoleRevision) disconnect();
    if (state && state.revision !== formRevision) {
      formRevision = state.revision;
      showProfiles(state.consoleProfiles ?? []);
    }
    $('start-console').disabled = connecting || !state?.connection || !state.consoleAvailable;
    $('console-form').hidden = !!viewer;
    $('console-screen').hidden = !viewer;
    $('console-actions').hidden = !viewer;
    $('fullscreen-console').disabled = !connected;
    $('console-cad').disabled = !connected;
    const status = connected ? videoStatus : connecting ? 'Connecting…'
      : !state?.connection ? 'Save an iDRAC connection first' : !state.consoleAvailable ? 'Console bridge unavailable' : 'Disconnected';
    if ($('console-status').textContent !== status) $('console-status').textContent = status;
  }

  function waitForVideo(session) {
    const canvas = $('console-screen').querySelector('canvas');
    const sample = document.createElement('canvas');
    sample.width = sample.height = 16;
    const context = sample.getContext('2d', { willReadFrequently: true });
    const waitingSince = performance.now();
    videoStatus = 'VNC connected. Waiting for video…';
    update();

    function checkFrame() {
      if (viewer !== session) return;
      if (canvas?.width && canvas.height && context) {
        context.clearRect(0, 0, 16, 16);
        context.drawImage(canvas, 0, 0, 16, 16);
        // A black desktop still has opaque pixels. An untouched framebuffer is transparent.
        const pixels = context.getImageData(0, 0, 16, 16).data;
        if (pixels.some((value, index) => index % 4 === 3 && value > 0)) {
          videoStatus = 'Connected';
          update();
          return;
        }
      }
      const slow = performance.now() - waitingSince >= 8000;
      if (slow) {
        videoStatus = 'VNC connected. No video received yet.';
        update();
      }
      videoTimer = setTimeout(checkFrame, slow ? 2000 : 400);
    }

    videoTimer = setTimeout(checkFrame, 400);
  }

  function disconnect() {
    if (!viewer && !connecting) return;
    attempt++;
    const session = viewer;
    viewer = null;
    session?.disconnect();
    connected = false;
    connecting = false;
    clearTimeout(videoTimer);
    $('console-screen').replaceChildren();
    update();
  }

  $('console-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (connecting || viewer) return;
    const currentAttempt = ++attempt;
    const enteredPassword = $('vnc-password').value;
    const remember = $('vnc-remember').checked;
    consoleRevision = getStatus().revision;
    const settings = { ...endpoint(), revision: consoleRevision };
    const profileId = selectedProfile()?.id;
    failure = '';
    connecting = true;
    update();
    display('console-result', '');
    try {
      const { default: RFB } = await import('/novnc/core/rfb.js');
      if (attempt !== currentAttempt) return;
      const data = await request('/api/console/ticket', {
        ...settings, profileId, useSaved: !enteredPassword && !!profileId,
      });
      if (attempt !== currentAttempt) return;
      const url = new URL(`/api/console/ws?ticket=${data.ticket}`, location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const screen = $('console-screen');
      screen.hidden = false;
      const password = enteredPassword || data.password;
      const session = new RFB(screen, url.href, { credentials: { password } });
      viewer = session;
      $('vnc-password').value = '';
      session.scaleViewport = true;
      session.background = '#090b0e';
      session.addEventListener('connect', async () => {
        if (viewer !== session) return;
        connecting = false;
        connected = true;
        waitForVideo(session);
        try {
          const saved = await request('/api/console/profiles/save', { ...settings, password: remember ? password : undefined });
          if (formRevision === settings.revision && (attempt === currentAttempt || (!connecting && !viewer))) {
            showProfiles(saved.profiles, saved.id);
          }
        } catch (error) {
          if (formRevision === settings.revision) display('console-result', `Could not save this connection. ${error.message}`, 'error');
        }
      }, { once: true });
      session.addEventListener('securityfailure', (event) => {
        failure = event.detail.reason || 'The iDRAC rejected VNC authentication.';
      });
      session.addEventListener('credentialsrequired', () => {
        failure = 'The iDRAC requested a different VNC authentication method.';
        session.disconnect();
      });
      session.addEventListener('disconnect', (event) => {
        if (viewer !== session) return;
        viewer = null;
        const wasConnected = connected;
        connecting = false;
        connected = false;
        clearTimeout(videoTimer);
        $('console-screen').replaceChildren();
        update();
        if (failure || !event.detail.clean) {
          display('console-result', failure || (wasConnected ? 'The VNC session ended unexpectedly.' : 'Could not establish VNC. Check the port, TLS settings, fingerprint, and whether another viewer is connected.'), 'error');
        }
      });
      update();
    } catch (error) {
      if (attempt !== currentAttempt) return;
      disconnect();
      display('console-result', error.message, 'error');
    }
  });
  $('vnc-profiles').addEventListener('change', loadProfile);
  for (const id of ['vnc-port', 'vnc-tls', 'vnc-fingerprint']) $(id).addEventListener('input', updateFields);
  $('forget-console').addEventListener('click', async () => {
    const p = selectedProfile();
    if (!p) return;
    const revision = formRevision;
    try {
      const result = await request('/api/console/profiles/forget', { ...p, profileId: p.id, revision });
      if (revision === formRevision) {
        showProfiles(result.profiles);
        display('console-result', 'Saved connection removed.', 'success');
      }
    } catch (error) {
      display('console-result', error.message, 'error');
    }
  });
  $('disconnect-console').addEventListener('click', disconnect);
  $('fullscreen-console').addEventListener('click', async () => {
    try {
      await $('console-screen').requestFullscreen();
      viewer?.focus();
    } catch {
      display('console-result', 'Full screen is unavailable in this browser.', 'error');
    }
  });
  $('console-cad').addEventListener('click', () => viewer?.sendCtrlAltDel());
  $('vnc-help').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('vnc-help').open = false;
      $('vnc-help').querySelector('summary').focus();
    }
  });
  return { update, disconnect };
}
