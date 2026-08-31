const test = require('node:test')
const assert = require('node:assert/strict')

const identity = require('../services/identity')

test('identity service accepts the safe data envelope', () => {
  const task = { taskId: 'job_1', candidates: [] }
  assert.deepEqual(identity._test.normalizeResult({ result: { ok: true, data: task } }), task)
})

test('identity service surfaces stable cloud errors', () => {
  assert.throws(
    () => identity._test.normalizeResult({ result: { ok: false, error: { code: 'FORBIDDEN', message: '没有权限' } } }),
    /没有权限/
  )
  assert.throws(() => identity._test.normalizeResult(null), /云函数未返回结果/)
})

test('same sighting uses a stable bounded match idempotency key', () => {
  const first = identity._test.stableMatchKey('com_1', 'sig_1')
  const second = identity._test.stableMatchKey('com_1', 'sig_1')
  assert.equal(first, second)
  assert.match(first, /^match_[A-Za-z0-9._:-]+$/)
  assert.ok(first.length <= 120)
})

test('identity request tokens are non-static', () => {
  const first = identity._test.makeToken('confirm')
  const second = identity._test.makeToken('confirm')
  assert.notEqual(first, second)
})

test('restart uses a fresh task key after an undo', async () => {
  const payloads = []
  global.wx = {
    cloud: {
      callFunction(options) {
        payloads.push(options.data)
        return Promise.resolve({ result: { ok: true, data: { taskId: 'job_next' } } })
      }
    }
  }
  await identity.restartMatch('com_1', 'sig_1', 'job_old')
  await identity.restartMatch('com_1', 'sig_1', 'job_old')
  assert.match(payloads[0].idempotencyKey, /^rematch_job_old_/)
  assert.notEqual(payloads[0].idempotencyKey, payloads[1].idempotencyKey)
  delete global.wx
})

test('linked sighting enrollment uses a stable explicit cloud action', async () => {
  const payloads = []
  global.wx = {
    cloud: {
      callFunction(options) {
        payloads.push(options.data)
        return Promise.resolve({ result: { ok: true, data: { enrolled: true } } })
      }
    }
  }
  await identity.enrollLinkedSighting('com_1', 'sig_1')
  await identity.enrollLinkedSighting('com_1', 'sig_1')
  assert.equal(payloads[0].action, 'enrollLinkedSighting')
  assert.equal(payloads[0].idempotencyKey, payloads[1].idempotencyKey)
  assert.match(payloads[0].idempotencyKey, /^enroll_[A-Za-z0-9._:-]+$/)
  delete global.wx
})
