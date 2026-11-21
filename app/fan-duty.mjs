import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function findFanHostKey(host) {
  let output;
  try {
    ({ stdout: output } = await exec('ssh-keyscan', ['-T', '5', '-t', 'ed25519,ecdsa,rsa', host],
      { timeout: 8000, maxBuffer: 65536 }));
  } catch { throw new Error('No SSH key returned. In iDRAC, enable SSH under Network → Services and check port 22.'); }
  const keys = output.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
  for (const type of ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']) {
    const key = keys.find(([ip, algo, data]) => ip === host && algo === type && /^[A-Za-z0-9+/]+={0,2}$/.test(data));
    if (key) {
      const fingerprint = createHash('sha256').update(Buffer.from(key[2], 'base64')).digest('base64').replace(/=+$/, '');
      return { publicKey: type + ' ' + key[2], fingerprint: 'SHA256:' + fingerprint };
    }
  }
  throw new Error('iDRAC returned no supported SSH host key.');
}

export function parseFanDuty(output) {
  const fans = [];
  let inFans = false;
  let hasPwm = false;
  for (const line of output.split(/\r?\n/)) {
    const section = /^\s*Sensor Type\s*:\s*(.+?)\s*$/i.exec(line);
    if (section) {
      inFans = section[1].toUpperCase() === 'FAN';
      hasPwm = false;
      continue;
    }
    if (!inFans) continue;
    if (/PWM\s*%/i.test(line)) {
      hasPwm = true;
      continue;
    }
    if (!hasPwm) continue;
    const row = line.replaceAll('|', ' ').trim().match(/^(.+?)\s+(OK)\s+\d+\s+RPM\s+.+?\s+(\d+(?:\.\d+)?)\s*%\s*$/i);
    if (row && Number(row[3]) <= 100) fans.push({ name: row[1].trim(), percent: Number(row[3]) });
  }
  return fans;
}

export async function readFanDuty({ host, user, password, sshHostKey }, dataDir) {
  const knownHosts = resolve(dataDir, '.fan-host-' + randomUUID());
  await writeFile(knownHosts, host + ' ' + sshHostKey + '\n', { mode: 0o600, flag: 'wx' });
  try {
    const { stdout } = await exec('sshpass', ['-e', 'ssh', '-F', '/dev/null',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'UserKnownHostsFile=' + knownHosts, '-o', 'UpdateHostKeys=no',
      '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'ConnectTimeout=5', '-T', '-l', user, host, 'racadm getsensorinfo'],
    { env: { PATH: process.env.PATH, LC_ALL: 'C', SSHPASS: password }, timeout: 15000, maxBuffer: 512 * 1024 });
    return parseFanDuty(stdout);
  } catch {
    throw new Error('Could not read fan duty over SSH. Check iDRAC SSH access on port 22, the saved host key and the account permissions.');
  } finally {
    await rm(knownHosts, { force: true });
  }
}
