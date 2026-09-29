'use strict'

const { CommunityError } = require('./core')

function invalidContext() {
  return new CommunityError('INVALID_CONTEXT', '无法确认本次请求身份，请重新进入后再试')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function ownString(value, key, { required = false, pattern = null, max = 256 } = {}) {
  if (!Object.hasOwn(value, key)) {
    if (required) throw invalidContext()
    return ''
  }
  const item = value[key]
  if (typeof item !== 'string' || item.length > max || /[\u0000-\u001f\u007f]/.test(item) ||
    (required && !item) || (item && pattern && !pattern.test(item))) throw invalidContext()
  return item
}

// Only the platform's second handler argument is accepted here. Never merge
// process.env/getWXContext(): a warm SCF instance can retain a previous caller.
// https://docs.cloudbase.net/cloud-function/instance
// https://docs.cloudbase.net/api-reference/server/node-sdk/env
function parseRequestEnvironment(runtimeContext, parseContextFn) {
  try {
    if (!isRecord(runtimeContext)) throw invalidContext()
    ownString(runtimeContext, 'request_id', { required: true, max: 200 })
    const hasEnvironment = Object.hasOwn(runtimeContext, 'environment')
    if (hasEnvironment) {
      // A present but malformed new-format field must not silently fall back.
      if (typeof runtimeContext.environment !== 'string' || !runtimeContext.environment) throw invalidContext()
      if (!isRecord(JSON.parse(runtimeContext.environment))) throw invalidContext()
    } else {
      if (!Object.hasOwn(runtimeContext, 'environ') || typeof runtimeContext.environ !== 'string' || !runtimeContext.environ) throw invalidContext()
      const seen = new Map()
      for (const fragment of runtimeContext.environ.split(';').filter(Boolean)) {
        const index = fragment.indexOf('=')
        const key = fragment.slice(0, index), value = fragment.slice(index + 1)
        if (index < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          (seen.has(key) && seen.get(key) !== value)) throw invalidContext()
        seen.set(key, value)
      }
    }
    // Pin the direct dependency to the same 3.17.2 used by wx-server-sdk 4.0.2.
    // Do not substitute getCloudbaseContext; it falls back to process.env.
    const parser = parseContextFn || require('@cloudbase/node-sdk').parseContext
    const parsed = parser(runtimeContext)
    const environment = parsed && (hasEnvironment ? parsed.environment : parsed.environ)
    if (!isRecord(environment)) throw invalidContext()
    const snapshot = Object.fromEntries(Object.entries(environment))
    if (Object.hasOwn(snapshot, '__proto__') || Object.hasOwn(snapshot, 'constructor') || Object.hasOwn(snapshot, 'prototype')) throw invalidContext()
    return Object.freeze(snapshot)
  } catch (_) {
    // SDK/JSON errors may contain context or credentials. Never expose them.
    throw invalidContext()
  }
}

function resolveRequestContext(runtimeContext, parseContextFn) {
  const environment = parseRequestEnvironment(runtimeContext, parseContextFn)
  const identityPattern = /^[A-Za-z0-9_-]+$/
  const openid = ownString(environment, 'WX_OPENID', { pattern: identityPattern, max: 128 })
  const appid = ownString(environment, 'WX_APPID', { pattern: identityPattern, max: 128 })
  // The official legacy parser turns every comma-separated value into an array.
  // TCB_SOURCE is legitimately a source chain, unlike identity/credential fields.
  const sourceValue = !Object.hasOwn(runtimeContext, 'environment') && Array.isArray(environment.TCB_SOURCE)
    ? { TCB_SOURCE: environment.TCB_SOURCE.every(value => typeof value === 'string') ? environment.TCB_SOURCE.join(',') : null }
    : environment
  const source = ownString(sourceValue, 'TCB_SOURCE', { max: 512 })
  const tcbEnv = ownString(environment, 'TCB_ENV', { pattern: identityPattern, max: 128 })
  const namespace = ownString(environment, 'SCF_NAMESPACE', { pattern: identityPattern, max: 128 })
  const handlerNamespace = ownString(runtimeContext, 'namespace', { pattern: identityPattern, max: 128 })
  const envId = tcbEnv || namespace || handlerNamespace
  if (!envId || (tcbEnv && namespace && tcbEnv !== namespace) || (handlerNamespace && handlerNamespace !== envId)) throw invalidContext()
  // Incomplete WeChat identity cannot be reclassified as an operator request.
  if (appid && !openid) throw invalidContext()
  return Object.freeze({ openid, appid, source, envId, requestId: runtimeContext.request_id })
}

module.exports = { parseRequestEnvironment, resolveRequestContext }
