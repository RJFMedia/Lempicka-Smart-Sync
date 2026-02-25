#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
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

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractReleaseNotesFromChangelog(changelogText, version) {
  const lines = changelogText.split(/\r?\n/);
  const escapedVersion = escapeForRegex(version);
  const headingPattern = new RegExp(`^##\\s+(?:\\[)?v?${escapedVersion}(?:\\])?(?:\\s+-\\s+.*)?$`, 'i');

  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingPattern.test(lines[i].trim())) {
      startIndex = i + 1;
      break;
    }
  }

  if (startIndex < 0) {
    return null;
  }

  let endIndex = lines.length;
  for (let i = startIndex; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      endIndex = i;
      break;
    }
  }

  const notes = lines.slice(startIndex, endIndex).join('\n').trim();
  return notes.length > 0 ? notes : null;
}

function githubRequest({ method, pathName, token, body }) {
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: pathName,
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'lempicka-smart-sync-publisher',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode || 0;
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch (_err) {
              parsed = null;
            }
          }

          if (statusCode >= 200 && statusCode < 300) {
            resolve({ statusCode, data: parsed });
            return;
          }

          resolve({ statusCode, data: parsed, raw: data });
        });
      }
    );

    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

async function updateGitHubReleaseNotes({ token, owner, repo, version, notes }) {
  const tagCandidates = [`v${version}`, version];
  let release = null;

  for (const tag of tagCandidates) {
    const response = await githubRequest({
      method: 'GET',
      pathName: `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      token,
    });

    if (response.statusCode === 200 && response.data) {
      release = response.data;
      break;
    }

    if (response.statusCode !== 404) {
      const message = response.data && response.data.message ? response.data.message : response.raw || 'Unknown error';
      throw new Error(`Failed to fetch release by tag '${tag}': ${message}`);
    }
  }

  if (!release) {
    throw new Error(`Could not find GitHub release for tags v${version} or ${version}.`);
  }

  const patchResponse = await githubRequest({
    method: 'PATCH',
    pathName: `/repos/${owner}/${repo}/releases/${release.id}`,
    token,
    body: {
      body: notes,
    },
  });

  if (patchResponse.statusCode < 200 || patchResponse.statusCode >= 300) {
    const message = patchResponse.data && patchResponse.data.message ? patchResponse.data.message : patchResponse.raw || 'Unknown error';
    throw new Error(`Failed to update release notes: ${message}`);
  }
}

async function main() {
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

  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!version) {
    fail('package.json version is missing.');
  }

  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  let releaseNotes = null;
  if (fs.existsSync(changelogPath)) {
    releaseNotes = extractReleaseNotesFromChangelog(fs.readFileSync(changelogPath, 'utf8'), version);
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
  if (releaseNotes) {
    console.log(`Release notes source: CHANGELOG.md section for ${version}`);
  } else {
    console.warn(`No CHANGELOG.md section found for ${version}. GitHub release notes will not be overwritten.`);
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

  if (releaseNotes) {
    try {
      await updateGitHubReleaseNotes({
        token: String(token),
        owner: String(owner),
        repo: String(repo),
        version,
        notes: releaseNotes,
      });
      console.log(`Updated GitHub release notes from CHANGELOG.md for version ${version}.`);
    } catch (error) {
      fail(`Publish succeeded but updating GitHub release notes failed: ${error.message}`);
    }
  }
}

main().catch((error) => {
  fail(error && error.message ? error.message : String(error));
});
