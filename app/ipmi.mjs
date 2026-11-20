import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const MANUAL = ['raw', '0x30', '0x30', '0x01', '0x00'];
export const AUTOMATIC = ['raw', '0x30', '0x30', '0x01', '0x01'];

export function speedCommand(percent) {
  return ['raw', '0x30', '0x30', '0x02', '0xff', `0x${percent.toString(16).padStart(2, '0')}`];
}

export async function ipmi(connection, args) {
  const { host, user, password } = connection;
  try {
    const { stdout } = await exec('ipmitool', [
      '-I', 'lanplus', '-H', host, '-U', user, '-E', '-N', '2', '-R', '2', ...args,
    ], {
      env: { PATH: process.env.PATH, LC_ALL: 'C', IPMI_PASSWORD: password },
      timeout: args.includes('sensor') ? 30_000 : 10_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('ipmitool is unavailable.');
    if (error.killed) throw new Error('The IPMI command timed out.');
    const detail = error.stderr?.replaceAll(password, '[redacted]').trim().slice(0, 500);
    throw new Error(detail || 'The IPMI command failed.');
  }
}

export function parseSensors(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    const [name, raw, unit, status] = line.split(',').map((field) => field.trim());
    if (!name || !raw || !unit || !status) return [];
    const reading = /^(?:na|ns|disabled)$/i.test(raw) ? null : raw;
    const value = reading !== null && /^-?\d+(?:\.\d+)?$/.test(reading) ? Number(reading) : null;
    const kind = /\bRPM\b/i.test(unit) || /^fan\s*\d/i.test(name) ? 'fan'
      : /degrees [CFK]/i.test(unit) ? 'temperature' : 'other';
    return [{ name, reading, value, unit, status: reading === null ? 'na' : status, kind }];
  });
}

export function parseController(output) {
  const details = {};
  for (const line of output.split(/\r?\n/)) {
    const pair = /^([^:]+?)\s*:\s*(.+)$/.exec(line);
    if (pair) details[pair[1].trim()] = pair[2].trim();
  }
  if (!details['Firmware Revision'] || !details['IPMI Version']) {
    throw new Error('The controller returned incomplete identification data.');
  }
  return details;
}
