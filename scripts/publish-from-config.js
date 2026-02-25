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
const cscName = process.env.CSC_NAME || signing.cscName;

const env = {
  ...process.env,
  GH_TOKEN: String(token),
  GH_OWNER: String(owner),
  GH_REPO: String(repo),
};

if (hasKeychainMethod) {
  env.APPLE_KEYCHAIN_PROFILE = String(keychainProfile);
  if (keychain) {
    env.APPLE_KEYCHAIN = String(keychain);
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

if (cscName) {
  env.CSC_NAME = String(cscName);
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
