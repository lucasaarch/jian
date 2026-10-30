import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSystem, linuxSystem, macosSystem, windowsSystem } from '../src/index.ts';

test('macOS reads as its marketing name and the version sw_vers prints', () => {
  assert.equal(macosSystem('27.2\n'), 'macOS 27.2');
  assert.equal(macosSystem('15.4.1'), 'macOS 15.4.1');
  assert.equal(macosSystem(''), null);
  assert.equal(macosSystem('sw_vers: command not found'), null);
});

test('Windows 11 is told from Windows 10 by its build, since both report 10.0', () => {
  assert.equal(windowsSystem('10.0.26100'), 'Windows 11 (26100)');
  assert.equal(windowsSystem('10.0.22000'), 'Windows 11 (22000)');
  assert.equal(windowsSystem('10.0.19045'), 'Windows 10 (19045)');
  assert.equal(windowsSystem('6.3.9600'), 'Windows 6.3.9600');
  assert.equal(windowsSystem(''), 'Windows');
});

test('Linux reads as its distribution, then its kernel when os-release says nothing', () => {
  const ubuntu = [
    'NAME="Ubuntu"',
    'VERSION_ID="24.04"',
    'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
    'ID=ubuntu',
  ].join('\n');
  assert.equal(linuxSystem(ubuntu, '6.8.0-45-generic'), 'Ubuntu 24.04.1 LTS');
  assert.equal(linuxSystem("NAME='Fedora Linux'\nVERSION_ID=41\n", '6.11.4'), 'Fedora Linux 41');
  assert.equal(linuxSystem('PRETTY_NAME="Debian \\"trixie\\""', '6.1.0'), 'Debian "trixie"');
  assert.equal(linuxSystem('ID=alpine', '6.6.1'), 'Linux 6.6.1');
  assert.equal(linuxSystem(undefined, '6.6.1'), 'Linux 6.6.1');
});

test('this computer reads as a short, printable description', async () => {
  const system = await detectSystem();
  assert.match(system, /^[\x20-\x7e]{1,100}$/);
});
