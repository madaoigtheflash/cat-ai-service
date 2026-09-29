'use strict'

// Offline regression tests use the official parser, never a cloud connection.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { parseContext } = require('../cloudfunctions/catOnline/node_modules/@cloudbase/node-sdk')
const requestContext = require('../cloudfunctions/catCommunity/request-context')
const { signStorageProbe, ACTION } = require('../cloudfunctions/catCommunity/storage-probe')
const { signReview } = require('../cloudfunctions/catCommunity/review')
const core = require('../cloudfunctions/catCommunity/core')

const ENV = 'offline-context-env'
const SECRET = 'offline-request-context-review-secret-not-production'
const ROOT = path.join(__dirname, '../cloudfunctions/catCommunity')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 0xff, 0xd9])

function runtime(openid = '', changes = {}, legacy = false) {
  const environment = { SCF_NAMESPACE: ENV, ...changes }
  if (openid) Object.assign(environment, { WX_OPENID: openid, WX_APPID: 'wx-offline-test', WX_CONTEXT_KEYS: 'WX_OPENID,WX_APPID', TCB_SOURCE: 'wx_client' })
  return { request_id: 'offline-request-0001', namespace: ENV,
    ...(legacy ? { environ: Object.entries(environment).map(([key, value]) => `${key}=${value}`).join(';') }
      : { environment: JSON.stringify(environment) }) }
}

function resolve(context) { return requestContext.resolveRequestContext(context, parseContext) }

function fixture() {
  const filename = path.join(ROOT, 'index.js'), localRequire = createRequire(filename), module = { exports: {} }
  const actors = [], calls = [], files = new Map()
  const env = { CLOUDBASE_ENV_ID: ENV, CAT_COMMUNITY_MEDIA_ENABLED: 'false', CAT_COMMUNITY_STORAGE_PROBE_ENABLED: 'true',
    CAT_COMMUNITY_REVIEW_SECRET: SECRET, CAT_COMMUNITY_OWNER_SECRET: `${SECRET}-owner`,
    WX_CONTEXT_KEYS: 'WX_OPENID,WX_APPID', WX_OPENID: 'stale-wechat-user', WX_APPID: 'stale-app' }
  const cloud = {
    DYNAMIC_CURRENT_ENV: ENV, init() {},
    getWXContext() { assert.fail('identity must never read process-wide WeChat context') },
    database: () => ({ command: {}, collection() { calls.push('database'); assert.fail('identity/probe test must not access data') } }),
    async uploadFile({ cloudPath, fileContent }) {
      calls.push('upload'); const fileID = `cloud://${ENV}.test/${cloudPath}`
      files.set(fileID, fileContent); return { fileID }
    },
    async getTempFileURL() { assert.fail('bounded media fixture owns transfer') }
  }
  const overrides = {
    'wx-server-sdk': cloud,
    './request-context': { resolveRequestContext: resolve },
    './core': { ...core, createCommunityCore: () => ({ async handle(event, context) {
      actors.push(context.openid); return { ok: true, data: { identityPresent: Boolean(context.openid) } }
    } }) },
    './sanitize': { async sanitizeApprovedImage() { calls.push('sanitize'); return JPEG } },
    './bounded-media': { createBoundedMediaDownloader: ({ cloudEnvId }) => async fileID => {
      assert.equal(cloudEnvId, ENV); calls.push('download'); return files.get(fileID)
    } }
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name), process: { env } }, { filename })
  return { main: module.exports.main, actors, calls, env }
}

function signedProbe() {
  const event = { action: ACTION, requestId: 'ac'.repeat(24), expiresAt: new Date(Date.now() + 240000).toISOString() }
  return { ...event, signature: signStorageProbe(event, SECRET) }
}

test('official parser supports platform JSON environment and legacy environ without reading process state', () => {
  for (const legacy of [false, true]) {
    const input = runtime('wechat-alice', { TENCENTCLOUD_SESSIONTOKEN: 'offline-token=with-equals' }, legacy)
    const before = JSON.stringify(input), context = resolve(input)
    assert.deepEqual(context, { openid: 'wechat-alice', appid: 'wx-offline-test', source: 'wx_client', envId: ENV, requestId: 'offline-request-0001' })
    assert.equal(Object.isFrozen(context), true)
    const environment = requestContext.parseRequestEnvironment(input, parseContext)
    assert.equal(environment.TENCENTCLOUD_SESSIONTOKEN, 'offline-token=with-equals')
    assert.equal(Object.isFrozen(environment), true)
    assert.equal(JSON.stringify(input), before)
  }
})

test('missing, malformed, ambiguous and credential-bearing errors fail closed with fixed safe messages', () => {
  const bad = [undefined, null, [], {}, { request_id: 'x' }, { environment: '{}', namespace: ENV },
    { ...runtime(), environment: '' }, { ...runtime(), environment: 'private-secret' },
    { ...runtime(), environment: 'null' }, { ...runtime(), environment: '[]' },
    { ...runtime(), environment: '{bad', environ: `SCF_NAMESPACE=${ENV}` },
    { request_id: 'x', namespace: ENV, environ: 'private-secret' },
    { request_id: 'x', namespace: ENV, environ: `SCF_NAMESPACE=${ENV};WX_OPENID=alice;WX_OPENID=bob` },
    runtime('', { __proto__: null, WX_OPENID: ['alice'] }), runtime('', { WX_OPENID: null }),
    runtime('', { WX_OPENID: 'alice\n' }), runtime('', { WX_APPID: 'wx-without-user' }),
    runtime('', { TCB_ENV: 'other-environment' }), { ...runtime(), namespace: 'other-environment' },
    { ...runtime(), environment: '{"__proto__":{"WX_OPENID":"alice"}}' }]
  for (const input of bad) assert.throws(() => resolve(input), error => {
    assert.equal(error.code, 'INVALID_CONTEXT')
    assert.doesNotMatch(error.message, /private-secret|alice|bob|token/)
    return true
  })
})

