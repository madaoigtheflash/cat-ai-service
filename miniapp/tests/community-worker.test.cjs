'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { EventEmitter } = require('node:events')
const { parseContext } = require('../cloudfunctions/catOnline/node_modules/@cloudbase/node-sdk')
const { prepareWorkerInvocation, boundedClone } = require('../cloudfunctions/catCommunity/worker-env')
const { createIsolatedHandler, DEADLINE_MS } = require('../cloudfunctions/catCommunity/isolated-entry')

const ENV = 'offline-worker-env'
const ROOT = path.join(__dirname, '../cloudfunctions/catCommunity')
const PARENT = Object.freeze({
  CLOUDBASE_ENV_ID: ENV, CAT_COMMUNITY_OWNER_SECRET: 'offline-owner-secret',
  CAT_COMMUNITY_REVIEW_SECRET: 'offline-review-secret', CAT_COMMUNITY_MEDIA_ENABLED: 'false',
  CAT_COMMUNITY_STORAGE_PROBE_ENABLED: 'false', TENCENTCLOUD_RUNENV: 'SCF', TENCENTCLOUD_REGION: 'ap-shanghai',
  TENCENTCLOUD_SECRETID: 'server-id', TENCENTCLOUD_SECRETKEY: 'server-key', TENCENTCLOUD_SESSIONTOKEN: 'server-token',
  WX_OPENID: 'stale-alice', WX_APPID: 'stale-app', WX_API_TOKEN: 'stale-wx-token',
  WX_CLOUDBASE_ACCESSTOKEN: 'stale-access', WX_CONTEXT_KEYS: 'WX_OPENID,WX_APPID,WX_API_TOKEN',
  TCB_SESSIONTOKEN: 'stale-tcb-token', TCB_CONTEXT_KEYS: 'TCB_SESSIONTOKEN,TCB_UUID', TCB_UUID: 'stale-uuid',
  NODE_OPTIONS: '--require do-not-load', UNRELATED_SECRET: 'do-not-copy'
})

function runtime(openid = '', extra = {}, legacy = false) {
  const environment = { SCF_NAMESPACE: ENV, TCB_SOURCE: openid ? 'wx_client' : 'operator', ...extra }
  if (openid) Object.assign(environment, { WX_OPENID: openid, WX_APPID: 'wx-offline',
    WX_API_TOKEN: `wx-token-${openid}`, TCB_SESSIONTOKEN: `tcb-token-${openid}`,
    WX_CONTEXT_KEYS: 'WX_OPENID,WX_APPID,WX_API_TOKEN', TCB_CONTEXT_KEYS: 'TCB_SESSIONTOKEN,TCB_SOURCE' })
  Object.assign(environment, extra)
  return { request_id: 'offline-worker-request', namespace: ENV,
    ...(legacy ? { environ: Object.entries(environment).map(([key, value]) => `${key}=${value}`).join(';') }
      : { environment: JSON.stringify(environment) }) }
}
function prepare(event = {}, context = runtime(), env = PARENT) {
  return prepareWorkerInvocation(event, context, env, parseContext)
}

// Run the production worker entry in a real isolated Node Worker. Only index's
// business handler is replaced in-worker; no network/CloudBase operation occurs.
class OfflineBusinessWorker extends Worker {
  constructor(filename, options) {
    const source = `
      const Module = require('node:module');
      const {workerData} = require('node:worker_threads');
      const original = Module._load;
      Module._load = function(name, parent, main) {
        if(name === './index' && parent && parent.filename === ${JSON.stringify(path.join(ROOT, 'request-worker.js'))}) {
          return { main: async (event, context) => {
            if(event.mode === 'throw') throw new Error('private-token-must-not-leak');
            if(event.mode === 'hang') return new Promise(()=>setInterval(()=>{},1000));
            if(event.mode === 'exit') process.exit(2);
            if(event.mode === 'too-large') return {ok:true, data:'x'.repeat(600000)};
            const snapshot = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
              /^(WX_|TCB_|TENCENTCLOUD_|CLOUDBASE_|CAT_COMMUNITY_|UNRELATED_SECRET|NODE_OPTIONS)/.test(key)));
            process.env.WX_OPENID = 'worker-only-mutation';
            return {ok:true, data:{snapshot, context:JSON.parse(context.environment), event}};
          }};
        }
        return original.call(this,name,parent,main);
      };
      require(${JSON.stringify(path.join(ROOT, 'request-worker.js'))});
    `
    super(source, { ...options, eval: true })
  }
}
function handler(extra = {}) {
  return createIsolatedHandler({ WorkerClass: OfflineBusinessWorker, environment: () => PARENT, parseContextFn: parseContext, ...extra })
}

