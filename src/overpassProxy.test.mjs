// OVERPASS PROXY — which upstream answers count as an answer.
//
// The proxy fans out across four public mirrors. What decides whether a mirror
// has answered is one predicate, and it is used TWICE: once to decide what
// enters the cache, and once to decide when a stale entry may stand in. When
// those two drifted, a refusal was written to memory and disk AND served as
// data — and boundary-class queries hold a month-long TTL, so a single refusal
// outlived the outage that caused it by weeks.
//
// The refusal was real and measured: overpass-api.de and its lz4 alias answer
// 406 to this proxy's User-Agent, while kumi.systems and private.coffee answer
// 200 to the identical request. Only 5xx rotated mirrors, so the fan-out
// stopped at the first refusal with two healthy mirrors untried, and four of
// twenty-three cached entries on this machine held an Apache error page.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOverpassPayload, overpassPayloadIsData } from '../vite.config.js';

const ENDPOINTS = ['https://a.example/api', 'https://b.example/api', 'https://c.example/api'];

/** Answer each endpoint from a map of url → {status, body}; record the order. */
function mirrors(byUrl) {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    const answer = byUrl[url];
    if (answer instanceof Error) throw answer;
    return { status: answer.status, headers: { get: () => answer.contentType || 'application/json' } };
  };
  return { fetchImpl, tried, readBody: async (_, __) => byUrl[tried[tried.length - 1]]?.body ?? '' };
}

const run = (byUrl) => {
  const m = mirrors(byUrl);
  return fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    fetchImpl: m.fetchImpl,
    readBody: m.readBody,
    simplify: (body) => body,
  }).then((payload) => ({ payload, tried: m.tried }), (error) => ({ error, tried: m.tried }));
};

const DATA = { status: 200, body: '{"elements":[]}' };

// ── The predicate ────────────────────────────────────────────────────────────

test('only a 2xx that is neither rate-limited nor a runtime error is data', () => {
  assert.equal(overpassPayloadIsData({ status: 200 }), true);
  assert.equal(overpassPayloadIsData({ status: 204 }), true);

  // The measured refusal, and its neighbours. `< 500` admitted every one.
  for (const status of [400, 403, 406, 410, 429]) {
    assert.equal(overpassPayloadIsData({ status }), false, `${status} is not data`);
  }
  assert.equal(overpassPayloadIsData({ status: 502 }), false);
  // A 200 can still not be data: Overpass reports runtime failures in the body.
  assert.equal(overpassPayloadIsData({ status: 200, runtimeError: true }), false);
  assert.equal(overpassPayloadIsData({ status: 200, rateLimited: true }), false);
  assert.equal(overpassPayloadIsData({}), false);
  assert.equal(overpassPayloadIsData(null), false);
});

// ── The fan-out ──────────────────────────────────────────────────────────────

test('a refusal moves to the next mirror instead of ending the fan-out', async () => {
  // The exact shape measured against the live mirrors.
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: { status: 406, contentType: 'text/html', body: '<!DOCTYPE HTML><title>406</title>' },
    [ENDPOINTS[1]]: DATA,
    [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.status, 200);
  assert.equal(payload.endpoint, ENDPOINTS[1]);
  assert.deepEqual(tried, ENDPOINTS.slice(0, 2), 'the healthy mirror must be reached, and no further');
});

test('the first mirror to answer wins, and the rest are left alone', async () => {
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: DATA, [ENDPOINTS[1]]: DATA, [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.endpoint, ENDPOINTS[0]);
  assert.deepEqual(tried, [ENDPOINTS[0]]);
});

test('a refusal every mirror agrees on is reported, not swallowed', async () => {
  // A genuinely bad query must still say what upstream said — but only after
  // every mirror has had its chance to answer it.
  const refusal = { status: 400, body: 'line 1: parse error' };
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: refusal, [ENDPOINTS[1]]: refusal, [ENDPOINTS[2]]: refusal,
  });

  assert.equal(payload.status, 400);
  assert.equal(payload.endpoint, ENDPOINTS[0], 'the FIRST refusal is the one reported');
  assert.deepEqual(tried, ENDPOINTS);
  assert.equal(overpassPayloadIsData(payload), false, 'so it is neither cached nor served as data');
});

test('a mirror that throws is no different from one that refuses', async () => {
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: { status: 503, body: 'busy' },
    [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.endpoint, ENDPOINTS[2]);
  assert.deepEqual(tried, ENDPOINTS);
});

test('when every mirror is unreachable the caller gets a throw, not a payload', async () => {
  const { error, payload } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: new Error('ETIMEDOUT'),
    [ENDPOINTS[2]]: new Error('ENOTFOUND'),
  });

  assert.equal(payload, undefined);
  assert.match(error.message, /ENOTFOUND/);
});
