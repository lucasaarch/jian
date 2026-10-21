import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLaunchAgentPlist,
  buildMacosAppInfoPlist,
  macosAppBundlePaths,
} from '../bin/jian-remote.mjs';

test('macosAppBundlePaths put Jian Remote.app under Application Support', () => {
  const paths = macosAppBundlePaths('/Users/lucas');
  assert.equal(
    paths.appRoot,
    '/Users/lucas/Library/Application Support/Jian Remote/Jian Remote.app',
  );
  assert.equal(paths.executable, `${paths.appRoot}/Contents/MacOS/Jian Remote`);
  assert.equal(paths.infoPlist, `${paths.appRoot}/Contents/Info.plist`);
  assert.equal(paths.bundleId, 'com.jian.remote');
});

test('Info.plist names the product Jian Remote with com.jian.remote', () => {
  const xml = buildMacosAppInfoPlist();
  assert.match(xml, /<key>CFBundleName<\/key>\s*<string>Jian Remote<\/string>/);
  assert.match(xml, /<key>CFBundleDisplayName<\/key>\s*<string>Jian Remote<\/string>/);
  assert.match(xml, /<key>CFBundleIdentifier<\/key>\s*<string>com.jian.remote<\/string>/);
  assert.match(xml, /<key>CFBundleExecutable<\/key>\s*<string>Jian Remote<\/string>/);
});

test('LaunchAgent points at the app binary and associates the bundle id', () => {
  const xml = buildLaunchAgentPlist({
    label: 'com.jian.remote',
    executable:
      '/Users/lucas/Library/Application Support/Jian Remote/Jian Remote.app/Contents/MacOS/Jian Remote',
    script: '/Users/lucas/.config/jian-remote/jian-remote.mjs',
    logPath: '/Users/lucas/.config/jian-remote/worker.log',
    home: '/Users/lucas',
    tmpDir: '/tmp',
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.jian\.remote<\/string>/);
  assert.match(
    xml,
    /<string>\/Users\/lucas\/Library\/Application Support\/Jian Remote\/Jian Remote\.app\/Contents\/MacOS\/Jian Remote<\/string>/,
  );
  assert.match(xml, /<string>\/Users\/lucas\/\.config\/jian-remote\/jian-remote\.mjs<\/string>/);
  assert.match(xml, /<string>run<\/string>/);
  assert.doesNotMatch(xml, /\/usr\/local\/bin\/node/);
  assert.match(xml, /<key>AssociatedBundleIdentifiers<\/key>/);
  assert.match(xml, /<string>com\.jian\.remote<\/string>/);
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
  assert.match(
    xml,
    /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin/,
  );
  assert.match(xml, /<key>HOME<\/key>\s*<string>\/Users\/lucas<\/string>/);
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/lucas<\/string>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
});
