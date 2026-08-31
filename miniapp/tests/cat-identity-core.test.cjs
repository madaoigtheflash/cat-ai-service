'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const {
  CONTRACT,
  DomainError,
  createCatIdentityCore,
  ownerKeyFromOpenId,
  templateMatchesContract
} = require('../cloudfunctions/catIdentity/core')

const SECRET = 'cat-identity-owner-secret-at-least-32-bytes'
const NOW = Date.parse('2026-08-28T08:00:00.000Z')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function unitEmbedding() {
  const values = new Float32Array(512)
  values[0] = 1
  const bytes = Buffer.from(values.buffer)
  return {
    data: bytes.toString('base64'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  }
}

class MemoryRepository {
  constructor() {
    this.memberships = new Map()
    this.sightings = new Map()
    this.publicSightings = new Map()
    this.assets = new Map()
    this.cats = new Map()
    this.templates = new Map()
    this.jobs = new Map()
    this.assignments = new Map()
    this.identities = new Map()
    this.feedback = new Map()
    this.relationshipEdges = new Map()
    this.injectUndoFailureAfterStage = false
  }

  async getMembership(communityId, ownerKey) {
    return clone(this.memberships.get(`${communityId}|${ownerKey}`) || null)
  }

  async getSightingWithAsset(sightingId) {
    const sighting = this.sightings.get(sightingId)
    const asset = sighting && this.assets.get(sighting.assetId)
    return sighting && asset ? { sighting: clone(sighting), asset: clone(asset) } : null
  }

  async listCats(communityId) {
    return Array.from(this.cats.values()).concat(Array.from(this.identities.values()))
      .filter(item => item.communityId === communityId && item.state === 'active')
      .map(clone)
  }

  async listTemplates(communityId) {
    return Array.from(this.templates.values()).filter(item => item.communityId === communityId && item.state === 'active').map(clone)
  }

  async getTemplate(templateId) {
    return clone(this.templates.get(templateId) || null)
  }

  async enrollTemplate(input) {
    const membership = this.memberships.get(`${input.template.communityId}|${input.actorOwnerKey}`)
    if (!membership || membership.id !== input.membershipId || membership.status !== 'active') {
      throw new DomainError('FORBIDDEN', 'membership')
    }
    const sighting = this.sightings.get(input.sightingId)
    if (!sighting || sighting.ownerKey !== input.actorOwnerKey || sighting.state !== 'APPROVED' ||
        sighting.remotePetId !== input.remotePetId || (sighting.catId || sighting.remotePetId) !== input.catId) {
      throw new DomainError('SIGHTING_LINK_CHANGED', 'linked')
    }
    const pet = this.cats.get(input.remotePetId)
    if (!pet || pet.ownerKey !== input.actorOwnerKey || (pet.catId || pet.id) !== input.catId) {
      throw new DomainError('CAT_NOT_FOUND', 'pet')
    }
    const existing = this.templates.get(input.template.id)
    let saved
    if (existing) {
      if (existing.sightingId !== input.sightingId || existing.catId !== input.catId ||
          !templateMatchesContract(existing, input.contract) ||
          (existing.enrollmentRequestHash && existing.enrollmentRequestHash !== input.requestHash)) {
        throw new DomainError('ENROLLMENT_CONFLICT', 'template conflict')
      }
      saved = clone(existing)
      if (!saved.enrollmentRequestHash) saved.enrollmentRequestHash = input.requestHash
      this.templates.set(saved.id, clone(saved))
    } else {
      if (!templateMatchesContract(input.template, input.contract) ||
          input.template.enrollmentRequestHash !== input.requestHash) {
        throw new DomainError('ENROLLMENT_CONFLICT', 'new template conflict')
      }
      saved = clone(input.template)
      this.templates.set(saved.id, clone(saved))
    }
    Object.assign(sighting, {
      identityTemplateReady: true,
      enrollmentTemplateId: saved.id,
      enrollmentModelVersion: saved.modelVersion,
      enrolledAt: input.now
    })
    const publicSighting = this.publicSightings.get(input.sightingId)
    if (publicSighting) publicSighting.identityTemplateReady = true
    return clone(saved)
  }

  async getJob(taskId) {
    return clone(this.jobs.get(taskId) || null)
  }

  async createJob(job, expectedLeaseToken) {
    const existing = this.jobs.get(job.id)
    if (existing) {
      const deadline = Date.parse(existing.leaseUntil || existing.updatedAt || existing.createdAt || '')
      const canReclaim = expectedLeaseToken && existing.state === 'PROCESSING' &&
        existing.leaseToken === expectedLeaseToken && Number.isFinite(deadline) && deadline <= Date.parse(job.updatedAt)
      if (!canReclaim) return clone(existing)
      const reclaimed = Object.assign({}, clone(job), { createdAt: existing.createdAt, version: existing.version })
      this.jobs.set(job.id, reclaimed)
      return clone(reclaimed)
    }
    this.jobs.set(job.id, clone(job))
    return clone(job)
  }

  async completeJob(job, leaseToken) {
    const current = this.jobs.get(job.id)
    if (!current || current.state !== 'PROCESSING' || current.leaseToken !== leaseToken) {
      throw new DomainError('TASK_LEASE_LOST', 'lease')
    }
    const completed = clone(job)
    delete completed.leaseToken
    delete completed.leaseUntil
    this.jobs.set(completed.id, completed)
    return clone(completed)
  }

  async confirmTask(input) {
    const task = this.jobs.get(input.taskId)
    if (!task) throw new DomainError('NOT_FOUND', 'missing')
    if (task.state !== input.expectedState || task.version !== input.expectedVersion) {
      throw new DomainError('VERSION_CONFLICT', 'version')
    }
    if (input.assignment) {
      const current = this.assignments.get(input.assignment.id)
      if (current && current.state === 'active' && current.taskId !== task.id) {
        throw new DomainError('SIGHTING_ALREADY_ASSIGNED', 'assigned')
      }
      const sighting = this.sightings.get(task.sightingId)
      if (sighting.remotePetId || (sighting.identityCatId && sighting.identityTaskId !== task.id)) {
        throw new DomainError('SIGHTING_ALREADY_LINKED', 'linked')
      }
    }
    if (input.identity) {
      const existing = this.identities.get(input.identity.id)
      this.identities.set(input.identity.id, clone(existing || input.identity))
    }
    if (input.assignment) {
      this.assignments.set(input.assignment.id, clone(input.assignment))
      Object.assign(this.sightings.get(task.sightingId), {
        identityCatId: input.assignment.catId,
        identityCat: { catId: input.assignment.catId, displayName: input.assignment.displayName },
        identityTaskId: task.id
      })
    }
    if (input.template) this.templates.set(input.template.id, clone(input.template))
    this.feedback.set(input.feedback.id, clone(input.feedback))
    const next = Object.assign({}, task, {
      state: input.nextState,
      version: task.version + 1,
      decisionType: input.decision.type,
      decisionHash: input.decisionHash,
      linkedCatId: input.assignment ? input.assignment.catId : null,
      linkedCatName: input.assignment ? input.assignment.displayName : null,
      assignmentId: input.assignment ? input.assignment.id : null,
      templateId: input.template ? input.template.id : null,
      notice: input.nextState === 'NEEDS_MORE_EVIDENCE' ? '已保留待确认' : '人工确认已保存'
    })
    delete next.embeddingBase64
    delete next.embeddingSha256
    this.jobs.set(next.id, clone(next))
    return clone(next)
  }

  async recoverExpiredIdentityRevocations(now) {
    const nowMs = Date.parse(now)
    let recovered = 0
    for (const identity of this.identities.values()) {
      if (identity.state !== 'revoking' || !Number.isFinite(Date.parse(identity.revocationExpiresAt)) ||
          Date.parse(identity.revocationExpiresAt) > nowMs) continue
      const task = identity.revocationSourceTaskId && this.jobs.get(identity.revocationSourceTaskId)
      identity.state = task && task.state === 'UNDONE' ? 'revoked' : 'active'
      if (identity.state === 'active') {
        for (const edge of this.relationshipEdges.values()) {
          if (edge.state === 'needs_review' &&
              edge.needsReviewSourceTaskId === identity.revocationSourceTaskId &&
              edge.needsReviewCatId === identity.id &&
              edge.identityReviewAudit && edge.identityReviewAudit.previousState === 'active') {
            edge.state = 'active'
            edge.needsReviewReason = null
            edge.needsReviewCatId = null
            edge.needsReviewSourceTaskId = null
            edge.needsReviewAt = null
            edge.identityReviewAudit = null
          }
        }
      }
      identity.revocationToken = null
      identity.revocationSourceTaskId = null
      identity.revocationStartedAt = null
      identity.revocationExpiresAt = null
      identity.revocationRecoveredAt = now
      identity.revocationRecoveryReason = 'lease_expired'
      recovered += 1
    }
    return recovered
  }

  async undoTask(input) {
    const task = this.jobs.get(input.taskId)
    if (!task || task.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'version')
    if (this.injectUndoFailureAfterStage && input.revokeIdentityId) {
      const identity = this.identities.get(input.revokeIdentityId)
      const token = `test-token-${task.id}`
      if (identity) {
        identity.state = 'revoking'
        identity.revocationToken = token
        identity.revocationSourceTaskId = task.id
        identity.revocationExpiresAt = new Date(NOW + 5 * 60 * 1000).toISOString()
      }
      for (const edge of this.relationshipEdges.values()) {
        if (edge.state === 'active' && (edge.catAId === input.revokeIdentityId || edge.catBId === input.revokeIdentityId)) {
          edge.state = 'needs_review'
          edge.needsReviewReason = 'canonical_identity_revoked'
          edge.needsReviewCatId = input.revokeIdentityId
          edge.needsReviewSourceTaskId = task.id
          edge.needsReviewAt = input.now
          edge.identityReviewAudit = {
            previousState: 'active',
            catId: input.revokeIdentityId,
            sourceTaskId: task.id
          }
        }
      }
      // Mirrors CloudRepository's token-CAS compensation after an injected
      // post-stage failure. The task is still completed, so resurrection is safe.
      if (identity && identity.state === 'revoking' && identity.revocationToken === token && task.state !== 'UNDONE') {
        const compensationToken = `compensate-${token}`
        identity.revocationToken = compensationToken
        for (const edge of this.relationshipEdges.values()) {
          if (edge.state === 'needs_review' && edge.needsReviewSourceTaskId === task.id &&
              edge.needsReviewCatId === input.revokeIdentityId && edge.identityReviewAudit &&
              edge.identityReviewAudit.previousState === 'active') {
            edge.state = 'active'
            edge.needsReviewReason = null
            edge.needsReviewCatId = null
            edge.needsReviewSourceTaskId = null
            edge.needsReviewAt = null
            edge.identityReviewAudit = null
          }
        }
        identity.state = 'active'
        identity.revocationToken = null
        identity.revocationSourceTaskId = null
        identity.revocationExpiresAt = null
        identity.revocationCompensatedAt = input.now
      }
      throw new DomainError('INJECTED_UNDO_FAILURE', 'injected after stage', true)
    }
    if (task.assignmentId && this.assignments.has(task.assignmentId)) this.assignments.get(task.assignmentId).state = 'revoked'
    if (task.templateId && this.templates.has(task.templateId)) this.templates.get(task.templateId).state = 'revoked'
    let revokedIdentity = null
    if (input.revokeIdentityId) {
      const identity = this.identities.get(input.revokeIdentityId)
      const hasOtherAssignment = Array.from(this.assignments.values()).some(item =>
        item.catId === input.revokeIdentityId && item.state === 'active' && item.id !== task.assignmentId)
      const hasOtherTemplate = Array.from(this.templates.values()).some(item =>
        item.catId === input.revokeIdentityId && item.state === 'active' && item.id !== task.templateId)
      if (identity && identity.sourceTaskId === task.id && !hasOtherAssignment && !hasOtherTemplate) {
        identity.state = 'revoked'
        revokedIdentity = identity
      }
    }
    if (revokedIdentity) {
      for (const edge of this.relationshipEdges.values()) {
        if (edge.communityId === task.communityId && edge.state === 'active' &&
            (edge.catAId === revokedIdentity.id || edge.catBId === revokedIdentity.id)) {
          Object.assign(edge, {
            state: 'needs_review',
            needsReviewReason: 'canonical_identity_revoked',
            needsReviewCatId: revokedIdentity.id,
            needsReviewSourceTaskId: task.id,
            needsReviewAt: input.now,
            identityReviewAudit: {
              previousState: 'active',
              reason: 'canonical_identity_revoked',
              catId: revokedIdentity.id,
              sourceTaskId: task.id,
              triggeredByOwnerKey: input.actorOwnerKey,
              triggeredAt: input.now
            }
          })
        }
      }
    }
    const sighting = this.sightings.get(task.sightingId)
    if (sighting && sighting.identityTaskId === task.id) {
      sighting.identityCatId = null
      sighting.identityCat = null
      sighting.identityTaskId = null
    }
    this.feedback.set(input.feedback.id, clone(input.feedback))
    const next = Object.assign({}, task, {
      state: 'UNDONE',
      version: task.version + 1,
      linkedCatId: null,
      linkedCatName: null,
      assignmentId: null,
      templateId: null,
      notice: '本次人工归属已撤销'
    })
    this.jobs.set(next.id, clone(next))
    return clone(next)
  }
}

function fixture(options) {
  const settings = options || {}
  const repository = new MemoryRepository()
  const ownerKey = ownerKeyFromOpenId(SECRET, 'openid-alice', 'v1')
  const reviewerKey = ownerKeyFromOpenId(SECRET, 'openid-reviewer', 'v1')
  const memberKey = ownerKeyFromOpenId(SECRET, 'openid-bob', 'v1')
  repository.memberships.set(`com_1|${ownerKey}`, { id: 'mem_alice', communityId: 'com_1', ownerKey, role: 'member', status: 'active' })
  repository.memberships.set(`com_1|${reviewerKey}`, { id: 'mem_reviewer', communityId: 'com_1', ownerKey: reviewerKey, role: 'reviewer', status: 'active' })
  repository.memberships.set(`com_1|${memberKey}`, { id: 'mem_bob', communityId: 'com_1', ownerKey: memberKey, role: 'member', status: 'active' })
  repository.sightings.set('sig_1', {
    id: 'sig_1',
    ownerKey,
    communityId: 'com_1',
    assetId: 'asset_1',
    state: 'APPROVED'
  })
  repository.publicSightings.set('sig_1', {
    id: 'sig_1', communityId: 'com_1', state: 'APPROVED', identityTemplateReady: false
  })
  repository.assets.set('asset_1', {
    id: 'asset_1',
    state: 'APPROVED',
    sanitized: true,
    approvedFileID: 'cloud://private/approved.jpg',
    sha256: 'a'.repeat(64),
    mime: 'image/jpeg',
    sizeBytes: 1234
  })
  repository.cats.set('cat_existing', {
    id: 'cat_existing', communityId: 'com_1', ownerKey, displayName: '团子', state: 'active'
  })

  const embedding = unitEmbedding()
  repository.templates.set('tpl_existing', {
    id: 'tpl_existing',
    communityId: 'com_1',
    catId: 'cat_existing',
    sessionId: 'session_old',
    state: 'active',
    version: 1,
    embeddingBase64: embedding.data,
    embeddingSha256: embedding.sha256,
    embeddingEncoding: CONTRACT.encoding,
    embeddingDimension: CONTRACT.dimension,
    modelVersion: CONTRACT.modelVersion,
    modelSha256: CONTRACT.modelSha256,
    preprocessVersion: CONTRACT.preprocessVersion,
    cropVersion: CONTRACT.cropVersion,
    quality: 0.9,
    view: 'whole_animal_reviewed'
  })

  let workerCalls = 0
  const worker = settings.worker || {
    configured: true,
    async process(payload) {
      workerCalls += 1
      if (typeof settings.onWorkerStart === 'function') await settings.onWorkerStart(payload)
      return {
        ok: true,
        requestId: payload.requestId,
        data: {
          gallerySnapshotId: payload.gallerySnapshotId,
          modelVersion: CONTRACT.modelVersion,
          modelSha256: CONTRACT.modelSha256,
          preprocessVersion: CONTRACT.preprocessVersion,
          cropVersion: CONTRACT.cropVersion,
          decisionPolicy: 'candidate_only',
          searchMode: 'exact_cosine',
          testOnly: Boolean(settings.testOnly),
          engine: settings.testOnly ? 'deterministic-stub' : 'onnxruntime-cpu',
          image: { mimeType: payload.image.mimeType, sizeBytes: payload.image.sizeBytes, width: 800, height: 600 },
          queryEmbedding: { encoding: CONTRACT.encoding, dimension: 512, data: embedding.data, sha256: embedding.sha256 },
          candidates: [{ catId: 'cat_existing', rank: 1, independentSessions: 1 }]
        }
      }
    }
  }
  const core = createCatIdentityCore({
    repository,
    worker,
    media: settings.media || { async getApprovedUrl() { return 'https://authorized.example/cat.jpg?token=short' } },
    ownerSecret: SECRET,
    ownerKeyVersion: 'v1',
    clock: () => NOW
  })
  return { core, repository, ownerKey, reviewerKey, memberKey, getWorkerCalls: () => workerCalls }
}

function request(action, extra) {
  return Object.assign({ action, schemaVersion: 1, requestId: `req_${action}` }, extra || {})
}

test('health reports manual-confirmation policy without secret disclosure', async () => {
  const { core } = fixture()
  const response = await core.handle(request('health'), {})
  assert.equal(response.ok, true)
  assert.equal(response.data.ownerSecretConfigured, true)
  assert.equal(response.data.workerConfigured, true)
  assert.equal(response.data.revocationRecoveryConfigured, true)
  assert.equal(response.data.revocationRecoveryAvailable, true)
  assert.equal(response.data.automaticMerge, false)
  assert.equal(JSON.stringify(response).includes(SECRET), false)
})

test('an expired revocation phase self-heals after a forced interruption without actor authorization', async () => {
  const { core, repository } = fixture()
  repository.identities.set('cat_interrupted', {
    id: 'cat_interrupted',
    communityId: 'com_1',
    displayName: '待恢复猫',
    state: 'revoking',
    sourceTaskId: 'task_interrupted',
    revocationToken: 'token_interrupted',
    revocationSourceTaskId: 'task_interrupted',
    revocationStartedAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    revocationExpiresAt: new Date(NOW - 5 * 60 * 1000).toISOString()
  })
  repository.relationshipEdges.set('edge_partial', {
    id: 'edge_partial',
    communityId: 'com_1',
    catAId: 'cat_interrupted',
    catBId: 'cat_existing',
    state: 'needs_review'
  })
  repository.relationshipEdges.set('edge_matching_interruption', {
    id: 'edge_matching_interruption',
    communityId: 'com_1',
    catAId: 'cat_interrupted',
    catBId: 'cat_existing',
    state: 'needs_review',
    needsReviewSourceTaskId: 'task_interrupted',
    needsReviewCatId: 'cat_interrupted',
    identityReviewAudit: { previousState: 'active' }
  })

  const response = await core.handle(request('health'), {})
  assert.equal(response.ok, true)
  assert.equal(response.data.recoveredIdentityRevocations, 1)
  assert.equal(repository.identities.get('cat_interrupted').state, 'active')
  assert.equal(repository.identities.get('cat_interrupted').revocationToken, null)
  assert.equal(repository.relationshipEdges.get('edge_partial').state, 'needs_review')
  assert.equal(repository.relationshipEdges.get('edge_matching_interruption').state, 'active')
})

test('trusted context wins over forged event identity and ordinary peers are rejected', async () => {
  const { core } = fixture({ worker: { configured: false } })
  const started = await core.handle(request('startMatch', {
    sightingId: 'sig_1',
    idempotencyKey: 'match-alice-0001',
    openid: 'openid-bob',
    ownerKey: 'forged-owner'
  }), { openid: 'openid-alice' })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(started.data.mode, 'MANUAL_ONLY')

  const peer = await core.handle(request('startMatch', {
    sightingId: 'sig_1',
    idempotencyKey: 'match-bob-00001'
  }), { openid: 'openid-bob' })
  assert.equal(peer.ok, false)
  assert.equal(peer.error.code, 'FORBIDDEN')

  const anonymous = await core.handle(request('startMatch', {
    sightingId: 'sig_1',
    idempotencyKey: 'match-none-0001'
  }), {})
  assert.equal(anonymous.ok, false)
  assert.equal(anonymous.error.code, 'AUTH_REQUIRED')
})

test('model result is redacted, idempotent, and never auto-merges', async () => {
  const { core, repository, getWorkerCalls } = fixture()
  const payload = request('startMatch', { sightingId: 'sig_1', idempotencyKey: 'match-model-0001' })
  const first = await core.handle(payload, { openid: 'openid-alice' })
  const second = await core.handle(payload, { openid: 'openid-alice' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.data.mode, 'MODEL_ASSISTED')
  assert.deepEqual(first.data.candidates, [{ catId: 'cat_existing', displayName: '团子', rank: 1, evidenceLabel: '优先核对' }])
  assert.equal(repository.jobs.size, 1)
  assert.equal(getWorkerCalls(), 1)
  const publicJson = JSON.stringify(first)
  for (const forbidden of ['embeddingBase64', 'embeddingSha256', 'retrievalScore', 'cosineSimilarity', 'ownerKey', 'fileID']) {
    assert.equal(publicJson.includes(forbidden), false, `must redact ${forbidden}`)
  }
  assert.equal(publicJson.includes('automaticMerge'), false)
})

test('concurrent duplicate start reserves one task and invokes worker once', async () => {
  let releaseWorker
  let markStarted
  const workerGate = new Promise(resolve => { releaseWorker = resolve })
  const startedGate = new Promise(resolve => { markStarted = resolve })
  const { core, repository, getWorkerCalls } = fixture({
    async onWorkerStart() {
      markStarted()
      await workerGate
    }
  })
  const payload = request('startMatch', { sightingId: 'sig_1', idempotencyKey: 'match-race-00001' })
  const firstPromise = core.handle(payload, { openid: 'openid-alice' })
  await startedGate
  const duplicate = await core.handle(payload, { openid: 'openid-alice' })
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.data.state, 'PROCESSING')
  assert.equal(getWorkerCalls(), 1)
  releaseWorker()
  const first = await firstPromise
  assert.equal(first.data.state, 'AWAITING_CONFIRMATION')
  assert.equal(repository.jobs.size, 1)
  assert.equal(getWorkerCalls(), 1)
})

test('explicit same-cat confirmation enrolls only real worker output and undo revokes it', async () => {
  const { core, repository } = fixture()
  const started = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-confirm-001'
  }), { openid: 'openid-alice' })
  const confirmed = await core.handle(request('confirm', {
    taskId: started.data.taskId,
    expectedVersion: started.data.version,
    idempotencyKey: 'confirm-same-001',
    decision: { type: 'same_cat', catId: 'cat_existing' }
  }), { openid: 'openid-alice' })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.data.state, 'COMPLETED')
  assert.deepEqual(confirmed.data.assignment, { catId: 'cat_existing', displayName: '团子' })
  const newTemplates = Array.from(repository.templates.values()).filter(item => item.sightingId === 'sig_1')
  assert.equal(newTemplates.length, 1)
  assert.equal(newTemplates[0].source, 'explicit_manual_confirmation')

  const undone = await core.handle(request('undo', {
    taskId: confirmed.data.taskId,
    expectedVersion: confirmed.data.version,
    idempotencyKey: 'undo-same-0001'
  }), { openid: 'openid-alice' })
  assert.equal(undone.ok, true)
  assert.equal(undone.data.state, 'UNDONE')
  assert.equal(repository.templates.get(newTemplates[0].id).state, 'revoked')
})