test('identical duplicate legacy namespace is compatible but conflicting identities are not', () => {
  const input = { request_id: 'x', namespace: ENV, environ: `SCF_NAMESPACE=${ENV};SCF_NAMESPACE=${ENV};WX_OPENID=alice;` }
  assert.equal(resolve(input).openid, 'alice')
  input.environ += 'TCB_SOURCE=wx_client,scf;'
  assert.equal(resolve(input).source, 'wx_client,scf')
  assert.throws(() => resolve(runtime('', { TCB_SOURCE: ['wx_client', 'scf'] })), error => error.code === 'INVALID_CONTEXT')
})

test('official SCF parser itself rejects a missing environment rather than classifying it as an operator', () => {
  for (const input of [{ request_id: 'offline-no-env' }, { request_id: 'offline-no-env', environment: '', environ: undefined }]) {
    assert.throws(() => parseContext(input), error => error.code === 'INVALID_CONTEXT')
    assert.throws(() => resolve(input), error => error.code === 'INVALID_CONTEXT')
  }
})

test('a missing APPID cannot erase a trusted OPENID; APPID-only is ambiguous and rejected', async () => {
  const f = fixture(), input = runtime('', { WX_OPENID: 'openid-without-appid' })
  assert.equal(resolve(input).openid, 'openid-without-appid')
  assert.equal((await f.main(signedProbe(), input)).error.code, 'FORBIDDEN')
  assert.equal((await f.main(signedProbe(), runtime('', { WX_APPID: 'appid-without-openid' }))).error.code, 'INVALID_CONTEXT')
  assert.equal(f.calls.length, 0)
})

test('the validated snapshot does not expose ambient credentials or event-derived identity', () => {
  const environment = requestContext.parseRequestEnvironment(runtime(), parseContext)
  assert.deepEqual(Object.keys(environment), ['SCF_NAMESPACE'])
  assert.equal(Object.hasOwn(environment, 'WX_OPENID'), false)
  assert.equal(Object.hasOwn(environment, 'TENCENTCLOUD_SECRETKEY'), false)
  assert.equal(resolve(runtime('', { OPENID: 'event-style-identity', openid: 'event-style-identity' })).openid, '')
})

test('warm A → operator → B requests use only their own platform identity and never mutate globals', async () => {
  const f = fixture(), before = JSON.stringify(f.env)
  for (const caller of ['wechat-alice', '', 'wechat-bob']) assert.equal((await f.main({ action: 'listPosts' }, runtime(caller))).ok, true)
  assert.deepEqual(f.actors, ['wechat-alice', '', 'wechat-bob'])
  assert.equal(JSON.stringify(f.env), before)
  assert.equal(f.calls.length, 0)
})

test('caller-supplied event identities and fake runtime objects cannot replace the second handler argument', async () => {
  const f = fixture()
  const forged = { action: 'listPosts', openid: 'forged-user', OPENID: 'forged-user', WX_OPENID: 'forged-user',
    context: runtime('forged-user'), runtimeContext: runtime('forged-user'), environment: runtime('forged-user').environment }
  assert.equal((await f.main(forged, runtime('trusted-user'))).ok, true)
  assert.equal((await f.main(forged, runtime())).ok, true)
  assert.equal((await f.main(forged)).error.code, 'INVALID_CONTEXT')
  assert.deepEqual(f.actors, ['trusted-user', ''])
})

test('a correctly signed operator reaches the synthetic probe even when stale global OPENID exists', async () => {
  const f = fixture()
  const result = await f.main(signedProbe(), runtime())
  assert.equal(result.ok, true)
  assert.equal(result.data.cleanupRequired, true)
  assert.deepEqual(f.calls, ['sanitize', 'upload', 'download'])
  assert.equal(f.env.WX_OPENID, 'stale-wechat-user')
})

test('trusted WeChat requests remain forbidden for probe and review even with valid operator signatures', async () => {
  const f = fixture(), probe = signedProbe()
  const review = { action: 'reviewPost', postId: `post_${'a'.repeat(40)}`, requestHash: 'b'.repeat(64),
    reviewId: 'offline-request-context-review', decision: 'approved', reason: 'Synthetic test only', reviewedText: true,
    reviewedImages: true, expiresAt: new Date(Date.now() + 240000).toISOString() }
  review.signature = signReview(review, SECRET)
  for (const event of [probe, review]) assert.equal((await f.main(event, runtime('actual-wechat-user'))).error.code, 'FORBIDDEN')
  assert.equal(f.calls.length, 0)
  assert.equal(f.actors.length, 0)
})

test('operator identity alone grants no permission; bad HMAC and missing runtime cause no I/O', async () => {
  const f = fixture(), event = signedProbe()
  assert.equal((await f.main({ ...event, signature: '0'.repeat(64) }, runtime())).error.code, 'FORBIDDEN')
  assert.equal((await f.main(event)).error.code, 'INVALID_CONTEXT')
  assert.equal((await f.main(event, { ...runtime(), environment: '{broken' })).error.code, 'INVALID_CONTEXT')
  assert.equal(f.calls.length, 0)
})

test('configured cloud environment mismatch fails before business, moderation or media access', async () => {
  const f = fixture()
  f.env.CLOUDBASE_ENV_ID = 'different-configured-env'
  assert.equal((await f.main(signedProbe(), runtime())).error.code, 'INVALID_CONTEXT')
  assert.equal(f.calls.length, 0)
})
