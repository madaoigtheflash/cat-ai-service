'use strict'

const crypto = require('crypto')

const OPERATIONS = new Set(['create', 'update', 'disable', 'restore', 'delete'])
const SAFE_ID = /^[A-Za-z0-9._:-]{3,160}$/

class AdminError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
}

function requireId(value, field) {
  const text = cleanText(value, 160)
  if (!SAFE_ID.test(text)) throw new AdminError('VALIDATION_ERROR', `${field} 格式无效`)
  return text
}

function inviteCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  const bytes = crypto.randomBytes(10)
  let value = ''
  for (let index = 0; index < 10; index += 1) value += alphabet[bytes[index] % alphabet.length]
  return `${value.slice(0, 5)}-${value.slice(5)}`
}

function normalizeInviteCode(value) {
  return cleanText(value, 32).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function adminInviteHash(value) {
  return crypto.createHash('sha256').update(`cat-admin-invite|${normalizeInviteCode(value)}`).digest('hex')
}

function safeCommunity(value) {
  if (!value) return null
  return {
    id: value.id,
    name: value.name,
    scope: value.scope,
    status: value.status,
    version: Math.max(0, Number(value.version) || 0),
    ownerPending: value.ownerPending === true,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deletedAt: value.deletedAt || null
  }
}

function createCore(repository, options) {
  if (!repository || typeof repository.mutateCommunity !== 'function') throw new Error('repository is required')
  const now = options && options.now ? options.now : () => new Date().toISOString()
  const randomId = options && options.randomId ? options.randomId : prefix => `${prefix}_${crypto.randomBytes(14).toString('hex')}`

  async function handle(event, context) {
    const requestId = randomId('req')
    try {
      if (context && context.openid) throw new AdminError('FORBIDDEN', '该函数不接受小程序用户调用')
      const action = cleanText(event && event.action, 40)
      if (action === 'health') return { ok: true, requestId, data: { service: 'catAdmin', schemaVersion: 1 } }
      if (action !== 'mutateCommunity') throw new AdminError('INVALID_ACTION', '不支持的管理操作')
      const operation = cleanText(event.operation, 24)
      if (!OPERATIONS.has(operation)) throw new AdminError('VALIDATION_ERROR', '小屋操作无效')
      const idempotencyKey = requireId(event.idempotencyKey, 'idempotencyKey')
      const patch = event.patch && typeof event.patch === 'object' ? event.patch : {}
      const name = cleanText(patch.name, 40)
      const scope = patch.scope === 'private' ? 'private' : 'invite'
      if (operation === 'create' && !name) throw new AdminError('VALIDATION_ERROR', '小屋名称不能为空')
      const communityId = operation === 'create'
        ? randomId('com')
        : requireId(event.communityId, 'communityId')
      const code = operation === 'create' && scope === 'invite' ? inviteCode() : ''
      const input = {
        operation,
        communityId,
        expectedVersion: Math.max(0, Number(event.expectedVersion) || 0),
        idempotencyKey,
        reason: cleanText(event.reason, 200),
        operator: 'local-cloudbase-cli',
        now: now(),
        patch: { name, scope },
        createFields: code ? { adminInviteHash: adminInviteHash(code) } : {}
      }
      const result = await repository.mutateCommunity(input)
      return {
        ok: true,
        requestId,
        data: {
          operation,
          community: safeCommunity(result.community),
          auditId: result.auditId,
          idempotent: result.idempotent === true,
          inviteCode: result.idempotent ? undefined : (code || undefined)
        }
      }
    } catch (error) {
      return {
        ok: false,
        requestId,
        error: {
          code: error && error.code || 'INTERNAL_ERROR',
          message: error instanceof AdminError ? error.message : '云端管理操作失败'
        }
      }
    }
  }

  return { handle }
}

module.exports = { AdminError, adminInviteHash, createCore, normalizeInviteCode, safeCommunity }