test('stub output cannot enroll a template', async () => {
  const { core, repository } = fixture({ testOnly: true })
  const started = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-stub-00001'
  }), { openid: 'openid-alice' })
  assert.equal(started.data.simulation, true)
  const confirmed = await core.handle(request('confirm', {
    taskId: started.data.taskId,
    expectedVersion: started.data.version,
    idempotencyKey: 'confirm-stub-001',
    decision: { type: 'same_cat', catId: 'cat_existing' }
  }), { openid: 'openid-alice' })
  assert.equal(confirmed.ok, true)
  assert.equal(Array.from(repository.templates.values()).filter(item => item.sightingId === 'sig_1').length, 0)
})

test('new-cat undo revokes only the identity created by that task', async () => {
  const { core, repository } = fixture({ worker: { configured: false } })
  const started = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-newcat-001'
  }), { openid: 'openid-alice' })
  const confirmed = await core.handle(request('confirm', {
    taskId: started.data.taskId,
    expectedVersion: started.data.version,
    idempotencyKey: 'confirm-newcat-1',
    decision: { type: 'new_cat', displayName: '小樱' }
  }), { openid: 'openid-alice' })
  const catId = confirmed.data.assignment.catId
  assert.equal(repository.identities.get(catId).state, 'active')
  assert.equal(repository.identities.get(catId).sourceTaskId, started.data.taskId)
  repository.relationshipEdges.set('edge_a', {
    id: 'edge_a', communityId: 'com_1', catAId: catId, catBId: 'cat_existing', state: 'active'
  })
  repository.relationshipEdges.set('edge_b', {
    id: 'edge_b', communityId: 'com_1', catAId: 'cat_existing', catBId: catId, state: 'active'
  })
  repository.relationshipEdges.set('edge_other', {
    id: 'edge_other', communityId: 'com_1', catAId: 'cat_existing', catBId: 'cat_unrelated', state: 'active'
  })
  await core.handle(request('undo', {
    taskId: confirmed.data.taskId,
    expectedVersion: confirmed.data.version,
    idempotencyKey: 'undo-newcat-001'
  }), { openid: 'openid-alice' })
  assert.equal(repository.identities.get(catId).state, 'revoked')
  assert.equal(repository.cats.get('cat_existing').state, 'active')
  for (const edgeId of ['edge_a', 'edge_b']) {
    const edge = repository.relationshipEdges.get(edgeId)
    assert.equal(edge.state, 'needs_review')
    assert.equal(edge.needsReviewReason, 'canonical_identity_revoked')
    assert.equal(edge.needsReviewCatId, catId)
    assert.equal(edge.identityReviewAudit.sourceTaskId, started.data.taskId)
  }
  assert.equal(repository.relationshipEdges.get('edge_other').state, 'active')
})

