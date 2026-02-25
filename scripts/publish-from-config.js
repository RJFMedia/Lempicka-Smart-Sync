#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const rootDir = path.resolve(__dirname, '..');
const configArg = process.argv[2] || process.env.PUBLISH_CONFIG;
const configPath = configArg
  ? path.resolve(configArg)
  : path.join(rootDir, 'config', 'publish.local.yml');

function fail(message) {
  console.error(message);
  process.exit(1);
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

const github = parsed && typeof parsed === 'object' ? (parsed.github || {}) : {};

const token = process.env.GH_TOKEN || github.token;
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

const env = {
  ...process.env,
  GH_TOKEN: String(token),
  GH_OWNER: String(owner),
  GH_REPO: String(repo),
};

console.log(`Publishing updates to GitHub Releases: ${owner}/${repo}`);
console.log(`Using config: ${path.relative(rootDir, configPath)}`);

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
