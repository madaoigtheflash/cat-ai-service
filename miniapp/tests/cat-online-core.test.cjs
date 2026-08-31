'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createCatOnlineCore,
  deriveFeedbackStage,
  DomainError,
  normalizeCloudFilePath,
  ownerKeyFromOpenId
} = require(path.resolve(__dirname, '../cloudfunctions/catOnline/core.js'))

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

class MemoryRepository {
  constructor() {
    this.users = new Map()
    this.communities = new Map()
    this.members = new Map()
    this.pets = new Map()
    this.uploads = new Map()
    this.assets = new Map()
    this.privateSightings = new Map()
    this.publicSightings = new Map()
    this.identities = new Map()
    this.relationshipEdges = new Map()
    this.relationshipVotes = new Map()
    this.feedback = new Map()
    this.changeProposals = new Map()
  }

  async ensureUser(user) {
    const existing = this.users.get(user.id)
    const saved = existing ? Object.assign({}, existing, { updatedAt: user.updatedAt }) : clone(user)
    this.users.set(user.id, saved)
    return clone(saved)
  }

  async updateConsent(userId, consentVersion, now) {
    const user = this.users.get(userId)
    Object.assign(user, { consentVersion, consentUpdatedAt: now, updatedAt: now })
  }

  async createFeedback(feedback) {
    const existing = this.feedback.get(feedback.id)
    if (existing) return clone(existing)
    this.feedback.set(feedback.id, clone(feedback))
    return clone(feedback)
  }

  async listMyFeedback(ownerKey) {
    return Array.from(this.feedback.values())
      .filter(item => item.ownerKey === ownerKey)
      .map(clone)
  }

  async listChangeProposalsByIds(proposalIds) {
    return (proposalIds || [])
      .map(id => this.changeProposals.get(id))
      .filter(Boolean)
      .map(clone)
  }

  async listMemberships(ownerKey) {
    return Array.from(this.members.values())
      .filter(member => member.ownerKey === ownerKey && member.status === 'active')
      .map(membership => ({ membership: clone(membership), community: clone(this.communities.get(membership.communityId)) }))
      .filter(item => item.community)
  }

  async createCommunity(community, membership) {
    const existing = this.communities.get(community.id)
    if (existing) return clone(existing)
    const collision = Array.from(this.communities.values()).find(item => item.inviteHash === community.inviteHash)
    if (collision) throw new DomainError('INVITE_COLLISION', '邀请码冲突')
    this.communities.set(community.id, clone(community))
    this.members.set(membership.id, clone(membership))
    return clone(community)
  }

  async findCommunityByInviteHash(inviteHash) {
    const found = Array.from(this.communities.values()).find(item => item.inviteHash === inviteHash)
    return clone(found || null)
  }

  async joinCommunity(community, membership) {
    const existing = this.members.get(membership.id)
    if (existing && existing.status === 'active') return clone(existing)
    this.members.set(membership.id, clone(membership))
    return clone(membership)
  }

  async getMembership(communityId, ownerKey) {
    const found = Array.from(this.members.values())
      .find(item => item.communityId === communityId && item.ownerKey === ownerKey)
    return clone(found || null)
  }

  async upsertPet(pet) {
    const existing = this.pets.get(pet.id)
    const catId = existing && existing.catId ? existing.catId : (pet.catId || pet.id)
    const saved = existing
      ? Object.assign({}, existing, {
        catId,
        displayName: pet.displayName,
        breed: pet.breed,
        gender: pet.gender,
        coatColor: pet.coatColor,
        estimatedAge: pet.estimatedAge,
        syncFingerprint: pet.syncFingerprint,
        serverVersion: Math.max(1, Number(existing.serverVersion) || 1) + 1,
        state: 'active',
        updatedAt: pet.updatedAt
      })
      : Object.assign(clone(pet), { catId, serverVersion: 1 })
    this.pets.set(pet.id, saved)
    const existingIdentity = this.identities.get(catId)
    const identity = existingIdentity
      ? Object.assign({}, existingIdentity, {
        displayName: existingIdentity.ownerKey === pet.ownerKey ? pet.displayName : existingIdentity.displayName,
        canonicalCatId: existingIdentity.canonicalCatId || catId,
        identityVersion: Math.max(1, Number(existingIdentity.identityVersion) || 1) + 1,
        updatedAt: pet.updatedAt
      })
      : {
        id: catId,
        communityId: pet.communityId,
        displayName: pet.displayName,
        state: 'active',
        canonicalCatId: catId,
        identityVersion: 1,
        source: 'synced_user_pet',
        sourceUserPetLinkId: pet.id,
        ownerKey: pet.ownerKey,
        createdAt: pet.createdAt,
        updatedAt: pet.updatedAt
      }
    this.identities.set(catId, clone(identity))
    return clone(saved)
  }

  async getPet(remotePetId) {
    return clone(this.pets.get(remotePetId) || null)
  }

