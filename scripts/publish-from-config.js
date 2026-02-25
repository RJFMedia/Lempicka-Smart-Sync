#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const rootDir = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const configArg = args.find((arg) => !arg.startsWith('-')) || process.env.PUBLISH_CONFIG;
const configPath = configArg
  ? path.resolve(configArg)
  : path.join(rootDir, 'config', 'publish.local.yml');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function resolveMaybeFilePath(value) {
  if (!value || typeof value !== 'string') {
    return undefined;
  }

  if (value.startsWith('file://')) {
    return value;
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(rootDir, value);
}

function runNotarytool(argsList) {
  return spawnSync('xcrun', ['notarytool', ...argsList], {
    cwd: rootDir,
    encoding: 'utf8',
  });
}

function normalizeCscName(name) {
  if (!name) {
    return undefined;
  }

  return String(name).replace(/^\s*Developer ID Application:\s*/i, '').trim();
}

function listCodeSigningIdentities() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const identities = [];

  for (const line of output.split('\n')) {
    const match = line.match(/\)\s+[0-9A-F]{40}\s+"([^"]+)"/);
    if (match) {
      identities.push(match[1]);
    }
  }

  const developerIdApplication = identities.filter((name) => name.startsWith('Developer ID Application:'));

  return {
    identities,
    developerIdApplication,
    normalizedDeveloperIdApplication: developerIdApplication.map(normalizeCscName),
    output: output.trim(),
  };
}