test('current A → operator → B env excludes every stale caller token without mutating parent env', () => {
  const before = JSON.stringify(PARENT)
  for (const actor of ['alice', '', 'bob']) {
    const result = prepare({}, runtime(actor))
    assert.equal(result.env.WX_OPENID, actor || undefined)
    assert.equal(result.env.WX_API_TOKEN, actor ? `wx-token-${actor}` : undefined)
    assert.equal(result.env.TCB_SESSIONTOKEN, actor ? `tcb-token-${actor}` : undefined)
    assert.equal(result.env.WX_CLOUDBASE_ACCESSTOKEN, undefined)
    assert.equal(result.env.TCB_UUID, undefined)
    assert.equal(result.env.UNRELATED_SECRET, undefined)
    assert.equal(result.env.NODE_OPTIONS, undefined)
    assert.equal(result.env.TENCENTCLOUD_SECRETID, 'server-id')
    assert.equal(result.env.TENCENTCLOUD_SESSIONTOKEN, 'server-token')
  }
  assert.equal(JSON.stringify(PARENT), before)
})

test('legacy key arrays are regenerated from allowed own current values', () => {
  const result = prepare({}, runtime('alice', {}, true))
  assert.equal(typeof result.env.WX_CONTEXT_KEYS, 'string')
  assert.ok(result.env.WX_CONTEXT_KEYS.includes('WX_OPENID'))
  assert.equal(result.env.WX_API_TOKEN, 'wx-token-alice')
  assert.equal(prepare({}, runtime('alice', { TCB_SOURCE: 'wx_client,scf' }, true)).env.TCB_SOURCE, 'wx_client,scf')
  const unknown = prepare({}, runtime('alice', { WX_UNRELATED: 'not-allowed', TCB_CONTEXT_KEYS: 'UNRELATED_SECRET,NODE_OPTIONS' }))
  assert.equal(unknown.env.WX_UNRELATED, undefined)
  assert.doesNotMatch(unknown.env.TCB_CONTEXT_KEYS, /UNRELATED_SECRET|NODE_OPTIONS/)
})

test('operator drops even current WeChat tokens without an actual WeChat identity', () => {
  const result = prepare({}, runtime('', { WX_API_TOKEN: 'unexpected-current-token', WX_TRIGGER_API_TOKEN_V0: 'trigger-token' }))
  assert.equal(result.env.WX_API_TOKEN, undefined)
  assert.equal(result.env.WX_TRIGGER_API_TOKEN_V0, undefined)
  assert.equal(result.env.WX_CONTEXT_KEYS, undefined)
})

test('complete current IAM role wins; partial tuples fail rather than mix current and inherited credentials', () => {
  const result = prepare({}, runtime('', { TENCENTCLOUD_SECRETID: 'current-id', TENCENTCLOUD_SECRETKEY: 'current-key', TENCENTCLOUD_SESSIONTOKEN: 'current-token' }))
  assert.equal(result.env.TENCENTCLOUD_SECRETID, 'current-id')
  assert.equal(result.env.TENCENTCLOUD_SESSIONTOKEN, 'current-token')
  assert.throws(() => prepare({}, runtime('', { TENCENTCLOUD_SECRETID: 'partial' })))
  assert.throws(() => prepare({}, runtime(), { ...PARENT, TENCENTCLOUD_SESSIONTOKEN: '' }))
  const external = prepare({}, runtime(), { ...PARENT, TENCENTCLOUD_RUNENV: 'not-scf' })
  assert.equal(external.env.TENCENTCLOUD_SECRETID, undefined)
})

test('malformed token arrays, null bytes, mismatched env and oversized context fail closed', () => {
  for (const context of [runtime('alice', { TCB_SESSIONTOKEN: ['token'] }), runtime('', { TCB_SESSIONTOKEN: 'a\u0000b' }),
    { ...runtime(), environment: 'x'.repeat(65537) }, { ...runtime(), namespace: 'other-env' }]) {
    assert.throws(() => prepare({}, context))
  }
})

