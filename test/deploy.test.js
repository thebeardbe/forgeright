/**
 * The deploy compose, the mail profile default, and the mock-provider warning.
 *
 * Several deploy claims are the kind that turn out to be false, so each is checked against the
 * artefact rather than taken on trust.
 *
 * `data/demo` IS NOT TOUCHED: it is the deployable artefact.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const COMPOSE = path.join(PROJECT_ROOT, 'docker-compose.deploy.yml');

const tempDirs = [];
after(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const composeText = () => fs.readFileSync(COMPOSE, 'utf8');

/** A free TCP port, released before a child claims it. */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/**
 * Starts the server with a chosen HOST and returns everything it printed before it was stopped.
 */
async function startAndCapture(host) {
    const port = await freePort();
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-deploy-test-'));
    tempDirs.push(storeDir);

    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server.js')], {
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            PORT: String(port),
            HOST: host,
            BASE_PATH: '',
            PUBLIC_BASE_URL: 'https://allowed.example.test',
            TRUST_PROXY: '127.0.0.1',
            ALLOWED_HOST: 'allowed.example.test',
            SESSION_SECRET: 'a'.repeat(64),
            STORE_DIR: storeDir,
            AI_PROVIDER: 'mock',
            MAIL_SENDER: 'console'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    await new Promise((r) => setTimeout(r, 1200));
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    return output;
}

// ===========================================================================
// 1. THE DEPLOY COMPOSE
// ===========================================================================
//
// Read as TEXT and validated with `docker compose config`, which parses offline: the file's shape
// is the claim.