test('a post-stage undo failure compensates the same token back to active', async () => {
  const { core, repository } = fixture({ worker: { configured: false } })
  const started = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-compensate-1'
  }), { openid: 'openid-alice' })
  const confirmed = await core.handle(request('confirm', {
    taskId: started.data.taskId,
    expectedVersion: started.data.version,
    idempotencyKey: 'confirm-compensate',
    decision: { type: 'new_cat', displayName: '补偿测试猫' }
  }), { openid: 'openid-alice' })
  const catId = confirmed.data.assignment.catId
  repository.relationshipEdges.set('edge_compensated', {
    id: 'edge_compensated', communityId: 'com_1', catAId: catId, catBId: 'cat_existing', state: 'active'
  })
  repository.relationshipEdges.set('edge_unrelated_review', {
    id: 'edge_unrelated_review',
    communityId: 'com_1',
    catAId: catId,
    catBId: 'cat_other',
    state: 'needs_review',
    needsReviewSourceTaskId: 'another_task',
    needsReviewCatId: catId,
    identityReviewAudit: { previousState: 'active' }
  })
  repository.injectUndoFailureAfterStage = true

  const failed = await core.handle(request('undo', {
    taskId: confirmed.data.taskId,
    expectedVersion: confirmed.data.version,
    idempotencyKey: 'undo-compensate-1'
  }), { openid: 'openid-alice' })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'INJECTED_UNDO_FAILURE')
  assert.equal(repository.identities.get(catId).state, 'active')
  assert.equal(repository.identities.get(catId).revocationToken, null)
  assert.equal(repository.jobs.get(confirmed.data.taskId).state, 'COMPLETED')
  assert.equal(repository.relationshipEdges.get('edge_compensated').state, 'active')
  assert.equal(repository.relationshipEdges.get('edge_unrelated_review').state, 'needs_review')
})