  async getCommunityCat(communityId, catId) {
    let currentId = catId
    const visited = new Set()
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const cat = this.identities.get(currentId) || this.pets.get(currentId)
      if (!cat || cat.communityId !== communityId) return null
      if (cat.canonicalCatId && cat.canonicalCatId !== currentId) {
        currentId = cat.canonicalCatId
        continue
      }
      return cat.state === 'active' ? clone(cat) : null
    }
    return null
  }

  async createUpload(session) {
    const existing = this.uploads.get(session.id)
    if (existing) return clone(existing)
    this.uploads.set(session.id, clone(session))
    return clone(session)
  }

  async getUpload(uploadId) {
    return clone(this.uploads.get(uploadId) || null)
  }

  async submitSighting(input) {
    const session = this.uploads.get(input.session.id)
    if (!session || session.ownerKey !== input.session.ownerKey) throw new DomainError('UPLOAD_NOT_FOUND', '上传会话不存在')
    if (session.state === 'SUBMITTED') {
      if (session.submitIdempotencyKey !== input.idempotencyKey || session.submitRequestHash !== input.requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', '重复提交参数不一致')
      }
      return clone(this.privateSightings.get(session.sightingId))
    }
    const existing = this.privateSightings.get(input.sighting.id)
    if (existing) {
      if (existing.submitIdempotencyKey !== input.idempotencyKey ||
          existing.submitRequestHash !== input.requestHash ||
          existing.ownerKey !== input.session.ownerKey) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'submit key reused for another upload')
      }
      return clone(existing)
    }
    this.assets.set(input.asset.id, clone(input.asset))
    this.privateSightings.set(input.sighting.id, clone(input.sighting))
    Object.assign(session, {
      state: 'SUBMITTED',
      sightingId: input.sighting.id,
      submitIdempotencyKey: input.idempotencyKey,
      submitRequestHash: input.requestHash,
      updatedAt: input.now
    })
    return clone(input.sighting)
  }

  async listWorkspace(communityId, ownerKey) {
    const community = clone(this.communities.get(communityId))
    if (!community) throw new DomainError('NOT_FOUND', '社区不存在')
    const myPets = Array.from(this.pets.values())
      .filter(item => item.communityId === communityId && item.ownerKey === ownerKey && item.state === 'active')
      .map(clone)
    const pending = Array.from(this.privateSightings.values())
      .filter(item => item.communityId === communityId && item.state === 'PENDING_REVIEW')
      .map(sighting => ({ sighting: clone(sighting), asset: clone(this.assets.get(sighting.assetId)) }))
    const approved = Array.from(this.publicSightings.values())
      .filter(item => item.communityId === communityId && item.state === 'APPROVED')
      .map(sighting => ({ sighting: clone(sighting), asset: clone(this.assets.get(sighting.assetId)) }))
    return { community, myPets, pending, approved }
  }

  async getSighting(sightingId) {
    const sighting = this.privateSightings.get(sightingId)
    if (!sighting) return null
    const asset = this.assets.get(sighting.assetId)
    return asset ? { sighting: clone(sighting), asset: clone(asset) } : null
  }

  async listCommunityInsights(communityId, ownerKey) {
    const catsById = new Map()
    Array.from(this.pets.values())
      .filter(item => item.communityId === communityId && item.state === 'active')
      .forEach(item => catsById.set(item.id, clone(item)))
    Array.from(this.identities.values())
      .filter(item => item.communityId === communityId && item.state === 'active')
      .forEach(item => catsById.set(item.id, clone(item)))
    const cats = Array.from(catsById.values())
    const edges = Array.from(this.relationshipEdges.values())
      .filter(item => item.communityId === communityId && item.state === 'active')
      .map(clone)
    const myVotes = Array.from(this.relationshipVotes.values())
      .filter(item => item.communityId === communityId && item.ownerKey === ownerKey)
      .map(clone)
    const sightings = Array.from(this.publicSightings.values())
      .filter(item => item.communityId === communityId && item.state === 'APPROVED')
      .map(clone)
    return { cats, edges, myVotes, sightings }
  }

  async castRelationshipVote(input) {
    const membership = this.members.get(input.membershipId)
    if (!membership || membership.ownerKey !== input.actorOwnerKey || membership.communityId !== input.edge.communityId) {
      throw new DomainError('FORBIDDEN', '成员权限已变化')
    }
    const currentEdge = this.relationshipEdges.get(input.edge.id)
    const currentVote = this.relationshipVotes.get(input.vote.id)
    if (currentVote && currentVote.idempotencyKey === input.vote.idempotencyKey) {
      if (currentVote.requestHash !== input.vote.requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '投票幂等冲突')
      return { edge: clone(currentEdge), vote: clone(currentVote) }
    }
    const counts = Object.assign({ bonded: 0, playmate: 0, housemate: 0, needs_space: 0, unsure: 0 }, currentEdge && currentEdge.voteCounts)
    if (currentVote) counts[currentVote.choice] = Math.max(0, counts[currentVote.choice] - 1)
    counts[input.vote.choice] += 1
    const edge = Object.assign({}, currentEdge || input.edge, {
      voteCounts: counts,
      totalVotes: Object.values(counts).reduce((sum, value) => sum + value, 0),
      updatedAt: input.now
    })
    const vote = Object.assign({}, currentVote || input.vote, input.vote, {
      createdAt: currentVote ? currentVote.createdAt : input.vote.createdAt,
      updatedAt: input.now
    })
    this.relationshipEdges.set(edge.id, clone(edge))
    this.relationshipVotes.set(vote.id, clone(vote))
    return { edge: clone(edge), vote: clone(vote) }
  }

  async reviewSighting(input) {
    const sighting = this.privateSightings.get(input.sightingId)
    if (!sighting) throw new DomainError('NOT_FOUND', '目击记录不存在')
    const asset = this.assets.get(sighting.assetId)
    const legacyResanitize = sighting.state === 'APPROVED' && input.decision === 'approved' && asset.sanitized !== true
    if (sighting.state !== 'PENDING_REVIEW') {
      if (sighting.lastReviewIdempotencyKey === input.idempotencyKey) {
        if (sighting.lastReviewRequestHash !== input.reviewRequestHash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'review key reused for another decision')
        }
        return clone(sighting)
      }
      if (!legacyResanitize) throw new DomainError('STATE_CONFLICT', '这条目击已经被审核')
    }
    if (sighting.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', '版本冲突')
    const membership = this.members.get(input.reviewerMembershipId)
    if (!membership || membership.ownerKey !== input.reviewerOwnerKey || membership.communityId !== sighting.communityId ||
        membership.status !== 'active' || !['owner', 'admin', 'reviewer'].includes(membership.role)) {
      throw new DomainError('FORBIDDEN', '审核权限已变更')
    }
    const nextState = input.decision === 'approved' ? 'APPROVED' : 'REJECTED'
    Object.assign(sighting, {
      state: nextState,
      version: sighting.version + 1,
      reviewerOwnerKey: input.reviewerOwnerKey,
      reviewerRole: input.reviewerRole,
      reviewNote: input.note,
      reviewedAt: input.now,
      lastReviewIdempotencyKey: input.idempotencyKey,
      lastReviewRequestHash: input.reviewRequestHash,
      updatedAt: input.now
    })
    Object.assign(asset, {
      state: nextState,
      approvedFileID: input.approvedFileID || null,
      approvedPath: input.approvedPath || null,
      sourceMime: asset.sourceMime || asset.mime,
      sourceSizeBytes: asset.sourceSizeBytes || asset.sizeBytes,
      sourceSha256: asset.sourceSha256 || asset.sha256,
      mime: input.approvedMime || asset.mime,
      sizeBytes: input.approvedSizeBytes || asset.sizeBytes,
      sha256: input.approvedSha256 || asset.sha256,
      sanitized: nextState === 'APPROVED',
      updatedAt: input.now
    })
    if (nextState === 'APPROVED') {
      const existingPublic = this.publicSightings.get(sighting.id) || {}
      this.publicSightings.set(sighting.id, Object.assign({}, existingPublic, {
        id: sighting.id,
        ownerKey: sighting.ownerKey,
        communityId: sighting.communityId,
        assetId: sighting.assetId,
        state: 'APPROVED',
        version: sighting.version,
        remotePetId: sighting.remotePetId || null,
        catId: sighting.catId || sighting.remotePetId || null,
        cat: clone(sighting.cat),
        identityTemplateReady: Boolean(sighting.identityTemplateReady || existingPublic.identityTemplateReady),
        observedTimeBucket: sighting.observedTimeBucket,
        coarseLocation: clone(sighting.coarseLocation),
        submittedAt: sighting.submittedAt,
        reviewedAt: input.now
      }))
    }
    return clone(sighting)
  }
}

