const CLOUD_ENV = 'cloud1-d6gpjpxunc74669d7'
const FUNCTION_NAME = 'catIdentity'

function makeToken(prefix) {
  return `${prefix || 'request'}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function normalizeResult(response, fallback) {
  const result = response && response.result
  if (!result) throw new Error(fallback || '云函数未返回结果')
  if (result.ok === false || result.success === false) {
    const detail = result.error && (result.error.message || result.error.code)
    throw new Error(detail || result.error || fallback || '同猫服务执行失败')
  }
  return result.data || result
}

function call(action, payload, options) {
  if (!wx.cloud) return Promise.reject(new Error('当前微信版本不支持云开发，请升级微信'))
  const opts = options || {}
  const data = Object.assign({
    action,
    schemaVersion: 1,
    requestId: opts.requestId || makeToken('identity_request')
  }, payload || {})
  if (opts.write !== false && !data.idempotencyKey) data.idempotencyKey = makeToken(action)
  return wx.cloud.callFunction({
    name: FUNCTION_NAME,
    data,
    config: { env: CLOUD_ENV }
  }).then(response => normalizeResult(response, `${action} 调用失败`))
}

function stableMatchKey(communityId, sightingId) {
  const raw = `${communityId}_${sightingId}`.replace(/[^A-Za-z0-9._:-]/g, '_')
  return `match_${raw}`.slice(0, 120)
}

function startMatch(communityId, sightingId, idempotencyKey) {
  return call('startMatch', {
    communityId,
    sightingId,
    idempotencyKey: idempotencyKey || stableMatchKey(communityId, sightingId)
  })
}

function enrollLinkedSighting(communityId, sightingId, idempotencyKey) {
  const raw = `${communityId}_${sightingId}`.replace(/[^A-Za-z0-9._:-]/g, '_')
  return call('enrollLinkedSighting', {
    communityId,
    sightingId,
    idempotencyKey: idempotencyKey || `enroll_${raw}`.slice(0, 120)
  })
}

function restartMatch(communityId, sightingId, previousTaskId) {
  const key = makeToken(`rematch_${String(previousTaskId || 'task').slice(0, 32)}`)
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .slice(0, 120)
  return startMatch(communityId, sightingId, key)
}

function getTask(taskId) {
  return call('getTask', { taskId }, { write: false })
}

function confirm(taskId, expectedVersion, decision) {
  return call('confirm', { taskId, expectedVersion, decision })
}

function undo(taskId, expectedVersion) {
  return call('undo', { taskId, expectedVersion })
}

function health() {
  return call('health', {}, { write: false })
}

module.exports = {
  CLOUD_ENV,
  FUNCTION_NAME,
  startMatch,
  enrollLinkedSighting,
  restartMatch,
  getTask,
  confirm,
  undo,
  health,
  _test: { makeToken, normalizeResult, stableMatchKey }
}