test('bad worker embedding hash degrades to manual mode', async () => {
  const embedding = unitEmbedding()
  const badWorker = {
    configured: true,
    async process(payload) {
      return {
        ok: true,
        requestId: payload.requestId,
        data: {
          gallerySnapshotId: payload.gallerySnapshotId,
          modelVersion: CONTRACT.modelVersion,
          modelSha256: CONTRACT.modelSha256,
          preprocessVersion: CONTRACT.preprocessVersion,
          cropVersion: CONTRACT.cropVersion,
          decisionPolicy: 'candidate_only',
          searchMode: 'exact_cosine',
          testOnly: false,
          engine: 'onnxruntime-cpu',
          image: { mimeType: payload.image.mimeType, sizeBytes: payload.image.sizeBytes },
          queryEmbedding: { encoding: CONTRACT.encoding, dimension: 512, data: embedding.data, sha256: '0'.repeat(64) },
          candidates: []
        }
      }
    }
  }
  const { core } = fixture({ worker: badWorker })
  const response = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-bad-worker'
  }), { openid: 'openid-alice' })
  assert.equal(response.ok, true)
  assert.equal(response.data.mode, 'MANUAL_ONLY')
  assert.deepEqual(response.data.candidates, [])
  assert.match(response.data.notice, /人工确认/)

})

