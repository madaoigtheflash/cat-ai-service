'use strict'

const crypto = require('crypto')
const https = require('https')
const cloud = require('wx-server-sdk')
const { createCatIdentityCore, DomainError, templateMatchesContract } = require('./core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const REVOCATION_LEASE_MS = 5 * 60 * 1000

const COLLECTIONS = Object.freeze({
  members: 'ci_members',
  pets: 'ci_user_pet_links',
  sightingsPrivate: 'ci_sightings_private',
  sightingsPublic: 'ci_sightings_public',
  assets: 'ci_assets',
  jobs: 'ci_identity_jobs',
  templates: 'ci_identity_templates',
  assignments: 'ci_identity_assignments',
  feedback: 'ci_identity_feedback',
  identities: 'ci_cat_identities',
  relationshipEdges: 'ci_relationship_edges'
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
  const output = Object.assign({ id: value._id || value.id }, value)
  delete output._id
  return output
}

function isMissingDocument(error) {
  const text = `${error && error.code || ''} ${error && error.message || ''}`.toLowerCase()
  return text.includes('not exist') || text.includes('not found') || text.includes('document_not_exist')
}

async function getDocument(collection, id, transaction) {
  const source = transaction || db
  try {
    const response = await source.collection(collection).doc(id).get()
    const data = response && response.data
    if (!data || (Array.isArray(data) && !data.length)) return null
    return fromDocument(Array.isArray(data) ? data[0] : data)
  } catch (error) {
    if (isMissingDocument(error)) return null
    throw error
  }
}

async function queryDocuments(collection, where, limit) {
  const response = await db.collection(collection)
    .where(where || {})
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
    .get()
  return ((response && response.data) || []).map(fromDocument)
}

async function queryAllDocuments(collection, where, maxDocuments) {
  const maximum = Math.min(Math.max(Number(maxDocuments) || 2000, 1), 5000)
  const output = []
  while (output.length < maximum) {
    const batchLimit = Math.min(100, maximum - output.length)
    const response = await db.collection(collection)
      .where(where || {})
      .skip(output.length)
      .limit(batchLimit)
      .get()
    const batch = ((response && response.data) || []).map(fromDocument)
    output.push(...batch)
    if (batch.length < batchLimit) return output
  }
  throw new DomainError('RELATIONSHIP_EDGE_LIMIT', '关联关系过多，暂时无法安全恢复，请稍后重试', true)
}

async function setDocument(collection, value, transaction) {
  const source = transaction || db
  await source.collection(collection).doc(value.id).set({ data: withoutId(value) })
  return value
}

async function updateDocument(collection, id, patch, transaction) {
  const source = transaction || db
  await source.collection(collection).doc(id).update({ data: withoutId(patch) })
}

function canManage(task, membership, ownerKey, reviewerRoles) {
  return task.sightingOwnerKey === ownerKey || (reviewerRoles || []).includes(membership.role)
}

async function repairEnrollmentProjection(transaction, sightingId, template, now) {
  await updateDocument(COLLECTIONS.sightingsPrivate, sightingId, {
    identityTemplateReady: true,
    enrollmentTemplateId: template.id,
    enrollmentModelVersion: template.modelVersion,
    enrolledAt: template.createdAt || now,
    identityTemplateUpdatedAt: now,
    updatedAt: now
  }, transaction)
  const publicSighting = await getDocument(COLLECTIONS.sightingsPublic, sightingId, transaction)
  if (publicSighting) {
    await updateDocument(COLLECTIONS.sightingsPublic, sightingId, {
      identityTemplateReady: true,
      identityTemplateUpdatedAt: now,
      updatedAt: now
    }, transaction)
  }
}

class CloudRepository {
  async getMembership(communityId, ownerKey) {
    const matches = await queryDocuments(COLLECTIONS.members, { communityId, ownerKey }, 1)
    return matches[0] || null
  }

  async getSightingWithAsset(sightingId) {
    const sighting = await getDocument(COLLECTIONS.sightingsPrivate, sightingId)
    if (!sighting) return null
    const asset = await getDocument(COLLECTIONS.assets, sighting.assetId)
    return asset ? { sighting, asset } : null
  }

  async listCats(communityId) {
    const [identities, pets] = await Promise.all([
      queryDocuments(COLLECTIONS.identities, { communityId, state: 'active' }, 100),
      queryDocuments(COLLECTIONS.pets, { communityId, state: 'active' }, 100)
    ])
    const output = new Map()
    identities.forEach(item => {
      if (item.displayName) output.set(item.id, item)
    })
    pets.forEach(item => {
      if (item.displayName && !output.has(item.id)) output.set(item.id, item)
    })
    return Array.from(output.values())
  }

  async listTemplates(communityId, contract, limit) {
    const templates = await queryDocuments(
      COLLECTIONS.templates,
      {
        communityId,
        state: 'active',
        modelVersion: contract.modelVersion,
        modelSha256: contract.modelSha256,
        preprocessVersion: contract.preprocessVersion,
        cropVersion: contract.cropVersion,
        embeddingEncoding: contract.encoding,
        embeddingDimension: contract.dimension
      },
      Math.min(Number(limit) || 100, 100)
    )
    return templates.filter(item =>
      item.modelVersion === contract.modelVersion &&
      item.modelSha256 === contract.modelSha256 &&
      item.preprocessVersion === contract.preprocessVersion &&
      item.cropVersion === contract.cropVersion &&
      item.embeddingEncoding === contract.encoding &&
      Number(item.embeddingDimension) === contract.dimension
    )
  }

  async getTemplate(templateId) {
    return getDocument(COLLECTIONS.templates, templateId)
  }

  async enrollTemplate(input) {
    return db.runTransaction(async transaction => {
      const membership = await getDocument(COLLECTIONS.members, input.membershipId, transaction)
      if (!membership || membership.ownerKey !== input.actorOwnerKey ||
          membership.communityId !== input.template.communityId || membership.status !== 'active') {
        throw new DomainError('FORBIDDEN', '小屋成员权限已变化，请刷新后重试')
      }
      const sighting = await getDocument(COLLECTIONS.sightingsPrivate, input.sightingId, transaction)
      if (!sighting || sighting.communityId !== input.template.communityId ||
          sighting.ownerKey !== input.actorOwnerKey || sighting.state !== 'APPROVED') {
        throw new DomainError('SIGHTING_NOT_APPROVED', '目击状态或归属已经变化，请刷新后重试')
      }
      const linkedCatId = sighting.catId || sighting.remotePetId
      if (!sighting.remotePetId || linkedCatId !== input.catId || sighting.remotePetId !== input.remotePetId) {
        throw new DomainError('SIGHTING_LINK_CHANGED', '目击关联的猫咪已经变化，请刷新后重试')
      }
      const linkedPet = await getDocument(COLLECTIONS.pets, sighting.remotePetId, transaction)
      if (!linkedPet || linkedPet.ownerKey !== input.actorOwnerKey ||
          linkedPet.communityId !== input.template.communityId || linkedPet.state !== 'active' ||
          (linkedPet.catId || linkedPet.id) !== input.catId) {
        throw new DomainError('CAT_NOT_FOUND', '本地档案与云端猫咪的关联已经变化')
      }
      const identity = await getDocument(COLLECTIONS.identities, input.catId, transaction)
      if (!identity || identity.communityId !== input.template.communityId || identity.state !== 'active') {
        throw new DomainError('CAT_NOT_FOUND', '标准猫咪身份不存在或已停用')
      }
      const existing = await getDocument(COLLECTIONS.templates, input.template.id, transaction)
      if (existing) {
        if (existing.sightingId !== input.sightingId || existing.catId !== input.catId ||
            !templateMatchesContract(existing, input.contract) ||
            (existing.enrollmentRequestHash && existing.enrollmentRequestHash !== input.requestHash)) {
          throw new DomainError('ENROLLMENT_CONFLICT', '识别模板与当前目击不一致')
        }
        const repaired = existing.enrollmentRequestHash
          ? existing
          : Object.assign({}, existing, {
            enrollmentRequestHash: input.requestHash,
            updatedAt: input.now
          })
        if (!existing.enrollmentRequestHash) {
          await setDocument(COLLECTIONS.templates, repaired, transaction)
        }
        await repairEnrollmentProjection(transaction, input.sightingId, repaired, input.now)
        return repaired
      }
      if (!templateMatchesContract(input.template, input.contract) ||
          input.template.enrollmentRequestHash !== input.requestHash) {
        throw new DomainError('ENROLLMENT_CONFLICT', '新识别模板的版本或请求校验不一致')
      }
      await setDocument(COLLECTIONS.templates, input.template, transaction)
      await repairEnrollmentProjection(transaction, input.sightingId, input.template, input.now)
      return input.template
    })
  }

  async getJob(taskId) {
    return getDocument(COLLECTIONS.jobs, taskId)
  }

  async createJob(job, expectedLeaseToken) {
    return db.runTransaction(async transaction => {
      const existing = await getDocument(COLLECTIONS.jobs, job.id, transaction)
      if (existing) {
        const deadline = Date.parse(existing.leaseUntil || existing.updatedAt || existing.createdAt || '')
        const canReclaim = expectedLeaseToken && existing.state === 'PROCESSING' &&
          existing.leaseToken === expectedLeaseToken && Number.isFinite(deadline) && deadline <= Date.parse(job.updatedAt)
        if (!canReclaim) return existing
        const reclaimed = Object.assign({}, job, {
          createdAt: existing.createdAt,
          version: existing.version
        })
        await setDocument(COLLECTIONS.jobs, reclaimed, transaction)
        return reclaimed
      }
      await setDocument(COLLECTIONS.jobs, job, transaction)
      return job
    })
  }

  async completeJob(job, leaseToken) {
    return db.runTransaction(async transaction => {
      const current = await getDocument(COLLECTIONS.jobs, job.id, transaction)
      if (!current || current.state !== 'PROCESSING' || current.leaseToken !== leaseToken) {
        throw new DomainError('TASK_LEASE_LOST', '识别任务已由其他请求接管，请刷新后查看', true)
      }
      const completed = Object.assign({}, job)
      delete completed.leaseToken
      delete completed.leaseUntil
      await setDocument(COLLECTIONS.jobs, completed, transaction)
      return completed
    })
  }

  async confirmTask(input) {
    return db.runTransaction(async transaction => {
      const task = await getDocument(COLLECTIONS.jobs, input.taskId, transaction)
      if (!task) throw new DomainError('NOT_FOUND', '识别任务不存在')
      const membership = await getDocument(COLLECTIONS.members, input.membershipId, transaction)
      if (!membership || membership.ownerKey !== input.actorOwnerKey ||
          membership.communityId !== task.communityId || membership.status !== 'active' ||
          !canManage(task, membership, input.actorOwnerKey, input.reviewerRoles)) {
        throw new DomainError('FORBIDDEN', '任务权限已经变化，请刷新后重试')
      }
      if (['COMPLETED', 'NEEDS_MORE_EVIDENCE'].includes(task.state) && task.decisionHash === input.decisionHash) {
        return task
      }
      if (task.state !== input.expectedState) throw new DomainError('STATE_CONFLICT', '当前任务状态不能确认')
      if (task.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', '任务已更新，请刷新后再确认')

      if (input.assignment) {
        const currentAssignment = await getDocument(COLLECTIONS.assignments, input.assignment.id, transaction)
        if (currentAssignment && currentAssignment.state === 'active' && currentAssignment.taskId !== task.id) {
          throw new DomainError('SIGHTING_ALREADY_ASSIGNED', '这条目击已由另一项确认关联，请刷新工作区后查看')
        }
        const sighting = await getDocument(COLLECTIONS.sightingsPrivate, task.sightingId, transaction)
        if (!sighting || sighting.communityId !== task.communityId || sighting.state !== 'APPROVED') {
          throw new DomainError('SIGHTING_NOT_APPROVED', '目击状态已经变化，请刷新后重试')
        }
        if (sighting.remotePetId || (sighting.identityCatId && sighting.identityTaskId !== task.id)) {
          throw new DomainError('SIGHTING_ALREADY_LINKED', '这条目击已经关联猫咪，请刷新工作区后查看')
        }
      }

      if (input.identity) {
        const existingIdentity = await getDocument(COLLECTIONS.identities, input.identity.id, transaction)
        if (existingIdentity && (existingIdentity.communityId !== task.communityId || existingIdentity.state !== 'active')) {
          throw new DomainError('CAT_NOT_FOUND', '所选猫咪不属于当前社区')
        }
        if (!existingIdentity && input.decision.type === 'same_cat') {
          const linkedPet = await getDocument(COLLECTIONS.pets, input.identity.id, transaction)
          if (!linkedPet || linkedPet.communityId !== task.communityId || linkedPet.state !== 'active') {
            throw new DomainError('CAT_NOT_FOUND', '所选猫咪不存在于当前社区')
          }
        }
        const identity = existingIdentity
          ? Object.assign({}, existingIdentity, { displayName: existingIdentity.displayName, updatedAt: input.now })
          : input.identity
        await setDocument(COLLECTIONS.identities, identity, transaction)
      }
      if (input.assignment) {
        await setDocument(COLLECTIONS.assignments, input.assignment, transaction)
        await updateDocument(COLLECTIONS.sightingsPrivate, task.sightingId, {
          identityCatId: input.assignment.catId,
          identityCat: {
            catId: input.assignment.catId,
            displayName: input.assignment.displayName
          },
          identityTaskId: task.id,
          updatedAt: input.now
        }, transaction)
        const publicSighting = await getDocument(COLLECTIONS.sightingsPublic, task.sightingId, transaction)
        if (publicSighting) {
          await updateDocument(COLLECTIONS.sightingsPublic, task.sightingId, {
            identityCatId: input.assignment.catId,
            identityCat: {
              catId: input.assignment.catId,
              displayName: input.assignment.displayName
            },
            identityTaskId: task.id,
            updatedAt: input.now
          }, transaction)
        }
      }
      if (input.template) await setDocument(COLLECTIONS.templates, input.template, transaction)
      await setDocument(COLLECTIONS.feedback, input.feedback, transaction)

      const nextTask = Object.assign({}, task, {
        state: input.nextState,
        version: task.version + 1,
        decisionType: input.decision.type,
        decisionHash: input.decisionHash,
        linkedCatId: input.assignment ? input.assignment.catId : null,
        linkedCatName: input.assignment ? input.assignment.displayName : null,
        assignmentId: input.assignment ? input.assignment.id : null,
        templateId: input.template ? input.template.id : null,
        confirmedByOwnerKey: input.actorOwnerKey,
        confirmedAt: input.now,
        notice: input.nextState === 'NEEDS_MORE_EVIDENCE'
          ? '已记录“无法判断”，没有更改任何猫咪归属。'
          : '已按人工确认保存归属；模型候选本身从未自动合并档案。',
        updatedAt: input.now
      })
      delete nextTask.embeddingBase64
      delete nextTask.embeddingSha256
      await setDocument(COLLECTIONS.jobs, nextTask, transaction)
      return nextTask
    })
  }

  async recoverExpiredIdentityRevocations(now) {
    const nowMs = Date.parse(now)
    if (!Number.isFinite(nowMs)) return 0
    const expired = await queryDocuments(COLLECTIONS.identities, {
      state: 'revoking',
      revocationExpiresAt: _.lte(now)
    }, 20)
    let recovered = 0
    for (const candidate of expired) {
      if (!candidate.revocationSourceTaskId) continue
      const changed = await this.compensateIdentityRevocation({
        taskId: candidate.revocationSourceTaskId,
        now
      }, {
        identityId: candidate.id,
        revocationToken: candidate.revocationToken
      }, { requireExpired: true })
      if (changed) recovered += 1
    }
    return recovered
  }

  async rollbackIdentityReviewEdges(input) {
    const [edgesByA, edgesByB] = await Promise.all([
      queryAllDocuments(COLLECTIONS.relationshipEdges, {
        communityId: input.communityId,
        state: 'needs_review',
        catAId: input.identityId
      }, 2000),
      queryAllDocuments(COLLECTIONS.relationshipEdges, {
        communityId: input.communityId,
        state: 'needs_review',
        catBId: input.identityId
      }, 2000)
    ])
    const candidates = new Map()
    edgesByA.concat(edgesByB).forEach(edge => {
      if (edge.needsReviewSourceTaskId === input.taskId &&
          edge.needsReviewCatId === input.identityId &&
          edge.identityReviewAudit && edge.identityReviewAudit.previousState === 'active') {
        candidates.set(edge.id, edge)
      }
    })
    const patch = {
      state: 'active',
      needsReviewReason: null,
      needsReviewCatId: null,
      needsReviewSourceTaskId: null,
      needsReviewAt: null,
      identityReviewAudit: null,
      identityReviewRollbackAudit: {
        reason: 'identity_revocation_compensated',
        catId: input.identityId,
        sourceTaskId: input.taskId,
        rolledBackAt: input.now
      },
      updatedAt: input.now
    }
    for (const candidate of candidates.values()) {
      await db.runTransaction(async transaction => {
        const edge = await getDocument(COLLECTIONS.relationshipEdges, candidate.id, transaction)
        if (!edge || edge.communityId !== input.communityId || edge.state !== 'needs_review' ||
            (edge.catAId !== input.identityId && edge.catBId !== input.identityId) ||
            edge.needsReviewSourceTaskId !== input.taskId || edge.needsReviewCatId !== input.identityId ||
            !edge.identityReviewAudit || edge.identityReviewAudit.previousState !== 'active') return
        await updateDocument(COLLECTIONS.relationshipEdges, edge.id, patch, transaction)
      })
    }
  }

  async compensateIdentityRevocation(input, identityRevocation, options) {
    if (!identityRevocation) return false
    const settings = options || {}
    const nowMs = Date.parse(input.now)
    try {
      const plan = await db.runTransaction(async transaction => {
        const identity = await getDocument(COLLECTIONS.identities, identityRevocation.identityId, transaction)
        if (!identity || identity.state !== 'revoking' ||
            identity.revocationToken !== identityRevocation.revocationToken) return false
        if (settings.requireExpired && (!Number.isFinite(nowMs) ||
            !Number.isFinite(Date.parse(identity.revocationExpiresAt)) ||
            Date.parse(identity.revocationExpiresAt) > nowMs)) return false
        const task = await getDocument(COLLECTIONS.jobs, input.taskId, transaction)
        // A network error can arrive after the final transaction committed.
        // Never resurrect an identity whose task is already durably undone.
        if (task && task.state === 'UNDONE') {
          await updateDocument(COLLECTIONS.identities, identity.id, {
            state: 'revoked',
            revocationToken: null,
            revocationPhase: null,
            revocationExpiresAt: null,
            revocationRecoveredAt: input.now,
            revocationRecoveryReason: 'task_already_undone',
            updatedAt: input.now
          }, transaction)
          return { terminal: true }
        }
        const compensationToken = identity.revocationPhase === 'compensating'
          ? identity.revocationToken
          : crypto.createHash('sha256')
            .update(`identity-compensate|${identity.id}|${input.taskId}|${identity.revocationToken}`)
            .digest('hex')
        await updateDocument(COLLECTIONS.identities, identity.id, {
          revocationToken: compensationToken,
          revocationPhase: 'compensating',
          revocationExpiresAt: new Date(nowMs + REVOCATION_LEASE_MS).toISOString(),
          updatedAt: input.now
        }, transaction)
        return {
          terminal: false,
          identityId: identity.id,
          communityId: identity.communityId,
          taskId: input.taskId,
          compensationToken
        }
      })
      if (!plan) return false
      if (plan.terminal) return true

      // Only edges carrying the exact audit marker written by this task are
      // restored. Unrelated needs_review edges remain untouched.
      await this.rollbackIdentityReviewEdges({
        communityId: plan.communityId,
        taskId: plan.taskId,
        identityId: plan.identityId,
        now: input.now
      })
      return await db.runTransaction(async transaction => {
        const identity = await getDocument(COLLECTIONS.identities, plan.identityId, transaction)
        if (!identity || identity.state !== 'revoking' ||
            identity.revocationPhase !== 'compensating' ||
            identity.revocationToken !== plan.compensationToken) return false
        const task = await getDocument(COLLECTIONS.jobs, plan.taskId, transaction)
        if (task && task.state === 'UNDONE') {
          throw new DomainError('IDENTITY_COMPENSATION_CONFLICT', '撤销任务状态已完成，不能恢复猫咪身份', true)
        }
        await updateDocument(COLLECTIONS.identities, identity.id, {
          state: 'active',
          revocationToken: null,
          revocationPhase: null,
          revocationSourceTaskId: null,
          revocationStartedAt: null,
          revocationExpiresAt: null,
          revocationCompensatedAt: input.now,
          revocationCompensationReason: settings.requireExpired ? 'lease_expired' : 'operation_failed',
          updatedAt: input.now
        }, transaction)
        return true
      })
    } catch (error) {
      // Best effort only. The expiry reconciler is the second safety net when
      // the database itself is unavailable during compensation.
      return false
    }
  }

  async undoTask(input) {
    let identityRevocation = null
    let stagedTask = null
    try {
    if (input.revokeIdentityId) {
      const revocationToken = crypto.createHash('sha256')
        .update(`identity-revoke|${input.taskId}|${input.expectedVersion}`)
        .digest('hex')
      // Keep the deterministic CAS tuple before awaiting the stage transaction;
      // it can still compensate if the commit succeeds but its response is lost.
      identityRevocation = { identityId: input.revokeIdentityId, revocationToken }
      const staged = await db.runTransaction(async transaction => {
        const task = await getDocument(COLLECTIONS.jobs, input.taskId, transaction)
        if (!task) throw new DomainError('NOT_FOUND', '识别任务不存在')
        const membership = await getDocument(COLLECTIONS.members, input.membershipId, transaction)
        if (!membership || membership.ownerKey !== input.actorOwnerKey ||
            membership.communityId !== task.communityId || membership.status !== 'active' ||
            !canManage(task, membership, input.actorOwnerKey, input.reviewerRoles)) {
          throw new DomainError('FORBIDDEN', '任务权限已经变化，请刷新后重试')
        }
        if (task.state === 'UNDONE') return { task, identityRevocation: null }
        if (!['COMPLETED', 'NEEDS_MORE_EVIDENCE'].includes(task.state)) {
          throw new DomainError('STATE_CONFLICT', '只有已确认的任务可以撤销')
        }
        if (task.version !== input.expectedVersion) {
          throw new DomainError('VERSION_CONFLICT', '任务已更新，请刷新后再撤销')
        }
        const identity = await getDocument(COLLECTIONS.identities, input.revokeIdentityId, transaction)
        if (!identity || identity.sourceTaskId !== task.id ||
            !['active', 'revoking'].includes(identity.state)) {
          return { task, identityRevocation: null }
        }
        if (identity.state === 'revoking' && identity.revocationToken !== revocationToken) {
          throw new DomainError('IDENTITY_REVOCATION_CONFLICT', '猫咪身份正在由另一项操作处理，请稍后重试', true)
        }
        if (identity.state === 'active') {
          await updateDocument(COLLECTIONS.identities, identity.id, {
            state: 'revoking',
            revocationToken,
            revocationPhase: 'invalidating_edges',
            revocationSourceTaskId: task.id,
            revocationStartedAt: input.now,
            revocationExpiresAt: new Date(Date.parse(input.now) + REVOCATION_LEASE_MS).toISOString(),
            updatedAt: input.now
          }, transaction)
        }
        return {
          task,
          identityRevocation: { identityId: identity.id, revocationToken }
        }
      })
      stagedTask = staged.task
      identityRevocation = staged.identityRevocation
      if (stagedTask.state === 'UNDONE') return stagedTask

      if (identityRevocation) {
        // CloudBase transactions do not support where/skip scans. The identity
        // is temporarily non-active first, which makes concurrent confirmation
        // and relationship voting fail closed while these bounded reads run.
        const [otherAssignments, otherTemplates] = await Promise.all([
          queryDocuments(COLLECTIONS.assignments, {
            communityId: stagedTask.communityId,
            catId: identityRevocation.identityId,
            state: 'active'
          }, 100),
          queryDocuments(COLLECTIONS.templates, {
            communityId: stagedTask.communityId,
            catId: identityRevocation.identityId,
            state: 'active'
          }, 100)
        ])
        const hasOtherAssignment = otherAssignments.some(item => item.id !== stagedTask.assignmentId)
        const hasOtherTemplate = otherTemplates.some(item => item.id !== stagedTask.templateId)
        if (hasOtherAssignment || hasOtherTemplate) {
          await db.runTransaction(async transaction => {
            const identity = await getDocument(COLLECTIONS.identities, identityRevocation.identityId, transaction)
            if (identity && identity.state === 'revoking' &&
                identity.revocationToken === identityRevocation.revocationToken) {
              await updateDocument(COLLECTIONS.identities, identity.id, {
                state: 'active',
                revocationToken: null,
                revocationPhase: null,
                revocationSourceTaskId: null,
                revocationStartedAt: null,
                revocationExpiresAt: null,
                updatedAt: input.now
              }, transaction)
            }
          })
          identityRevocation = null
        } else {
          const edgePatch = {
            state: 'needs_review',
            needsReviewReason: 'canonical_identity_revoked',
            needsReviewCatId: identityRevocation.identityId,
            needsReviewSourceTaskId: stagedTask.id,
            needsReviewAt: input.now,
            identityReviewAudit: {
              previousState: 'active',
              reason: 'canonical_identity_revoked',
              catId: identityRevocation.identityId,
              sourceTaskId: stagedTask.id,
              triggeredByOwnerKey: input.actorOwnerKey,
              triggeredAt: input.now
            },
            updatedAt: input.now
          }
          await db.collection(COLLECTIONS.relationshipEdges).where({
            communityId: stagedTask.communityId,
            state: 'active',
            catAId: identityRevocation.identityId
          }).update({ data: edgePatch })
          await db.collection(COLLECTIONS.relationshipEdges).where({
            communityId: stagedTask.communityId,
            state: 'active',
            catBId: identityRevocation.identityId
          }).update({ data: edgePatch })
        }
      }
    }

    return await db.runTransaction(async transaction => {
      const task = await getDocument(COLLECTIONS.jobs, input.taskId, transaction)
      if (!task) throw new DomainError('NOT_FOUND', '识别任务不存在')
      const membership = await getDocument(COLLECTIONS.members, input.membershipId, transaction)
      if (!membership || membership.ownerKey !== input.actorOwnerKey ||
          membership.communityId !== task.communityId || membership.status !== 'active' ||
          !canManage(task, membership, input.actorOwnerKey, input.reviewerRoles)) {
        throw new DomainError('FORBIDDEN', '任务权限已经变化，请刷新后重试')
      }
      if (task.state === 'UNDONE') return task
      if (!['COMPLETED', 'NEEDS_MORE_EVIDENCE'].includes(task.state)) {
        throw new DomainError('STATE_CONFLICT', '只有已确认的任务可以撤销')
      }
      if (task.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', '任务已更新，请刷新后再撤销')

      if (identityRevocation) {
        const identity = await getDocument(COLLECTIONS.identities, identityRevocation.identityId, transaction)
        if (!identity || identity.state !== 'revoking' ||
            identity.revocationToken !== identityRevocation.revocationToken || identity.sourceTaskId !== task.id) {
          throw new DomainError('IDENTITY_REVOCATION_CONFLICT', '猫咪身份撤销状态已变化，请刷新后重试', true)
        }
        await updateDocument(COLLECTIONS.identities, identity.id, {
          state: 'revoked',
          revocationToken: null,
          revocationPhase: null,
          revocationExpiresAt: null,
          revokedByOwnerKey: input.actorOwnerKey,
          revokedAt: input.now,
          updatedAt: input.now
        }, transaction)
      }
      if (task.assignmentId) {
        const assignment = await getDocument(COLLECTIONS.assignments, task.assignmentId, transaction)
        if (assignment && assignment.taskId === task.id && assignment.state === 'active') {
          await updateDocument(COLLECTIONS.assignments, assignment.id, {
            state: 'revoked',
            revokedByOwnerKey: input.actorOwnerKey,
            revokedAt: input.now,
            updatedAt: input.now
          }, transaction)
        }
      }
      if (task.templateId) {
        const template = await getDocument(COLLECTIONS.templates, task.templateId, transaction)
        if (template && template.assignmentId === task.assignmentId && template.state === 'active') {
          await updateDocument(COLLECTIONS.templates, template.id, {
            state: 'revoked',
            revokedByOwnerKey: input.actorOwnerKey,
            revokedAt: input.now,
            updatedAt: input.now
          }, transaction)
        }
      }
      const sighting = await getDocument(COLLECTIONS.sightingsPrivate, task.sightingId, transaction)
      if (sighting && sighting.identityTaskId === task.id) {
        await updateDocument(COLLECTIONS.sightingsPrivate, sighting.id, {
          identityCatId: null,
          identityCat: null,
          identityTaskId: null,
          updatedAt: input.now
        }, transaction)
        const publicSighting = await getDocument(COLLECTIONS.sightingsPublic, sighting.id, transaction)
        if (publicSighting && publicSighting.identityTaskId === task.id) {
          await updateDocument(COLLECTIONS.sightingsPublic, sighting.id, {
            identityCatId: null,
            identityCat: null,
            identityTaskId: null,
            updatedAt: input.now
          }, transaction)
        }
      }
      await setDocument(COLLECTIONS.feedback, input.feedback, transaction)
      const nextTask = Object.assign({}, task, {
        state: 'UNDONE',
        version: task.version + 1,
        revokedAssignmentId: task.assignmentId || null,
        revokedTemplateId: task.templateId || null,
        assignmentId: null,
        templateId: null,
        linkedCatId: null,
        linkedCatName: null,
        undoneByOwnerKey: input.actorOwnerKey,
        undoneAt: input.now,
        notice: '本次人工归属已撤销；对应模板和归属记录已停用。',
        updatedAt: input.now
      })
      await setDocument(COLLECTIONS.jobs, nextTask, transaction)
      return nextTask
    })
    } catch (error) {
      await this.compensateIdentityRevocation(input, identityRevocation)
      throw error
    }
  }
}

function workerSignature(secret, method, path, timestamp, nonce, body) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex')
  const canonical = `${method.toUpperCase()}|${path}|${timestamp}|${nonce}|${bodyHash}`
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex')
}

function createWorkerClient(options) {
  const settings = options || {}
  const baseUrl = String(settings.baseUrl || '').trim()
  const secret = String(settings.secret || '')
  const configured = Boolean(baseUrl && Buffer.byteLength(secret, 'utf8') >= 32)
  const timeoutMs = Math.min(Math.max(Number(settings.timeoutMs) || 20000, 1000), 50000)
  return {
    configured,
    async process(payload) {
      if (!configured) throw new DomainError('CONFIG_ERROR', '同猫识别 Worker 尚未完整配置')
      let endpoint
      try {
        endpoint = new URL(baseUrl)
      } catch (error) {
        throw new DomainError('CONFIG_ERROR', 'REID_WORKER_URL格式无效')
      }
      if (endpoint.protocol !== 'https:') {
        throw new DomainError('CONFIG_ERROR', 'REID_WORKER_URL必须使用HTTPS')
      }
      endpoint.pathname = '/internal/v1/reid/process'
      endpoint.search = ''
      endpoint.hash = ''
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const timestamp = String(Math.floor(Date.now() / 1000))
      const nonce = crypto.randomBytes(16).toString('hex')
      const signature = workerSignature(secret, 'POST', endpoint.pathname, timestamp, nonce, body)
      return new Promise((resolve, reject) => {
        let settled = false
        const resolveOnce = value => {
          if (settled) return
          settled = true
          resolve(value)
        }
        const rejectOnce = error => {
          if (settled) return
          settled = true
          reject(error instanceof DomainError
            ? error
            : new DomainError('REID_UNAVAILABLE', '同猫识别服务连接失败', true))
        }
        const request = https.request(endpoint, {
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            'X-CatAI-Timestamp': timestamp,
            'X-CatAI-Nonce': nonce,
            'X-CatAI-Signature': signature
          }
        }, response => {
          const chunks = []
          let size = 0
          response.on('data', chunk => {
            size += chunk.length
            if (size <= 2 * 1024 * 1024) chunks.push(chunk)
            else request.destroy(new Error('worker response too large'))
          })
          response.on('end', () => {
            if (settled) return
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (response.statusCode < 200 || response.statusCode >= 300 || !result || result.ok !== true) {
                rejectOnce(new DomainError('REID_UNAVAILABLE', '同猫识别服务暂时不可用', true))
                return
              }
              resolveOnce(result)
            } catch (error) {
              rejectOnce(error instanceof DomainError
                ? error
                : new DomainError('REID_UNAVAILABLE', '同猫识别服务响应无效', true))
            }
          })
          response.on('aborted', () => rejectOnce(new DomainError('REID_UNAVAILABLE', '同猫识别服务响应中断', true)))
          response.on('error', rejectOnce)
          response.on('close', () => {
            if (!response.complete) rejectOnce(new DomainError('REID_UNAVAILABLE', '同猫识别服务响应中断', true))
          })
        })
        request.on('timeout', () => request.destroy(new Error('worker timeout')))
        request.on('error', rejectOnce)
        request.end(body)
      })
    }
  }
}

const media = {
  async getApprovedUrl(fileID) {
    const response = await cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 300 }] })
    const item = response && response.fileList && response.fileList[0]
    if (!item || (item.status && item.status !== 0) || !item.tempFileURL) return ''
    return item.tempFileURL
  }
}

const worker = createWorkerClient({
  baseUrl: process.env.REID_WORKER_URL || '',
  secret: process.env.REID_WORKER_HMAC_SECRET || '',
  timeoutMs: process.env.REID_WORKER_TIMEOUT_MS || 20000
})

const core = createCatIdentityCore({
  repository: new CloudRepository(),
  media,
  worker,
  ownerSecret: process.env.CAT_ONLINE_OWNER_SECRET || '',
  ownerKeyVersion: process.env.CAT_ONLINE_OWNER_KEY_VERSION || 'v1'
})

exports.main = async event => {
  const context = cloud.getWXContext()
  const result = await core.handle(event || {}, { openid: context && context.OPENID })
  if (!result.ok) {
    console.warn(JSON.stringify({
      action: String(event && event.action || '').slice(0, 40),
      requestId: result.requestId,
      errorCode: result.error && result.error.code
    }))
  }
  return result
}

exports.COLLECTIONS = COLLECTIONS
exports.CloudRepository = CloudRepository
exports.createWorkerClient = createWorkerClient
exports.workerSignature = workerSignature