function ensureSigningIdentityExists() {
  const discovered = listCodeSigningIdentities();

  if (discovered.developerIdApplication.length === 0) {
    const hint = [
      'No valid "Developer ID Application" signing certificate was found in Keychain.',
      'Install your Developer ID Application certificate, then re-run publish.',
      'Verify with: security find-identity -v -p codesigning',
      discovered.output ? `Current identities:\n${discovered.output}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    fail(hint);
  }
}

function validateConfiguredSigningIdentity(expectedName) {
  const normalizedExpected = normalizeCscName(expectedName);
  const discovered = listCodeSigningIdentities();

  if (discovered.normalizedDeveloperIdApplication.includes(normalizedExpected)) {
    return normalizedExpected;
  }

  const choices = discovered.normalizedDeveloperIdApplication.map((name) => `  - ${name}`).join('\n') || '  (none)';
  fail(
    `Configured signing identity was not found: ${normalizedExpected}\nAvailable Developer ID Application identities:\n${choices}\nRun: security find-identity -v -p codesigning`
  );
}

function validateKeychainProfile(profile, keychainPath) {
  const baseArgs = ['history', '--keychain-profile', profile];
  const withKeychainArgs = keychainPath ? [...baseArgs, '--keychain', keychainPath] : baseArgs;

  const primary = runNotarytool(withKeychainArgs);
  if (primary.status === 0) {
    return { useKeychain: Boolean(keychainPath) };
  }

  if (keychainPath) {
    const fallback = runNotarytool(baseArgs);
    if (fallback.status === 0) {
      console.warn(`Notary profile '${profile}' was found, but not in keychain '${keychainPath}'. Falling back to default keychain lookup.`);
      return { useKeychain: false };
    }
  }

  const stderr = String(primary.stderr || '').trim();
  const hint = [
    `Notary keychain profile '${profile}' could not be used.`,
    keychainPath ? `Checked keychain: ${keychainPath}` : undefined,
    stderr ? `notarytool output: ${stderr}` : undefined,
    `Create or update the profile with: xcrun notarytool store-credentials "${profile}" --apple-id "you@example.com" --team-id "TEAMID1234" --password "xxxx-xxxx-xxxx-xxxx"`,
  ]
    .filter(Boolean)
    .join('\n');

  fail(hint);
}

if (!fs.existsSync(configPath)) {
  fail(`Missing config file: ${configPath}\nCopy config/publish.local.example.yml to config/publish.local.yml and fill it in.`);
}

let parsed;
try {
  parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  fail(`Could not parse YAML config ${configPath}: ${error.message}`);
}

const config = parsed && typeof parsed === 'object' ? parsed : {};
const github = config.github || {};
const apple = config.apple || {};
const signing = config.signing || {};

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || github.token;
const owner = process.env.GH_OWNER || github.owner;
const repo = process.env.GH_REPO || github.repo;

if (!token) {
  fail('Missing GitHub token. Set github.token in YAML or GH_TOKEN in environment.');
}
if (!owner) {
  fail('Missing GitHub owner. Set github.owner in YAML or GH_OWNER in environment.');
}
if (!repo) {
  fail('Missing GitHub repo. Set github.repo in YAML or GH_REPO in environment.');
}

const appleId = process.env.APPLE_ID || apple.appleId;
const appSpecificPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || apple.appSpecificPassword;
const teamId = process.env.APPLE_TEAM_ID || apple.teamId;

const apiKey = process.env.APPLE_API_KEY || resolveMaybeFilePath(apple.apiKey);
const apiKeyId = process.env.APPLE_API_KEY_ID || apple.apiKeyId;
const apiIssuer = process.env.APPLE_API_ISSUER || apple.apiIssuer;

const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE || apple.keychainProfile;
const keychain = process.env.APPLE_KEYCHAIN || apple.keychain;

const hasAppleIdMethod = Boolean(appleId && appSpecificPassword && teamId);
const hasApiKeyMethod = Boolean(apiKey && apiKeyId && apiIssuer);
const hasKeychainMethod = Boolean(keychainProfile);

if (!hasAppleIdMethod && !hasApiKeyMethod && !hasKeychainMethod) {
  fail('Missing Apple notarization credentials. Configure one method in YAML (keychain profile, Apple ID/app password/team ID, or API key).\nSee config/publish.local.example.yml.');
}

if (hasApiKeyMethod && !fs.existsSync(String(apiKey).replace(/^file:\/\//, ''))) {
  fail(`Apple API key file not found: ${apiKey}`);
}

const cscLink = process.env.CSC_LINK || signing.cscLink;
const cscKeyPassword = process.env.CSC_KEY_PASSWORD || signing.cscKeyPassword;
const configuredCscName = process.env.CSC_NAME || signing.cscName;
const normalizedConfiguredCscName = configuredCscName ? validateConfiguredSigningIdentity(configuredCscName) : undefined;

if (!cscLink) {
  ensureSigningIdentityExists();
}

const env = {
  ...process.env,
  GH_TOKEN: String(token),
  GH_OWNER: String(owner),
  GH_REPO: String(repo),
};

if (hasKeychainMethod) {
  const profileCheck = validateKeychainProfile(String(keychainProfile), keychain ? String(keychain) : undefined);
  env.APPLE_KEYCHAIN_PROFILE = String(keychainProfile);
  if (profileCheck.useKeychain && keychain) {
    env.APPLE_KEYCHAIN = String(keychain);
  } else {
    delete env.APPLE_KEYCHAIN;
  }
}

if (hasAppleIdMethod) {
  env.APPLE_ID = String(appleId);
  env.APPLE_APP_SPECIFIC_PASSWORD = String(appSpecificPassword);
  env.APPLE_TEAM_ID = String(teamId);
}

if (hasApiKeyMethod) {
  env.APPLE_API_KEY = String(apiKey);
  env.APPLE_API_KEY_ID = String(apiKeyId);
  env.APPLE_API_ISSUER = String(apiIssuer);
}

if (normalizedConfiguredCscName) {
  env.CSC_NAME = String(normalizedConfiguredCscName);
}
if (cscLink) {
  env.CSC_LINK = String(cscLink);
}
if (cscKeyPassword) {
  env.CSC_KEY_PASSWORD = String(cscKeyPassword);
}

const notarizationMethod = hasKeychainMethod
  ? 'APPLE_KEYCHAIN_PROFILE'
  : hasApiKeyMethod
    ? 'APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER'
    : 'APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID';

console.log(`Publishing updates to GitHub Releases: ${owner}/${repo}`);
console.log(`Using config: ${path.relative(rootDir, configPath)}`);
console.log(`Notarization auth: ${notarizationMethod}`);
if (normalizedConfiguredCscName) {
  console.log(`Code signing identity: ${normalizedConfiguredCscName}`);
}

if (dryRun) {
  console.log('Dry run complete.');
  process.exit(0);
}

const result = spawnSync('npm', ['run', 'release:publish:github'], {
  cwd: rootDir,
  stdio: 'inherit',
  env,
});

if (result.error) {
  fail(`Failed to run release publish command: ${result.error.message}`);
}

if (typeof result.status === 'number' && result.status !== 0) {
  process.exit(result.status);
}
