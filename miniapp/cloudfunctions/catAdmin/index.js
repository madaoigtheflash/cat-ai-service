'use strict'

const cloud = require('wx-server-sdk')
const { AdminError, createCore } = require('./core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COLLECTIONS = Object.freeze({
  communities: 'ci_communities',
  audits: 'ci_admin_audit_logs'
})

function withoutId(value) {
  const output = {}
  Object.keys(value || {}).forEach(key => {
    if (key !== 'id' && key !== '_id' && value[key] !== undefined) output[key] = value[key]
  })
  return output
}

function fromDocument(value) {
  if (!value) return null
  return Object.assign({ id: value._id || value.id }, value, { _id: undefined })
}

function missing(error) {
  const text = `${error && error.code || ''} ${error && error.message || ''}`.toLowerCase()
  return text.includes('not exist') || text.includes('not found') || text.includes('document_not_exist')
}

async function getDocument(collection, id, transaction) {
  try {
    const response = await (transaction || db).collection(collection).doc(id).get()
    const data = response && response.data
    if (!data || (Array.isArray(data) && !data.length)) return null
    return fromDocument(Array.isArray(data) ? data[0] : data)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

async function setDocument(collection, value, transaction) {
  await (transaction || db).collection(collection).doc(value.id).set({ data: withoutId(value) })
}

class Repository {
  async mutateCommunity(input) {
    return db.runTransaction(async transaction => {
      const auditId = `audit_${input.idempotencyKey}`
      const priorAudit = await getDocument(COLLECTIONS.audits, auditId, transaction)
      if (priorAudit) {
        return { community: priorAudit.after, auditId, idempotent: true }
      }

      const before = await getDocument(COLLECTIONS.communities, input.communityId, transaction)
      if (input.operation === 'create' && before) throw new AdminError('CONFLICT', '小屋 ID 已存在')
      if (input.operation !== 'create' && !before) throw new AdminError('NOT_FOUND', '小屋不存在')
      const currentVersion = before ? Math.max(0, Number(before.version) || 0) : 0
      if (input.operation !== 'create' && currentVersion !== input.expectedVersion) {
        throw new AdminError('VERSION_CONFLICT', '小屋数据已变化，请刷新后重试')
      }

      let after
      if (input.operation === 'create') {
        after = Object.assign({
          id: input.communityId,
          name: input.patch.name,
          scope: input.patch.scope,
          status: 'active',
          version: 1,
          managedByLocalAdmin: true,
          ownerPending: true,
          createdAt: input.now,
          updatedAt: input.now
        }, input.createFields)
      } else {
        after = Object.assign({}, before, { version: currentVersion + 1, updatedAt: input.now })
        if (input.operation === 'update') {
          if (!input.patch.name) throw new AdminError('VALIDATION_ERROR', '小屋名称不能为空')
          after.name = input.patch.name
          after.scope = input.patch.scope
        } else if (input.operation === 'disable') {
          if (before.status !== 'active') throw new AdminError('STATE_CONFLICT', '只有活跃小屋可以停用')
          after.status = 'disabled'
          after.disabledAt = input.now
        } else if (input.operation === 'restore') {
          if (!['disabled', 'deleted'].includes(before.status)) throw new AdminError('STATE_CONFLICT', '当前小屋无需恢复')
          after.status = 'active'
          delete after.disabledAt
          delete after.deletedAt
        } else if (input.operation === 'delete') {
          if (before.status === 'deleted') throw new AdminError('STATE_CONFLICT', '小屋已经删除')
          after.status = 'deleted'
          after.deletedAt = input.now
        }
      }

      const audit = {
        id: auditId,
        entityType: 'community',
        entityId: input.communityId,
        operation: input.operation,
        operator: input.operator,
        reason: input.reason,
        before: before ? { id: before.id, name: before.name, scope: before.scope, status: before.status, version: currentVersion } : null,
        after: { id: after.id, name: after.name, scope: after.scope, status: after.status, version: after.version },
        result: 'SUCCESS',
        createdAt: input.now
      }
      await setDocument(COLLECTIONS.communities, after, transaction)
      await setDocument(COLLECTIONS.audits, audit, transaction)
      return { community: after, auditId, idempotent: false }
    })
  }
}

const core = createCore(new Repository())

exports.main = async event => {
  const context = cloud.getWXContext() || {}
  return core.handle(event || {}, { openid: context.OPENID || '' })
}

exports.COLLECTIONS = COLLECTIONS
exports.Repository = Repository
