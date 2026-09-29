'use strict'

const { parseRequestEnvironment, resolveRequestContext } = require('./request-context')

const CONFIG_KEYS = Object.freeze([
  'CLOUDBASE_ENV_ID', 'CAT_COMMUNITY_OWNER_SECRET', 'CAT_COMMUNITY_REVIEW_SECRET',
  'CAT_COMMUNITY_MEDIA_ENABLED', 'CAT_COMMUNITY_STORAGE_PROBE_ENABLED'
])
const SYSTEM_KEYS = Object.freeze([
  'PATH', 'NODE_PATH', 'LD_LIBRARY_PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot',
  'TENCENTCLOUD_REGION', 'TENCENTCLOUD_RUNENV'
])
const ROLE_KEYS = Object.freeze(['TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN'])
const REQUEST_KEYS = Object.freeze([
  'WX_OPENID', 'WX_APPID', 'WX_UNIONID', 'WX_API_TOKEN', 'WX_CLOUDBASE_ACCESSTOKEN',
  'WX_TRIGGER_API_TOKEN_V0', 'WX_CLIENTIP', 'WX_CLIENTIPV6',
  'TCB_ENV', 'TCB_SOURCE', 'TCB_SEQID', 'TCB_SESSIONTOKEN', 'TCB_CONTEXT_CNFG',
  'TCB_CUSTOM_USER_ID', 'TCB_HTTP_CONTEXT', 'TCB_ISANONYMOUS_USER', 'TCB_ROUTE_KEY',
  'TCB_SOURCE_IP', 'TCB_TRACELOG', 'TCB_UUID', 'LOGINTYPE', 'QQ_APPID', 'QQ_OPENID',
  'TRIGGER_SRC', '_SCF_TCB_LOG', 'SCF_NAMESPACE'
])

function invalid() { throw new Error('Invalid isolated invocation') }

// Bound before structured cloning. Do not invoke getters/toJSON or accept event
// prototypes, buffers, maps or executable values across the worker boundary.
function boundedClone(value, { maxBytes = 131072, maxNodes = 4096, maxDepth = 12 } = {}) {
  let bytes = 0, nodes = 0
  const ancestors = new Set()
  function visit(item, depth) {
    if (++nodes > maxNodes || depth > maxDepth) invalid()
    if (item === null || typeof item === 'boolean') { bytes += 5; return item }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid()
      bytes += 24; return item
    }
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item, 'utf8')
      if (bytes > maxBytes) invalid()
      return item
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalid()
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item)
    if (!array && proto !== Object.prototype && proto !== null) invalid()
    const keys = Object.keys(item)
    if (keys.length > maxNodes - nodes || (array && item.length > maxNodes - nodes)) invalid()
    const result = array ? [] : Object.create(null)
    ancestors.add(item)
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid()
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid()
      bytes += Buffer.byteLength(key, 'utf8') + 4
      if (bytes > maxBytes) invalid()
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid()
      result[key] = visit(descriptor.value, depth + 1)
    }
    ancestors.delete(item)
    if (bytes > maxBytes) invalid()
    return result
  }
  return visit(value, 0)
}

function stringValue(source, key, max = 32768) {
  if (!Object.hasOwn(source, key)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid()
  const value = descriptor.value
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) invalid()
  return value
}

function prepareWorkerInvocation(event, runtimeContext, parentEnv, parseContextFn) {
  // Only the handler's second argument supplies dynamic identity. Event fields
  // called env/context/workerPath never influence configuration or module loading.
  if (!runtimeContext || typeof runtimeContext !== 'object' || Array.isArray(runtimeContext)) invalid()
  const context = Object.create(null)
  for (const key of ['request_id', 'namespace', 'function_name', 'function_version', 'environment', 'environ']) {
    const value = stringValue(runtimeContext, key, key === 'environment' || key === 'environ' ? 65536 : 512)
    if (value !== undefined) context[key] = value
  }
  const requestEnv = parseRequestEnvironment(context, parseContextFn)
  const identity = resolveRequestContext(context, parseContextFn)
  const env = Object.create(null)
  for (const key of [...CONFIG_KEYS, ...SYSTEM_KEYS]) {
    const value = stringValue(parentEnv, key)
    if (value !== undefined) env[key] = value
  }
  if (env.CLOUDBASE_ENV_ID && env.CLOUDBASE_ENV_ID !== identity.envId) invalid()
  const current = Object.create(null)
  for (const key of REQUEST_KEYS) {
    // Operator requests must not inherit any WeChat token, even if the platform
    // includes unrelated WX metadata. Signed operator actions use server IAM.
    if (!identity.openid && key.startsWith('WX_')) continue
    let value
    if (key === 'TCB_SOURCE' && !Object.hasOwn(context, 'environment') && Array.isArray(requestEnv[key])) {
      // The official legacy parser splits the valid "wx_client,scf" source
      // chain. Credentials/identities remain strictly strings in both formats.
      if (!requestEnv[key].every(item => typeof item === 'string' && item.length <= 512 && !item.includes('\u0000'))) invalid()
      value = requestEnv[key].join(',')
    } else value = stringValue(requestEnv, key)
    if (value !== undefined) current[key] = value
  }
  current.SCF_NAMESPACE = identity.envId
  current.TCB_ENV = identity.envId

  // SDK 3.17.2 getCredentialsOnDemand explicitly treats these three keys as
  // server IAM credentials, unlike WX_API_TOKEN/TCB_SESSIONTOKEN. SCF can inject
  // its role into the process environment only. Inherit the complete role tuple
  // ONLY for SCF, only when this request supplies none; never mix two tuples.
  const hasRole = ROLE_KEYS.some(key => Object.hasOwn(requestEnv, key))
  const roleSource = hasRole ? requestEnv : env.TENCENTCLOUD_RUNENV === 'SCF' ? parentEnv : null
  if (roleSource) {
    const role = ROLE_KEYS.map(key => stringValue(roleSource, key))
    if (role.some(Boolean)) {
      if (!role.every(value => typeof value === 'string' && value.length > 0)) invalid()
      ROLE_KEYS.forEach((key, index) => { current[key] = role[index] })
    } else if (hasRole) invalid()
  }

  // Regenerate the SDK lists from the selected current fields; legacy parser
  // arrays and hostile/unrelated names in *_CONTEXT_KEYS cannot re-add globals.
  const wxKeys = Object.keys(current).filter(key => key.startsWith('WX_'))
  if (wxKeys.length) current.WX_CONTEXT_KEYS = wxKeys.join(',')
  current.TCB_CONTEXT_KEYS = Object.keys(current).filter(key => !key.startsWith('WX_')).join(',')
  Object.assign(env, current)
  // Only the selected current context crosses the boundary; static config keys
  // stay in the independent Worker env and are never copied into event data.
  delete context.environ
  context.environment = JSON.stringify(current)
  return { env, runtimeContext: context, event: boundedClone(event === undefined ? {} : event) }
}

module.exports = { prepareWorkerInvocation, boundedClone, CONFIG_KEYS, SYSTEM_KEYS, ROLE_KEYS, REQUEST_KEYS }