test('docker compose can parse the deploy file', () => {
    // A file that does not parse is not a deploy.
    const out = execFileSync('docker', ['compose', '-f', COMPOSE, 'config', '--services'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.deepEqual(out.trim().split('\n'), ['forgeright'], 'exactly one service is defined');
});

test('the service is named forgeright with a fixed container_name and NO profiles', () => {
    const text = composeText();

    assert.match(text, /container_name:\s*forgeright/, 'container_name is pinned, so nginx can refer to it by name');
    // `profiles:` would mean the service only starts under a profile, which causes a
    // duplicated service name and a `forgeright-forgeright-1` container.
    assert.equal(/^\s*profiles:/m.test(text), false, 'no profiles: a plain `up` starts the one service');
});

test('nothing is published by default', () => {
    const text = composeText();
    // The only `ports:` in the file must be commented out, so the container is
    // reachable solely from proxy-network.
    const uncommentedPublish = text.split('\n').filter((line) => /^\s*ports:/.test(line));
    assert.deepEqual(uncommentedPublish, [], 'no uncommented ports: block');

    // And the commented example is loopback-only, if somebody uncomments it.
    assert.match(text, /#\s*ports:/, 'the publish example is present, commented');
    assert.match(text, /127\.0\.0\.1:3000:3000/, 'and binds to loopback rather than 0.0.0.0');
});

test('the store and the proton session are SEPARATE volumes', () => {
    const text = composeText();
    assert.match(text, /forgeright-store:\/data\/store/, 'the store is its own volume');
    assert.match(text, /forgeright-proton:\/home\/node\/\.config/, 'the proton session is its own volume');

    // Two distinct named volumes, declared at the top level.
    assert.match(text, /^volumes:\s*$/m, 'volumes are declared');
    assert.match(text, /^\s{2}forgeright-store:\s*$/m, 'forgeright-store is declared');
    assert.match(text, /^\s{2}forgeright-proton:\s*$/m, 'forgeright-proton is declared');
});

test('TRUST_PROXY is set explicitly, with a default of uniquelocal', () => {
    // The claim: without it every admin request returns 308 and no cookie is set.
    // The forcing is what this asserts; the effect is asserted separately below.
    const text = composeText();
    assert.match(text, /TRUST_PROXY:\s*"\$\{FORGERIGHT_TRUST_PROXY:-uniquelocal\}"/, 'TRUST_PROXY defaults to uniquelocal');

    // A DIFFERENT variable name from the one it sets, so `.env` cannot shadow the default.
    // Checked on the ASSIGNMENT only: the string also appears in a comment above it.
    const assignment = text.split('\n').find((line) => /^\s*TRUST_PROXY:/.test(line));
    assert.ok(assignment, 'there is an uncommented TRUST_PROXY assignment');
    assert.equal(/\$\{TRUST_PROXY:-/.test(assignment), false, 'the default must not read the variable it sets');
});

test('HOST is forced to 0.0.0.0, because `.env` overrides the image default', () => {
    // With the `.env` value winning, the app binds to the CONTAINER's loopback and nothing on
    // proxy-network can connect.
    const text = composeText();
    assert.match(text, /HOST:\s*"0\.0\.0\.0"/, 'the container binds all interfaces');
});

test('the external proxy network is used rather than created', () => {
    const text = composeText();
    assert.match(text, /proxy-network/, 'the shared network is referenced');
    assert.match(text, /external:\s*true/, 'and marked external, so compose fails clearly if it is missing');
});

test('THE TRUST PROXY BEHAVIOUR: without a trusted proxy, a forwarded HTTPS request is refused', async () => {
    // Without TRUST_PROXY the app 308s every admin request and never sets a cookie. Tested by
    // starting the SAME app twice, with and without the setting, and sending one genuinely
    // forwarded HTTPS request to each.

    /** Starts the server with or without TRUST_PROXY and probes /admin. */
    const probeAdmin = async (trustProxy) => {
        // A FRESH PORT AND STORE PER PROBE: a shared store would make the second server wait on
        // the first's file locks while it shuts down.
        const probePort = await freePort();
        const probeStore = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-trust-probe-'));
        tempDirs.push(probeStore);
        const env = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            PORT: String(probePort),
            HOST: '127.0.0.1',
            BASE_PATH: '',
            PUBLIC_BASE_URL: 'https://allowed.example.test',
            ALLOWED_HOST: 'allowed.example.test',
            SESSION_SECRET: 'a'.repeat(64),
            STORE_DIR: probeStore,
            AI_PROVIDER: 'mock',
            MAIL_SENDER: 'console'
        };
        // TRUST_PROXY is deliberately NOT set here; the spawn call adds it explicitly so
        // that the unset case cannot be filled in from `.env`.
        delete env.TRUST_PROXY;

        const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server.js')], {
            // `TRUST_PROXY` IS ALWAYS PASSED: the repo's `.env` sets it, so an ABSENT variable is
            // filled in by dotenv and the "without it" half would test the same thing twice. An
            // empty string keeps the key present, and `resolveTrustProxy` treats empty as unset.
            env: { ...env, TRUST_PROXY: trustProxy ?? '' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let childOutput = '';
        child.stdout.on('data', (chunk) => { childOutput += chunk; });
        child.stderr.on('data', (chunk) => { childOutput += chunk; });

        // Wait for liveness.
        const started = Date.now();
        for (;;) {
            try {
                const res = await new Promise((resolve, reject) => {
                    const r = http.get({ host: '127.0.0.1', port: probePort, path: '/healthz', headers: { host: 'allowed.example.test' } }, resolve);
                    r.on('error', reject);
                });
                res.resume();
                if (res.statusCode === 200) break;
            } catch {
                // not up yet
            }
            if (Date.now() - started > 8000) {
                child.kill('SIGKILL');
                throw new Error(`server did not start: ${childOutput.slice(0, 400)}`);
            }
            await new Promise((r) => setTimeout(r, 50));
        }

        const res = await new Promise((resolve, reject) => {
            const r = http.request({
                host: '127.0.0.1',
                port: probePort,
                path: '/admin',
                method: 'GET',
                headers: { host: 'allowed.example.test', 'x-forwarded-proto': 'https' }
            }, (response) => {
                let text = '';
                response.on('data', (c) => { text += c; });
                response.on('end', () => resolve({ status: response.statusCode, setCookie: response.headers['set-cookie'] || null, text }));
            });
            r.on('error', reject);
            r.end();
        });

        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        return res;
    };

    // WITH a trusted proxy: the forwarded header is believed and the page serves.
    const trusted = await probeAdmin('127.0.0.1');
    assert.equal(trusted.status, 200, 'with TRUST_PROXY set, the forwarded request serves the sign-in form');

    // WITHOUT it: the forwarded header is ignored, the request is insecure, and it is
    // refused with a redirect rather than served.
    const untrusted = await probeAdmin(undefined);
    assert.equal(untrusted.status, 308, 'without TRUST_PROXY the same request is refused with a 308');
    assert.equal(untrusted.setCookie, null, 'and no cookie is set');
});

// ===========================================================================
// 2. THE PROTON PROFILE DEFAULT
// ===========================================================================

test('the proton profile falls back to the default when MAIL_PROTON_PROFILE is unset, empty or whitespace', async () => {
    // The default must be the product default rather than a personal mailbox, and whitespace is
    // pinned beside the others.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-proton-bin-'));
    tempDirs.push(bin);
    const argvFile = path.join(bin, 'argv.json');
    const cli = path.join(bin, 'proton-cli');
    // A fake proton-cli that records the argv it was handed and succeeds.
    fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
  process.stdout.write('ok\\n');
});
`);
    fs.chmodSync(cli, 0o755);

    const previousPath = process.env.PATH;
    const previousProfile = process.env.MAIL_PROTON_PROFILE;
    process.env.PATH = `${bin}:${previousPath}`;

    try {
        const proton = await import('../lib/mail/proton.js');

        for (const [label, value] of [['unset', undefined], ['empty', ''], ['whitespace', '   '], ['tab', '\t']]) {
            if (value === undefined) delete process.env.MAIL_PROTON_PROFILE;
            else process.env.MAIL_PROTON_PROFILE = value;

            await proton.send({ to: 'a@example.test', subject: 's', body: 'b' });
            const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
            const used = argv[argv.indexOf('--profile') + 1];

            assert.equal(used, 'default', `MAIL_PROTON_PROFILE ${label} must fall back to the product default`);
            assert.notEqual(used, 'jobsearch', 'the personal mailbox must not be the fallback');
        }

        // And a configured value is honoured, so the fallback is a fallback rather than
        // an override of everything.
        process.env.MAIL_PROTON_PROFILE = 'an-operators-profile';
        await proton.send({ to: 'a@example.test', subject: 's', body: 'b' });
        const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
        assert.equal(argv[argv.indexOf('--profile') + 1], 'an-operators-profile');
    } finally {
        process.env.PATH = previousPath;
        if (previousProfile === undefined) delete process.env.MAIL_PROTON_PROFILE;
        else process.env.MAIL_PROTON_PROFILE = previousProfile;
    }
});

test('no source file uses the personal mailbox as a profile DEFAULT', () => {
    // Asserted on the CONSTANT rather than by grepping: the name legitimately appears in comments,
    // and reading the value is exact.
    const proton = fs.readFileSync(path.join(PROJECT_ROOT, 'lib', 'mail', 'proton.js'), 'utf8');
    const declaration = proton.match(/const DEFAULT_PROFILE = '([^']*)';/);

    assert.ok(declaration, 'the default profile is declared as a literal');
    assert.equal(declaration[1], 'default', 'the product default is proton-cli\'s own default');
    assert.notEqual(declaration[1], 'jobsearch', 'and not the machine-specific account');

    // The fallback actually used must be that same constant, not a second literal.
    const fallback = proton.match(/configured && configured\.trim\(\) !== '' \? configured\.trim\(\) : (\w+)/);
    assert.ok(fallback, 'the fallback expression is present');
    assert.equal(fallback[1], 'DEFAULT_PROFILE', 'and it uses the constant rather than a repeated literal');
});

// ===========================================================================
// 3. THE MOCK-PROVIDER WARNING
// ===========================================================================

test('the mock warning FIRES when the bind is beyond loopback', async () => {
    const output = await startAndCapture('0.0.0.0');
    assert.match(output, /WARNING: AI_PROVIDER is "mock"/, 'the warning fires at 0.0.0.0');
    assert.match(output, /NEVER completes/, 'and says why it matters');
});

test('the mock warning is SILENT on loopback', async () => {
    const output = await startAndCapture('127.0.0.1');
    assert.equal(/WARNING: AI_PROVIDER is "mock"/.test(output), false, 'a local run is not warned about');
});

test('the mock warning does not fire under npm test', async () => {
    // The suite runs on 127.0.0.1, so a warning on every run would be noise. The condition excludes
    // every loopback spelling the app accepts.
    const output = await startAndCapture('127.0.0.1');
    assert.equal(/AI_PROVIDER is "mock"/.test(output), false, 'no mock warning on the loopback bind the tests use');
});