async function main() {
  const stageCases = [
    [{ status: 'OPEN' }, null, 'RECEIVED'],
    [{ status: 'TRIAGED' }, null, 'INITIAL_REVIEW'],
    [{ status: 'INCLUDED_IN_PROPOSAL', proposalId: 'proposal_1' }, { status: 'READY_FOR_LOCAL_REVIEW' }, 'LOCAL_REVIEW'],
    [{ status: 'INCLUDED_IN_PROPOSAL', proposalId: 'proposal_1' }, { status: 'AWAITING_ADMIN_APPROVAL' }, 'LOCAL_REVIEW'],
    [{ status: 'INCLUDED_IN_PROPOSAL', proposalId: 'proposal_1' }, { status: 'APPROVED_FOR_LOCAL_EXECUTION' }, 'LOCAL_REVIEW'],
    [{ status: 'INCLUDED_IN_PROPOSAL', proposalId: 'proposal_1' }, { status: 'EXECUTING' }, 'EXECUTING'],
    [{ status: 'INCLUDED_IN_PROPOSAL', proposalId: 'proposal_1' }, { status: 'COMPLETED' }, 'COMPLETED'],
    [{ status: 'INCLUDED_IN_PROPOSAL', proposalId: 'proposal_1' }, { status: 'FAILED' }, 'FAILED'],
    [{ status: 'INCLUDED_IN_PROPOSAL', proposalId: 'proposal_1' }, { status: 'REJECTED' }, 'REJECTED'],
    [{ status: 'INCLUDED_IN_PROPOSAL', proposalId: 'proposal_1' }, null, 'STATUS_PENDING'],
    [{ status: 'UNKNOWN_HISTORY' }, null, 'STATUS_PENDING'],
    [{ status: 'CLOSED', proposalId: 'proposal_1' }, { status: 'FAILED' }, 'STATUS_PENDING']
  ]
  stageCases.forEach(([feedback, proposal, expected]) => {
    assert.equal(deriveFeedbackStage(feedback, proposal).stage, expected)
  })

  assert.equal(normalizeCloudFilePath('cloud://cloud1-demo.bucket/path/to/cat.jpg', 'cloud1-demo'), 'path/to/cat.jpg')
  assert.throws(
    () => normalizeCloudFilePath('cloud://other-env.bucket/path/to/cat.jpg', 'cloud1-demo'),
    error => error instanceof DomainError && error.code === 'INVALID_FILE'
  )
  const secret = 'phase1-test-secret-that-is-long-and-never-shipped-to-client'
  const repository = new MemoryRepository()
  const files = new Map()
  let nowMs = Date.parse('2026-08-28T08:00:00.000Z')
  let approveCalls = 0
  const media = {
    async inspect({ fileID, expectedMime, expectedSizeBytes }) {
      const file = files.get(fileID)
      if (!file) throw new DomainError('INVALID_FILE', '文件不存在')
      assert.equal(file.mime, expectedMime)
      assert.equal(file.sizeBytes, expectedSizeBytes)
      return clone(file)
    },
    async approve({ sightingId, mime, sha256 }) {
      approveCalls += 1
      return {
        fileID: `cloud://test.env/identity-approved/sightings/${sightingId}/${sha256}.jpg`,
        cloudPath: `identity-approved/sightings/${sightingId}/${sha256}.jpg`,
        mime: 'image/jpeg',
        sizeBytes: 321,
        sha256
      }
    },
    async getTempUrls(requests) {
      return Object.fromEntries(requests.map(item => [item.key, {
        url: `https://temporary.example/${encodeURIComponent(item.key)}`,
        expiresAt: '2026-08-28T08:05:00.000Z'
      }]))
    }
  }
  const core = createCatOnlineCore({ repository, media, ownerSecret: secret, clock: () => nowMs })
  const call = (openid, action, input) => core.handle(Object.assign({
    action,
    schemaVersion: 1,
    requestId: `${action}-request`
  }, input || {}), { openid })

  const health = await call('', 'health')
  assert.equal(health.ok, true)
  assert.equal(health.data.phase, 'phase1-manual')
  assert.equal(health.data.ownerSecretConfigured, true)
  assert.equal(health.data.relationshipContract.id, 'cat-ai.relationship.directed')
  assert.equal(health.data.relationshipContract.version, 2)
  assert.equal(health.data.relationshipContract.edgeUniqueness, 'communityId+directionKey')
  assert.equal(health.data.relationshipContract.canonicalEndpoints, true)
  assert.equal(health.data.relationshipContract.evidenceSupported, false)

  const aliceBootstrap = await call('openid-alice', 'bootstrap', { openid: 'openid-attacker', consentVersion: 'privacy-v1' })
  assert.equal(aliceBootstrap.ok, true)
  assert.equal(repository.users.size, 1)
  assert.equal(aliceBootstrap.data.capabilities.userFeedback, true)
  assert.equal(Object.prototype.hasOwnProperty.call(aliceBootstrap.data.capabilities, 'appAdmin'), false)
  const storedAlice = Array.from(repository.users.values())[0]
  assert.equal(storedAlice.ownerKey, ownerKeyFromOpenId(secret, 'openid-alice', 'v1'))
  assert.notEqual(storedAlice.ownerKey, ownerKeyFromOpenId(secret, 'openid-attacker', 'v1'))
  assert.equal(storedAlice.consentVersion, 'privacy-v1')

  const feedback = await call('openid-alice', 'submitFeedback', {
    idempotencyKey: 'feedback-submit-0001',
    category: 'usability',
    title: '知识页输入框太高',
    content: '手机端提交按钮需要下拉后才能看到。',
    steps: '打开知识页，输入一段文字。',
    client: { version: '1.2.0', platform: 'ios', sdkVersion: '3.17.1', sourcePage: 'pages/knowledge/index' }
  })
  assert.equal(feedback.ok, true)
  assert.equal(feedback.data.feedback.status, 'OPEN')
  assert.equal(Object.prototype.hasOwnProperty.call(feedback.data.feedback, 'content'), false)
  assert.equal(repository.feedback.size, 1)
  const feedbackRetry = await call('openid-alice', 'submitFeedback', {
    idempotencyKey: 'feedback-submit-0001',
    category: 'usability',
    title: '知识页输入框太高',
    content: '手机端提交按钮需要下拉后才能看到。',
    steps: '打开知识页，输入一段文字。'
  })
  assert.equal(feedbackRetry.ok, true)
  assert.equal(repository.feedback.size, 1)

  repository.changeProposals.set('proposal_1', {
    id: 'proposal_1',
    title: '收紧知识页布局',
    summary: '降低输入区域高度并保持 88rpx 触控目标。',
    recommendation: 'recommend',
    feasibility: { level: 'high', score: 92, reason: '仅涉及布局与回归测试。' },
    affectedAreas: ['miniapp/pages/knowledge'],
    risks: [{ level: 'low', description: '大字体可能换行', mitigation: '增加大字体视觉测试' }],
    draftChanges: [{ area: '知识问答', proposedChange: '改为自适应输入框', acceptanceCriteria: ['无需下拉即可提交'] }],
    testPlan: ['标准字体与大字体各验证一次'],
    feedbackCount: 1,
    status: 'READY_FOR_LOCAL_REVIEW',
    version: 1,
    generatedAt: new Date(nowMs).toISOString()
  })
  const storedFeedback = Array.from(repository.feedback.values())[0]
  Object.assign(storedFeedback, {
    status: 'INCLUDED_IN_PROPOSAL',
    proposalId: 'proposal_1',
    version: 2,
    updatedAt: new Date(nowMs).toISOString()
  })
  repository.feedback.set('fb_other_owner', {
    id: 'fb_other_owner',
    ownerKey: ownerKeyFromOpenId(secret, 'openid-bob'),
    category: 'other',
    title: '其他用户的反馈',
    content: '不应返回给当前用户',
    status: 'OPEN',
    version: 1,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString()
  })
  const memberCenter = await call('openid-alice', 'listFeedbackCenter')
  assert.equal(memberCenter.ok, true)
  assert.equal(memberCenter.data.myFeedback.length, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(memberCenter.data, 'proposals'), false)
  assert.equal(memberCenter.data.policy.feedbackOnlyClient, true)
  assert.equal(memberCenter.data.myFeedback[0].stage, 'LOCAL_REVIEW')
  assert.equal(Object.prototype.hasOwnProperty.call(memberCenter.data.myFeedback[0], 'proposalId'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(memberCenter.data.myFeedback[0], 'summary'), false)
  const removedDecision = await call('openid-alice', 'decideChangeProposal', {})
  assert.equal(removedDecision.ok, false)
  assert.equal(removedDecision.error.code, 'UNKNOWN_ACTION')

  const create = await call('openid-alice', 'createCommunity', {
    idempotencyKey: 'community-create-0001',
    name: '奶糖小区观察站'
  })
  assert.equal(create.ok, true)
  assert.match(create.data.inviteCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
  assert.equal(create.data.community.role, 'owner')
  const communityId = create.data.community.communityId

  const createRetry = await call('openid-alice', 'createCommunity', {
    idempotencyKey: 'community-create-0001',
    name: '奶糖小区观察站'
  })
  assert.equal(createRetry.ok, true)
  assert.equal(createRetry.data.community.communityId, communityId)
  assert.equal(repository.communities.size, 1)

  const createConflict = await call('openid-alice', 'createCommunity', {
    idempotencyKey: 'community-create-0001',
    name: '不同的社区名'
  })
  assert.equal(createConflict.ok, false)
  assert.equal(createConflict.error.code, 'IDEMPOTENCY_CONFLICT')

  const invalidJoin = await call('openid-bob', 'joinCommunity', { inviteCode: 'XXXXX-XXXXX' })
  assert.equal(invalidJoin.ok, false)
  assert.equal(invalidJoin.error.code, 'INVALID_INVITE')

  const bobJoin = await call('openid-bob', 'joinCommunity', { inviteCode: create.data.inviteCode })
  assert.equal(bobJoin.ok, true)
  assert.equal(bobJoin.data.community.role, 'member')

  const sync = await call('openid-alice', 'syncPet', {
    communityId,
    pet: {
      localPetId: 'pet_local_1700000000',
      displayName: '奶糖',
      breed: '中华田园猫',
      gender: '母',
      coatColor: '橘白',
      estimatedAge: '2岁左右',
      syncFingerprint: '0123456789abcdef',
      vaccines: [{ date: 'private' }],
      medical: [{ note: 'private' }],
      weight: '4.2'
    }
  })
  assert.equal(sync.ok, true)
  const remotePetId = sync.data.pet.remotePetId
  const storedPet = repository.pets.get(remotePetId)
  assert.equal(storedPet.localPetId, 'pet_local_1700000000')
  assert.equal(Object.prototype.hasOwnProperty.call(storedPet, 'vaccines'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(storedPet, 'medical'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(storedPet, 'weight'), false)
  assert.equal(storedPet.coatColor, '橘白')
  assert.equal(sync.data.pet.syncFingerprint, '0123456789abcdef')

  const resync = await call('openid-alice', 'syncPet', {
    communityId,
    pet: {
      localPetId: 'pet_local_1700000000',
      displayName: '奶糖',
      breed: '中华田园猫',
      gender: '母',
      coatColor: '浅橘白',
      estimatedAge: '约3岁',
      syncFingerprint: 'fedcba9876543210'
    }
  })
  assert.equal(resync.ok, true)
  assert.equal(repository.pets.get(remotePetId).coatColor, '浅橘白')
  assert.equal(repository.pets.get(remotePetId).syncFingerprint, 'fedcba9876543210')

  const bobSync = await call('openid-bob', 'syncPet', {
    communityId,
    pet: {
      localPetId: 'pet_bob_local_1',
      displayName: '豆包',
      breed: '中华田园猫',
      coatColor: '狸花',
      syncFingerprint: '1111222233334444'
    }
  })
  assert.equal(bobSync.ok, true)
  const bobRemotePetId = bobSync.data.pet.remotePetId

  repository.identities.set('cat_alias_alice', {
    id: 'cat_alias_alice',
    communityId,
    displayName: '奶糖（旧身份）',
    state: 'merged',
    canonicalCatId: remotePetId
  })

  const aliceVote = await call('openid-alice', 'castRelationshipVote', {
    idempotencyKey: 'relation-vote-alice-0001',
    communityId,
    relationshipContractId: 'cat-ai.relationship.directed',
    relationshipContractVersion: 2,
    directionVersion: 2,
    fromCatId: 'cat_alias_alice',
    toCatId: bobRemotePetId,
    choice: 'bonded'
  })
  assert.equal(aliceVote.ok, true)
  assert.equal(aliceVote.data.relationship.directionState, 'directed')
  assert.equal(aliceVote.data.relationship.relationshipContractId, 'cat-ai.relationship.directed')
  assert.equal(aliceVote.data.relationship.relationshipContractVersion, 2)
  assert.equal(aliceVote.data.relationship.directionKey, `${remotePetId}::${bobRemotePetId}`)
  assert.equal(aliceVote.data.relationship.fromCat.catId, remotePetId)
  assert.equal(aliceVote.data.relationship.toCat.catId, bobRemotePetId)
  assert.equal(aliceVote.data.relationship.roleLabels.from, '主动亲近方')
  const aliceToBobEdgeId = aliceVote.data.relationship.relationshipId
  assert.equal(aliceVote.data.relationship.myChoice, 'bonded')
  assert.equal(aliceVote.data.relationship.voteCounts.bonded, 1)

  const canonicalSelfLoop = await call('openid-alice', 'castRelationshipVote', {
    idempotencyKey: 'relation-vote-self-loop-0001',
    communityId,
    relationshipContractId: 'cat-ai.relationship.directed',
    relationshipContractVersion: 2,
    directionVersion: 2,
    fromCatId: 'cat_alias_alice',
    toCatId: remotePetId,
    choice: 'unsure'
  })
  assert.equal(canonicalSelfLoop.ok, false)
  assert.equal(canonicalSelfLoop.error.code, 'VALIDATION_ERROR')

  const unsupportedEvidence = await call('openid-alice', 'castRelationshipVote', {
    idempotencyKey: 'relation-vote-evidence-0001',
    communityId,
    relationshipContractId: 'cat-ai.relationship.directed',
    relationshipContractVersion: 2,
    directionVersion: 2,
    fromCatId: remotePetId,
    toCatId: bobRemotePetId,
    choice: 'bonded',
    evidenceSightingIds: ['sig_unreachable']
  })
  assert.equal(unsupportedEvidence.ok, false)
  assert.equal(unsupportedEvidence.error.code, 'RELATIONSHIP_EVIDENCE_UNAVAILABLE')

  const bobMembership = Array.from(repository.members.values())
    .find(item => item.communityId === communityId && item.ownerKey === ownerKeyFromOpenId(secret, 'openid-bob', 'v1'))
  bobMembership.role = 'reviewer'
  const bobBlindInsights = await call('openid-bob', 'listCommunityInsights', { communityId })
  assert.equal(bobBlindInsights.ok, true)
  assert.equal(bobBlindInsights.data.cats.length, 2)
  assert.equal(bobBlindInsights.data.relationships[0].distributionVisible, false)
  assert.equal(bobBlindInsights.data.relationships[0].voteCounts, null)
  bobMembership.role = 'member'

  const bobVote = await call('openid-bob', 'castRelationshipVote', {
    idempotencyKey: 'relation-vote-bob-0001',
    communityId,
    relationshipContractId: 'cat-ai.relationship.directed',
    relationshipContractVersion: 2,
    directionVersion: 2,
    fromCatId: bobRemotePetId,
    toCatId: remotePetId,
    choice: 'playmate'
  })
  assert.equal(bobVote.ok, true)
  assert.notEqual(bobVote.data.relationship.relationshipId, aliceToBobEdgeId)
  assert.equal(bobVote.data.relationship.fromCat.catId, bobRemotePetId)
  assert.equal(bobVote.data.relationship.toCat.catId, remotePetId)
  assert.equal(bobVote.data.relationship.totalVotes, 1)
  assert.equal(bobVote.data.relationship.voteCounts.bonded, 0)
  assert.equal(bobVote.data.relationship.voteCounts.playmate, 1)

  const bobVoteConflict = await call('openid-bob', 'castRelationshipVote', {
    idempotencyKey: 'relation-vote-bob-0001',
    communityId,
    relationshipContractId: 'cat-ai.relationship.directed',
    relationshipContractVersion: 2,
    directionVersion: 2,
    fromCatId: bobRemotePetId,
    toCatId: remotePetId,
    choice: 'needs_space'
  })
  assert.equal(bobVoteConflict.ok, false)
  assert.equal(bobVoteConflict.error.code, 'IDEMPOTENCY_CONFLICT')

  const missingContract = await call('openid-bob', 'castRelationshipVote', {
    idempotencyKey: 'relation-vote-no-contract-0001',
    communityId,
    directionVersion: 2,
    fromCatId: bobRemotePetId,
    toCatId: remotePetId,
    choice: 'unsure'
  })
  assert.equal(missingContract.ok, false)
  assert.equal(missingContract.error.code, 'UNSUPPORTED_RELATIONSHIP_CONTRACT')

  const legacyWrite = await call('openid-bob', 'castRelationshipVote', {
    idempotencyKey: 'relation-vote-legacy-0001',
    communityId,
    catAId: remotePetId,
    catBId: bobRemotePetId,
    choice: 'housemate'
  })
  assert.equal(legacyWrite.ok, false)
  assert.equal(legacyWrite.error.code, 'LEGACY_RELATIONSHIP_READ_ONLY')

  repository.relationshipEdges.set('rel_legacy_pair', {
    id: 'rel_legacy_pair',
    communityId,
    catAId: remotePetId,
    catBId: bobRemotePetId,
    catA: { catId: remotePetId, displayName: '奶糖' },
    catB: { catId: bobRemotePetId, displayName: '豆包' },
    voteCounts: { bonded: 2, playmate: 1 },
    totalVotes: 3,
    state: 'active',
    updatedAt: new Date(nowMs).toISOString()
  })
  repository.relationshipVotes.set('rvote_legacy_bob', {
    id: 'rvote_legacy_bob',
    edgeId: 'rel_legacy_pair',
    communityId,
    ownerKey: ownerKeyFromOpenId(secret, 'openid-bob', 'v1'),
    choice: 'bonded'
  })
  const insightsWithLegacy = await call('openid-bob', 'listCommunityInsights', { communityId })
  const legacyRelationship = insightsWithLegacy.data.relationships.find(item => item.relationshipId === 'rel_legacy_pair')
  assert.equal(legacyRelationship.directionState, 'legacy_pending')
  assert.equal(legacyRelationship.directionVersion, 1)
  assert.equal(legacyRelationship.fromCat, null)
  assert.equal(legacyRelationship.toCat, null)
  assert.equal(legacyRelationship.distributionVisible, false)
  assert.equal(legacyRelationship.voteCounts, null)
  assert.equal(legacyRelationship.myChoice, '')

  const upload = await call('openid-alice', 'createUpload', {
    idempotencyKey: 'upload-session-0001',
    communityId,
    localPetId: 'pet_local_1700000000',
    source: 'camera',
    file: { mime: 'image/jpeg', sizeBytes: 1024 }
  })
  assert.equal(upload.ok, true)
  assert.match(upload.data.cloudPath, /^identity-pending\/[a-f0-9]{24}\/up_[a-f0-9]+\/source\.jpg$/)
  assert.equal(upload.data.cloudPath.includes('openid-alice'), false)

  const uploadRetry = await call('openid-alice', 'createUpload', {
    idempotencyKey: 'upload-session-0001',
    communityId,
    localPetId: 'pet_local_1700000000',
    source: 'camera',
    file: { mime: 'image/jpeg', sizeBytes: 1024 }
  })
  assert.equal(uploadRetry.ok, true)
  assert.equal(uploadRetry.data.uploadId, upload.data.uploadId)

  const wrongPath = await call('openid-alice', 'submitSighting', {
    idempotencyKey: 'submit-sighting-0001',
    uploadId: upload.data.uploadId,
    fileID: 'cloud://test.env/identity-pending/other/source.jpg'
  })
  assert.equal(wrongPath.ok, false)
  assert.equal(wrongPath.error.code, 'INVALID_FILE')

  const sourceFileID = `cloud://test.env/${upload.data.cloudPath}`
  files.set(sourceFileID, { mime: 'image/jpeg', sizeBytes: 1024, sha256: 'a'.repeat(64) })
  const submitted = await call('openid-alice', 'submitSighting', {
    idempotencyKey: 'submit-sighting-0001',
    uploadId: upload.data.uploadId,
    fileID: sourceFileID,
    observation: {
      observedAt: '2026-08-28T07:30:00.000Z',
      location: { source: 'map', longitude: 116.397, latitude: 39.908, accuracyM: 30, areaText: '测试路 88 号' }
    },
    openid: 'openid-bob',
    ownerKey: 'forged-owner'
  })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.data.state, 'PENDING_REVIEW')
  const sightingId = submitted.data.sightingId
  const storedSighting = repository.privateSightings.get(sightingId)
  assert.equal(storedSighting.ownerKey, storedAlice.ownerKey)
  assert.equal(storedSighting.exactLocation.longitude, 116.397)
  assert.equal(storedSighting.exactLocation.source, 'map')
  assert.equal(storedSighting.privateAreaText, '测试路 88 号')
  assert.equal(Object.prototype.hasOwnProperty.call(storedSighting.coarseLocation, 'areaText'), false)
  assert.match(storedSighting.coarseLocation.cellId, /^cell_[a-f0-9]{16}$/)
  assert.equal(storedSighting.coarseLocation.longitude, 116.39)
  assert.equal(storedSighting.coarseLocation.latitude, 39.91)
  assert.equal(storedSighting.observedTimeBucket, '2026-08-28T12:00+08:00')
  assert.equal(repository.publicSightings.size, 0)

  const submitRetry = await call('openid-alice', 'submitSighting', {
    idempotencyKey: 'submit-sighting-0001',
    uploadId: upload.data.uploadId,
    fileID: sourceFileID,
    observation: {
      observedAt: '2026-08-28T07:30:00.000Z',
      location: { source: 'map', longitude: 116.397, latitude: 39.908, accuracyM: 30, areaText: '测试路 88 号' }
    }
  })
  assert.equal(submitRetry.ok, true)
  assert.equal(submitRetry.data.sightingId, sightingId)
  assert.equal(repository.privateSightings.size, 1)

  const recoveredSubmit = await call('openid-alice', 'recoverSighting', {
    idempotencyKey: 'submit-sighting-0001',
    uploadId: upload.data.uploadId
  })
  assert.equal(recoveredSubmit.ok, true)
  assert.equal(recoveredSubmit.data.found, true)
  assert.equal(recoveredSubmit.data.sightingId, sightingId)

  const crossOwnerRecovery = await call('openid-bob', 'recoverSighting', {
    idempotencyKey: 'submit-sighting-0001',
    uploadId: upload.data.uploadId
  })
  assert.equal(crossOwnerRecovery.ok, true)
  assert.deepEqual(crossOwnerRecovery.data, { found: false, state: 'NOT_FOUND' })

  const submitConflict = await call('openid-alice', 'submitSighting', {
    idempotencyKey: 'submit-sighting-0001',
    uploadId: upload.data.uploadId,
    fileID: sourceFileID,
    observedAt: '2026-08-28T07:00:00.000Z'
  })
  assert.equal(submitConflict.ok, false)
  assert.equal(submitConflict.error.code, 'IDEMPOTENCY_CONFLICT')

  const secondUpload = await call('openid-alice', 'createUpload', {
    idempotencyKey: 'upload-session-0002',
    communityId,
    source: 'album',
    file: { mime: 'image/jpeg', sizeBytes: 1024 }
  })
  const secondFileID = `cloud://test.env/${secondUpload.data.cloudPath}`
  files.set(secondFileID, { mime: 'image/jpeg', sizeBytes: 1024, sha256: 'b'.repeat(64) })
  const crossSessionConflict = await call('openid-alice', 'submitSighting', {
    idempotencyKey: 'submit-sighting-0001',
    uploadId: secondUpload.data.uploadId,
    fileID: secondFileID
  })
  assert.equal(crossSessionConflict.ok, false)
  assert.equal(crossSessionConflict.error.code, 'IDEMPOTENCY_CONFLICT')

  const bobBeforeReview = await call('openid-bob', 'listWorkspace', { communityId })
  assert.equal(bobBeforeReview.ok, true)
  assert.equal(bobBeforeReview.data.pendingReview.length, 0)

  const aliceBeforeReview = await call('openid-alice', 'listWorkspace', { communityId })
  assert.equal(aliceBeforeReview.ok, true)
  assert.equal(aliceBeforeReview.data.pendingReview.length, 1)
  assert.equal(aliceBeforeReview.data.pendingReview[0].canReview, true)
  assert.equal(aliceBeforeReview.data.pendingReview[0].areaText, '测试路 88 号')
  assert.match(aliceBeforeReview.data.pendingReview[0].media.url, /^https:\/\/temporary\.example\//)

  const bobReview = await call('openid-bob', 'reviewSighting', {
    idempotencyKey: 'review-sighting-bob-0001',
    sightingId,
    expectedVersion: 1,
    decision: 'approved'
  })
  assert.equal(bobReview.ok, false)
  assert.equal(bobReview.error.code, 'FORBIDDEN')
  assert.equal(approveCalls, 0)

  const aliceReview = await call('openid-alice', 'reviewSighting', {
    idempotencyKey: 'review-sighting-0001',
    sightingId,
    expectedVersion: 1,
    decision: 'approved',
    note: '主体清楚，允许在邀请社区展示'
  })
  assert.equal(aliceReview.ok, true)
  assert.equal(aliceReview.data.state, 'APPROVED')
  assert.equal(aliceReview.data.version, 2)
  assert.equal(repository.publicSightings.size, 1)

  const aliceAfterReview = await call('openid-alice', 'listWorkspace', { communityId })
  assert.equal(aliceAfterReview.data.approvedSightings[0].catId, remotePetId)
  assert.equal(aliceAfterReview.data.approvedSightings[0].canEnroll, true)
  assert.equal(aliceAfterReview.data.approvedSightings[0].canMatch, false)

  const mapInsights = await call('openid-bob', 'listCommunityInsights', { communityId })
  assert.equal(mapInsights.ok, true)
  assert.equal(mapInsights.data.mapCells.length, 1)
  assert.equal(mapInsights.data.mapCells[0].sightingCount, 1)
  assert.equal(mapInsights.data.mapCells[0].longitude, 116.39)
  assert.equal(mapInsights.data.mapCells[0].areaText, '约 2 公里模糊热区')
  assert.equal(JSON.stringify(mapInsights.data).includes('"exactLocation":'), false)
  assert.equal(JSON.stringify(mapInsights.data).includes('测试路 88 号'), false)

  const reviewRetry = await call('openid-alice', 'reviewSighting', {
    idempotencyKey: 'review-sighting-0001',
    sightingId,
    expectedVersion: 1,
    decision: 'approved',
    note: repository.privateSightings.get(sightingId).reviewNote
  })
  assert.equal(reviewRetry.ok, true)
  assert.equal(reviewRetry.data.version, 2)
  assert.equal(repository.publicSightings.size, 1)
  assert.equal(approveCalls, 1, 'idempotent review retry does not duplicate media promotion')

  const reviewConflict = await call('openid-alice', 'reviewSighting', {
    idempotencyKey: 'review-sighting-0001',
    sightingId,
    expectedVersion: 1,
    decision: 'rejected',
    note: repository.privateSightings.get(sightingId).reviewNote
  })
  assert.equal(reviewConflict.ok, false)
  assert.equal(reviewConflict.error.code, 'IDEMPOTENCY_CONFLICT')

  const bobWorkspace = await call('openid-bob', 'listWorkspace', { communityId })
  assert.equal(bobWorkspace.ok, true)
  assert.equal(bobWorkspace.data.approvedSightings.length, 1)
  const workspaceJson = JSON.stringify(bobWorkspace)
  assert.equal(workspaceJson.includes('fileID'), false)
  assert.equal(workspaceJson.includes('cloud://'), false)
  assert.equal(workspaceJson.includes('owner_'), false)
  assert.equal(workspaceJson.includes('116.397'), false)
  assert.equal(workspaceJson.includes('39.908'), false)
  assert.equal(workspaceJson.includes('测试路 88 号'), false)
  assert.match(bobWorkspace.data.approvedSightings[0].media.url, /^https:\/\/temporary\.example\//)

  const approvedAsset = repository.assets.get(repository.privateSightings.get(sightingId).assetId)
  approvedAsset.sanitized = false
  const hiddenLegacy = await call('openid-bob', 'listWorkspace', { communityId })
  assert.equal(hiddenLegacy.data.approvedSightings.length, 0, 'legacy raw approved media stays private')

  const resanitized = await call('openid-alice', 'reviewSighting', {
    idempotencyKey: 'review-sighting-resanitize-0001',
    sightingId,
    expectedVersion: 2,
    decision: 'approved',
    note: '重新脱敏历史图片'
  })
  assert.equal(resanitized.ok, true)
  assert.equal(resanitized.data.version, 3)
  assert.equal(approveCalls, 2)
  assert.equal(repository.assets.get(approvedAsset.id).sanitized, true)
  const visibleAfterResanitize = await call('openid-bob', 'listWorkspace', { communityId })
  assert.equal(visibleAfterResanitize.data.approvedSightings.length, 1)

  const unknown = await call('openid-alice', 'dropDatabase')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'UNKNOWN_ACTION')

  const unconfigured = createCatOnlineCore({ repository: new MemoryRepository(), media, ownerSecret: '', clock: () => nowMs })
  const blocked = await unconfigured.handle({ action: 'bootstrap', requestId: 'blocked' }, { openid: 'openid-alice' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'CONFIG_ERROR')

  nowMs += 1000
  console.log('catOnline phase 1 pure core contract: PASS')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