test('one corrupt stored template is skipped without blocking manual or model-assisted matching', async () => {
  let gallery = null
  const { core, repository } = fixture({
    onWorkerStart(payload) {
      gallery = payload.gallery
    }
  })
  repository.templates.set('tpl_corrupt', Object.assign({}, repository.templates.get('tpl_existing'), {
    id: 'tpl_corrupt',
    sessionId: 'session_corrupt',
    embeddingBase64: 'not-valid-base64'
  }))

  const response = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-corrupt-tpl'
  }), { openid: 'openid-alice' })
  assert.equal(response.ok, true)
  assert.equal(response.data.mode, 'MODEL_ASSISTED')
  assert.deepEqual(gallery.map(item => item.templateId), ['tpl_existing'])
})

test('temporary media URL failure completes the reserved task in manual mode', async () => {
  const { core, repository } = fixture({
    media: {
      async getApprovedUrl() {
        throw new DomainError('MEDIA_URL_FAILED', 'temporary', true)
      }
    }
  })
  const response = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-media-fail'
  }), { openid: 'openid-alice' })
  assert.equal(response.ok, true)
  assert.equal(response.data.state, 'AWAITING_CONFIRMATION')
  assert.equal(response.data.mode, 'MANUAL_ONLY')
  assert.equal(Array.from(repository.jobs.values())[0].leaseToken, undefined)
})