test('bounded payload rejects cycles, getters, functions, prototype injection and excessive structures', () => {
  const cycle = {}; cycle.self = cycle
  let getterCalled = false
  const getter = Object.defineProperty({}, 'private', { enumerable: true, get() { getterCalled = true; return 'secret' } })
  for (const payload of [cycle, getter, { fn() {} }, JSON.parse('{"__proto__":{}}'),
    { content: 'x'.repeat(131073) }, { nested: Array.from({ length: 5000 }, () => 1) }, Buffer.from('x')]) {
    assert.throws(() => prepare(payload))
  }
  assert.equal(getterCalled, false)
  assert.equal(boundedClone({ content: '猫咪', photos: ['cloud://photo'] }).content, '猫咪')
})

test('real Workers isolate A → operator → B including SDK globals and never alter actual process env', async () => {
  const main = handler(), before = process.env.WX_OPENID
  for (const actor of ['alice', '', 'bob']) {
    const result = await main({ action: 'offline' }, runtime(actor))
    assert.equal(result.ok, true)
    assert.equal(result.data.snapshot.WX_OPENID, actor || undefined)
    assert.equal(result.data.snapshot.WX_API_TOKEN, actor ? `wx-token-${actor}` : undefined)
    assert.equal(result.data.snapshot.TCB_SESSIONTOKEN, actor ? `tcb-token-${actor}` : undefined)
    assert.equal(result.data.snapshot.TENCENTCLOUD_SESSIONTOKEN, 'server-token')
    assert.equal(result.data.snapshot.UNRELATED_SECRET, undefined)
    assert.equal(result.data.snapshot.NODE_OPTIONS, undefined)
  }
  assert.equal(process.env.WX_OPENID, before)
})

test('event cannot select worker entry, env, tokens or runtime identity', async () => {
  const result = await handler()({ env: { WX_OPENID: 'forged' }, workerFile: '/do-not-run',
    WX_API_TOKEN: 'forged-token', runtimeContext: runtime('forged') }, runtime('trusted'))
  assert.equal(result.ok, true)
  assert.equal(result.data.snapshot.WX_OPENID, 'trusted')
  assert.equal(result.data.snapshot.WX_API_TOKEN, 'wx-token-trusted')
  assert.equal(result.data.context.WX_OPENID, 'trusted')
})

test('real worker exception, early exit and oversized output use fixed safe failures', async () => {
  const main = handler()
  for (const mode of ['throw', 'exit', 'too-large']) {
    const result = await main({ mode }, runtime())
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'SERVICE_UNAVAILABLE')
    assert.doesNotMatch(JSON.stringify(result), /private-token|stack|600000/)
  }
})

test('deadline terminates hung real worker and a following request still succeeds', async () => {
  assert.ok(DEADLINE_MS < 60000)
  const main = handler({ deadlineMs: 300 }), start = Date.now()
  const result = await main({ mode: 'hang' }, runtime())
  assert.equal(result.error.code, 'SERVICE_UNAVAILABLE')
  assert.ok(Date.now() - start < 3000)
  assert.equal((await main({}, runtime('bob'))).ok, true)
})

test('malformed context fails before any Worker is constructed', async () => {
  let constructed = 0
  class NeverWorker { constructor() { constructed += 1 } }
  const main = createIsolatedHandler({ WorkerClass: NeverWorker, environment: () => PARENT, parseContextFn: parseContext })
  assert.equal((await main({ context: runtime('forged') })).error.code, 'INVALID_CONTEXT')
  assert.equal(constructed, 0)
})

test('result/error/exit races resolve once, request termination and clean event listeners', async () => {
  const instances = []
  class RaceWorker extends EventEmitter {
    constructor() {
      super(); this.terminated = 0; instances.push(this)
      setImmediate(() => { this.emit('message', { type: 'result', result: { ok: true, data: {} } }); this.emit('error', new Error('private')); this.emit('exit', 1) })
    }
    unref() {}
    terminate() { this.terminated += 1; return Promise.resolve(0) }
  }
  const main = createIsolatedHandler({ WorkerClass: RaceWorker, environment: () => PARENT, parseContextFn: parseContext, deadlineMs: 100 })
  assert.equal((await main({}, runtime())).ok, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(instances[0].terminated, 1)
  for (const event of ['message', 'error', 'exit']) assert.equal(instances[0].listenerCount(event), 0)
})

test('concurrency is bounded without a process-global credential queue', async () => {
  const main = handler({ deadlineMs: 150 })
  const first = main({ mode: 'hang' }, runtime('alice')), second = main({ mode: 'hang' }, runtime('bob'))
  const third = await main({}, runtime())
  assert.equal(third.error.code, 'SERVICE_UNAVAILABLE')
  await Promise.all([first, second])
})
