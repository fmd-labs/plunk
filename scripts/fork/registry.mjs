#!/usr/bin/env node
// Look up the digest an image tag points to, telling a missing tag apart from every other answer.
//
// Usage:
//   node scripts/fork/registry.mjs digest ghcr.io/owner/name:tag
//
// Prints the manifest digest when the tag exists, and nothing when the registry reports the tag
// (or the repository) as unknown. Anything else (a denied or failed request) exits 1, so a
// transient error is never mistaken for a missing tag. Authenticates with REGISTRY_USERNAME and
// REGISTRY_PASSWORD when both are set, and anonymously otherwise.
//
// GHCR hides what credentials cannot read: an anonymous lookup in a private or missing package is
// denied, but an authenticated one reads as unknown. Where that difference matters, first look up a
// tag known to exist in the same package.

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Answer a registry's `WWW-Authenticate: Bearer realm=...,service=...,scope=...` challenge. */
async function bearerToken(challenge) {
  const params = Object.fromEntries(
    [...(challenge ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  );
  if (!/^Bearer /i.test(challenge ?? '') || !params.realm) {
    fail(`Unsupported authentication challenge: ${challenge}`);
  }

  const url = new URL(params.realm);
  for (const key of ['service', 'scope']) {
    if (params[key]) {
      url.searchParams.set(key, params[key]);
    }
  }
  const {REGISTRY_USERNAME, REGISTRY_PASSWORD} = process.env;
  const headers =
    REGISTRY_USERNAME && REGISTRY_PASSWORD
      ? {Authorization: `Basic ${Buffer.from(`${REGISTRY_USERNAME}:${REGISTRY_PASSWORD}`).toString('base64')}`}
      : {};

  const response = await fetch(url, {headers});
  if (!response.ok) {
    fail(`Token request for ${params.scope ?? url} failed: HTTP ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  return body.token ?? body.access_token;
}

const [command, reference] = process.argv.slice(2);
const match = /^([^/]+)\/([^:@]+):([\w][\w.-]{0,127})$/.exec(reference ?? '');
if (command !== 'digest' || !match) {
  fail('Usage: node scripts/fork/registry.mjs digest <registry>/<name>:<tag>');
}
const [, registry, name, tag] = match;
const url = `https://${registry}/v2/${name}/manifests/${tag}`;

let response = await fetch(url, {headers: {Accept: MANIFEST_TYPES}});
if (response.status === 401) {
  const token = await bearerToken(response.headers.get('www-authenticate'));
  response = await fetch(url, {headers: {Accept: MANIFEST_TYPES, Authorization: `Bearer ${token}`}});
}

if (response.status === 404) {
  process.exit(0);
}
if (response.status !== 200) {
  fail(`${reference}: HTTP ${response.status} ${await response.text()}`);
}

const digest = response.headers.get('docker-content-digest');
if (!digest) {
  fail(`${reference}: the registry did not return a digest`);
}
console.log(digest);