test('an expired processing lease is reclaimed instead of staying stuck forever', async () => {
  const { core, repository } = fixture({ worker: { configured: false } })
  const payload = request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-expired-lease'
  })
  const initial = await core.handle(payload, { openid: 'openid-alice' })
  const stuck = repository.jobs.get(initial.data.taskId)
  Object.assign(stuck, {
    state: 'PROCESSING',
    version: 1,
    leaseToken: 'stale-lease-token',
    leaseUntil: new Date(NOW - 1000).toISOString(),
    updatedAt: new Date(NOW - 60 * 1000).toISOString()
  })
  const recovered = await core.handle(payload, { openid: 'openid-alice' })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.data.state, 'AWAITING_CONFIRMATION')
  assert.equal(repository.jobs.get(initial.data.taskId).leaseToken, undefined)
})

test('ordinary members cannot attach their sighting to another members cat', async () => {
  const { core, repository, memberKey } = fixture({ worker: { configured: false } })
  repository.cats.set('cat_bob', {
    id: 'cat_bob', communityId: 'com_1', ownerKey: memberKey, displayName: '豆包', state: 'active'
  })
  const started = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-owner-scope'
  }), { openid: 'openid-alice' })
  assert.equal(started.ok, true)
  assert.deepEqual(started.data.availableCats.map(item => item.catId), ['cat_existing'])
  const blocked = await core.handle(request('confirm', {
    taskId: started.data.taskId,
    expectedVersion: started.data.version,
    idempotencyKey: 'confirm-other-cat',
    decision: { type: 'same_cat', catId: 'cat_bob' }
  }), { openid: 'openid-alice' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'CAT_CONFIRMATION_REQUIRED')
})

test('a sighting that already names a synced pet cannot enter re-identification', async () => {
  const { core, repository } = fixture({ worker: { configured: false } })
  repository.sightings.get('sig_1').remotePetId = 'cat_existing'
  const response = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-linked-pet'
  }), { openid: 'openid-alice' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'SIGHTING_ALREADY_LINKED')
})

test('a linked pet sighting explicitly enrolls one real template and reuses it idempotently', async () => {
  const { core, repository, getWorkerCalls } = fixture()
  Object.assign(repository.sightings.get('sig_1'), {
    remotePetId: 'cat_existing',
    catId: 'cat_existing'
  })
  const first = await core.handle(request('enrollLinkedSighting', {
    sightingId: 'sig_1',
    idempotencyKey: 'enroll-linked-0001'
  }), { openid: 'openid-alice' })
  assert.equal(first.ok, true)
  assert.equal(first.data.enrolled, true)
  assert.equal(first.data.alreadyEnrolled, false)
  assert.equal(first.data.catId, 'cat_existing')
  const enrolled = Array.from(repository.templates.values())
    .filter(item => item.sightingId === 'sig_1' && item.source === 'explicit_linked_pet_enrollment')
  assert.equal(enrolled.length, 1)
  assert.equal(getWorkerCalls(), 1)
  for (const [field, expected] of Object.entries({
    modelVersion: CONTRACT.modelVersion,
    modelSha256: CONTRACT.modelSha256,
    preprocessVersion: CONTRACT.preprocessVersion,
    cropVersion: CONTRACT.cropVersion,
    embeddingEncoding: CONTRACT.encoding,
    embeddingDimension: CONTRACT.dimension
  })) {
    assert.equal(enrolled[0][field], expected, `template must bind ${field}`)
  }

  // Simulate a legacy template and drifted projections. A repeat must repair
  // these records transactionally without invoking the Worker again.
  delete repository.templates.get(enrolled[0].id).enrollmentRequestHash
  repository.sightings.get('sig_1').identityTemplateReady = false
  repository.publicSightings.get('sig_1').identityTemplateReady = false

  const replay = await core.handle(request('enrollLinkedSighting', {
    sightingId: 'sig_1',
    idempotencyKey: 'enroll-linked-0002'
  }), { openid: 'openid-alice' })
  assert.equal(replay.ok, true)
  assert.equal(replay.data.alreadyEnrolled, true)
  assert.equal(getWorkerCalls(), 1)
  assert.match(repository.templates.get(enrolled[0].id).enrollmentRequestHash, /^[0-9a-f]{64}$/)
  assert.equal(repository.sightings.get('sig_1').identityTemplateReady, true)
  assert.equal(repository.publicSightings.get('sig_1').identityTemplateReady, true)

  repository.templates.get(enrolled[0].id).enrollmentRequestHash = 'f'.repeat(64)
  const conflict = await core.handle(request('enrollLinkedSighting', {
    sightingId: 'sig_1',
    idempotencyKey: 'enroll-linked-0003'
  }), { openid: 'openid-alice' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'ENROLLMENT_CONFLICT')
  assert.equal(getWorkerCalls(), 1)
})

test('an existing linked template with a mismatched version contract is rejected without Worker rerun', async () => {
  const { core, repository, getWorkerCalls } = fixture()
  Object.assign(repository.sightings.get('sig_1'), {
    remotePetId: 'cat_existing',
    catId: 'cat_existing'
  })
  const first = await core.handle(request('enrollLinkedSighting', {
    sightingId: 'sig_1', idempotencyKey: 'enroll-contract-01'
  }), { openid: 'openid-alice' })
  assert.equal(first.ok, true)
  repository.templates.get(first.data.templateId).embeddingDimension = 256

  const conflict = await core.handle(request('enrollLinkedSighting', {
    sightingId: 'sig_1', idempotencyKey: 'enroll-contract-02'
  }), { openid: 'openid-alice' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'ENROLLMENT_CONFLICT')
  assert.equal(getWorkerCalls(), 1)
})

test('a legacy deterministic template ID self-heals without Worker rerun when the full contract still matches', async () => {
  const { core, repository, getWorkerCalls } = fixture()
  Object.assign(repository.sightings.get('sig_1'), {
    remotePetId: 'cat_existing',
    catId: 'cat_existing',
    identityTemplateReady: false
  })
  const scope = `linked-enrollment|com_1|sig_1|cat_existing|${CONTRACT.modelSha256}`
  const legacyTemplateId = `tpl_${crypto.createHmac('sha256', SECRET).update(scope).digest('hex').slice(0, 32)}`
  const legacy = Object.assign({}, clone(repository.templates.get('tpl_existing')), {
    id: legacyTemplateId,
    sessionId: 'sig_1',
    sightingId: 'sig_1',
    source: 'explicit_linked_pet_enrollment'
  })
  delete legacy.enrollmentRequestHash
  repository.templates.set(legacyTemplateId, legacy)

  const replay = await core.handle(request('enrollLinkedSighting', {
    sightingId: 'sig_1', idempotencyKey: 'enroll-legacy-001'
  }), { openid: 'openid-alice' })
  assert.equal(replay.ok, true, JSON.stringify(replay))
  assert.equal(replay.data.alreadyEnrolled, true)
  assert.equal(replay.data.templateId, legacyTemplateId)
  assert.equal(getWorkerCalls(), 0)
  assert.match(repository.templates.get(legacyTemplateId).enrollmentRequestHash, /^[0-9a-f]{64}$/)
  assert.equal(repository.sightings.get('sig_1').identityTemplateReady, true)
})

test('linked pet enrollment fails closed when the real worker is unavailable or simulated', async () => {
  const unavailable = fixture({ worker: { configured: false } })
  Object.assign(unavailable.repository.sightings.get('sig_1'), {
    remotePetId: 'cat_existing',
    catId: 'cat_existing'
  })
  const blocked = await unavailable.core.handle(request('enrollLinkedSighting', {
    sightingId: 'sig_1',
    idempotencyKey: 'enroll-offline-001'
  }), { openid: 'openid-alice' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'REID_NOT_CONFIGURED')

  const simulated = fixture({ testOnly: true })
  Object.assign(simulated.repository.sightings.get('sig_1'), {
    remotePetId: 'cat_existing',
    catId: 'cat_existing'
  })
  const rejected = await simulated.core.handle(request('enrollLinkedSighting', {
    sightingId: 'sig_1',
    idempotencyKey: 'enroll-stub-0001'
  }), { openid: 'openid-alice' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'REID_TEST_ONLY')
  assert.equal(Array.from(simulated.repository.templates.values())
    .filter(item => item.sightingId === 'sig_1').length, 0)
})

test('two authorized tasks cannot assign one sighting to different cats', async () => {
  const { core, repository, memberKey } = fixture({ worker: { configured: false } })
  repository.cats.set('cat_bob', {
    id: 'cat_bob', communityId: 'com_1', ownerKey: memberKey, displayName: '豆包', state: 'active'
  })
  const ownerTask = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-owner-task'
  }), { openid: 'openid-alice' })
  const reviewerTask = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-reviewer-task'
  }), { openid: 'openid-reviewer' })
  const first = await core.handle(request('confirm', {
    taskId: ownerTask.data.taskId,
    expectedVersion: ownerTask.data.version,
    idempotencyKey: 'confirm-owner-task',
    decision: { type: 'same_cat', catId: 'cat_existing' }
  }), { openid: 'openid-alice' })
  assert.equal(first.ok, true)
  const conflict = await core.handle(request('confirm', {
    taskId: reviewerTask.data.taskId,
    expectedVersion: reviewerTask.data.version,
    idempotencyKey: 'confirm-review-task',
    decision: { type: 'same_cat', catId: 'cat_bob' }
  }), { openid: 'openid-reviewer' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'SIGHTING_ALREADY_ASSIGNED')
})

test('undoing the founding sighting preserves an identity used by another sighting', async () => {
  const { core, repository, ownerKey } = fixture({ worker: { configured: false } })
  const firstTask = await core.handle(request('startMatch', {
    sightingId: 'sig_1', idempotencyKey: 'match-founder-cat'
  }), { openid: 'openid-alice' })
  const founded = await core.handle(request('confirm', {
    taskId: firstTask.data.taskId,
    expectedVersion: firstTask.data.version,
    idempotencyKey: 'confirm-founder-cat',
    decision: { type: 'new_cat', displayName: '小樱' }
  }), { openid: 'openid-alice' })
  const catId = founded.data.assignment.catId

  repository.assets.set('asset_2', Object.assign({}, repository.assets.get('asset_1'), { id: 'asset_2' }))
  repository.sightings.set('sig_2', {
    id: 'sig_2', ownerKey, communityId: 'com_1', assetId: 'asset_2', state: 'APPROVED'
  })
  const secondTask = await core.handle(request('startMatch', {
    sightingId: 'sig_2', idempotencyKey: 'match-dependent-cat'
  }), { openid: 'openid-alice' })
  const linked = await core.handle(request('confirm', {
    taskId: secondTask.data.taskId,
    expectedVersion: secondTask.data.version,
    idempotencyKey: 'confirm-dependent-cat',
    decision: { type: 'same_cat', catId }
  }), { openid: 'openid-alice' })
  assert.equal(linked.ok, true)

  const undone = await core.handle(request('undo', {
    taskId: founded.data.taskId,
    expectedVersion: founded.data.version,
    idempotencyKey: 'undo-founder-cat'
  }), { openid: 'openid-alice' })
  assert.equal(undone.ok, true)
  assert.equal(repository.identities.get(catId).state, 'active')
})
