'use strict'

const crypto = require('crypto')

const SCHEMA_VERSION = 1
const OWNER_KEY_VERSION = 'v1'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const UPLOAD_TTL_MS = 15 * 60 * 1000
const ALLOWED_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
})
const REVIEW_ROLES = new Set(['owner', 'admin', 'reviewer'])
const FEEDBACK_CATEGORIES = Object.freeze(['bug', 'usability', 'feature', 'content', 'privacy', 'other'])
const FEEDBACK_STAGES = Object.freeze({
  RECEIVED: 'RECEIVED',
  INITIAL_REVIEW: 'INITIAL_REVIEW',
  LOCAL_REVIEW: 'LOCAL_REVIEW',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  STATUS_PENDING: 'STATUS_PENDING'
})
const RELATION_CHOICES = Object.freeze(['bonded', 'playmate', 'housemate', 'needs_space', 'unsure'])
const RELATION_CONTRACT_ID = 'cat-ai.relationship.directed'
const RELATION_CONTRACT_VERSION = 2
const RELATION_DIRECTION_VERSION = 2
const RELATION_DIRECTION_STATE = 'directed'
const RELATION_ROLE_LABELS = Object.freeze({
  bonded: Object.freeze({ from: '主动亲近方', to: '亲近对象' }),
  playmate: Object.freeze({ from: '玩耍发起方', to: '玩耍回应方' }),
  housemate: Object.freeze({ from: '平静共处方', to: '共处伙伴' }),
  needs_space: Object.freeze({ from: '需要空间方', to: '相处对象' }),
  unsure: Object.freeze({ from: '观察发起方', to: '观察对象' })
})
const ACTIONS = new Set([
  'health',
  'bootstrap',
  'createCommunity',
  'joinCommunity',
  'syncPet',
  'createUpload',
  'submitSighting',
  'recoverSighting',
  'listWorkspace',
  'listCommunityInsights',
  'castRelationshipVote',
  'reviewSighting',
  'submitFeedback',
  'listFeedbackCenter'
])

class DomainError extends Error {
  constructor(code, message, retryable) {
    super(message)
    this.name = 'DomainError'
    this.code = code || 'INTERNAL_ERROR'
    this.retryable = Boolean(retryable)
  }
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength)
}

function requireText(value, field, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new DomainError('VALIDATION_ERROR', `${field}不能为空`)
  return text
}

function requireIdempotencyKey(event) {
  const value = requireText(event && event.idempotencyKey, 'idempotencyKey', 128)
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new DomainError('VALIDATION_ERROR', 'idempotencyKey 格式不正确')
  }
  return value
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex')
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function relationshipDirectionKey(fromCatId, toCatId) {
  const from = requireText(fromCatId, 'fromCatId', 80)
  const to = requireText(toCatId, 'toCatId', 80)
  if (from === to) throw new DomainError('VALIDATION_ERROR', '请选择两只不同的猫咪')
  return `${from}::${to}`
}

function ownerKeyFromOpenId(secret, openid, version) {
  const safeOpenId = requireText(openid, 'OPENID', 256)
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new DomainError('CONFIG_ERROR', 'CAT_ONLINE_OWNER_SECRET 尚未配置为至少 32 字节')
  }
  const keyVersion = cleanText(version || OWNER_KEY_VERSION, 16) || OWNER_KEY_VERSION
  return `owner_${keyVersion}_${hmacHex(secret, `owner|${keyVersion}|${safeOpenId}`)}`
}

function stableId(prefix, secret, scope, length) {
  return `${prefix}_${hmacHex(secret, scope).slice(0, length || 28)}`
}

function inviteCodeFromDigest(digest) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let output = ''
  for (let index = 0; index < 10; index += 1) {
    const pair = digest.slice(index * 2, index * 2 + 2)
    output += alphabet[Number.parseInt(pair, 16) % alphabet.length]
  }
  return `${output.slice(0, 5)}-${output.slice(5)}`
}

function normalizeInviteCode(value) {
  return cleanText(value, 32).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function normalizeCloudFilePath(fileID, expectedEnvId) {
  const value = cleanText(fileID, 2048)
  const match = value.match(/^cloud:\/\/([^/]+)\/(.+)$/)
  if (!match) throw new DomainError('INVALID_FILE', '只接受当前云环境的 cloud:// 文件')
  const host = match[1].toLowerCase()
  const expected = cleanText(expectedEnvId, 160).toLowerCase()
  if (expected && host !== expected && !host.startsWith(`${expected}.`)) {
    throw new DomainError('INVALID_FILE', '云文件不属于当前 CloudBase 环境')
  }
  const path = match[2]
  if (!path || path.includes('..') || path.includes('\\') || path.includes('?') || path.includes('#')) {
    throw new DomainError('INVALID_FILE', '云文件路径无效')
  }
  return path
}

function normalizeMime(value) {
  const mime = cleanText(value, 64).toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_MIME, mime)) {
    throw new DomainError('UNSUPPORTED_MEDIA', '仅支持 JPG、PNG 或 WebP 图片')
  }
  return mime
}

function normalizeFileSize(value) {
  const size = Number(value)
  if (!Number.isInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
    throw new DomainError('INVALID_FILE_SIZE', '图片大小必须在 1 字节到 8MB 之间')
  }
  return size
}

function normalizeObservedAt(value, nowMs) {
  if (!value) return new Date(nowMs).toISOString()
  const time = Date.parse(String(value))
  if (!Number.isFinite(time)) throw new DomainError('VALIDATION_ERROR', '观察时间格式不正确')
  if (time > nowMs + 10 * 60 * 1000) throw new DomainError('VALIDATION_ERROR', '观察时间不能晚于当前时间')
  return new Date(time).toISOString()
}

function normalizeLocation(value, secret) {
  if (!value) return { exact: null, coarse: null, privateAreaText: '' }
  const privateAreaText = cleanText(value.areaText, 40)
  const longitude = Number(value.longitude)
  const latitude = Number(value.latitude)
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    if (privateAreaText) return { exact: null, coarse: null, privateAreaText }
    throw new DomainError('VALIDATION_ERROR', '位置格式不正确')
  }
  const source = cleanText(value.source, 16)
  if (source !== 'map') {
    throw new DomainError('VALIDATION_ERROR', '坐标只能来自用户主动地图选点')
  }
  const accuracyM = value.accuracyM == null ? null : Number(value.accuracyM)
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new DomainError('VALIDATION_ERROR', '位置坐标超出有效范围')
  }
  if (accuracyM != null && (!Number.isFinite(accuracyM) || accuracyM < 0 || accuracyM > 100000)) {
    throw new DomainError('VALIDATION_ERROR', '位置精度无效')
  }
  const gridSize = 0.02
  const longitudeBand = Math.floor((longitude + 180) / gridSize)
  const latitudeBand = Math.floor((latitude + 90) / gridSize)
  return {
    exact: {
      source,
      coordinateSystem: 'gcj02',
      longitude,
      latitude,
      accuracyM,
      visibility: 'private'
    },
    coarse: {
      cellId: `cell_${hmacHex(secret, `geo|${longitudeBand}|${latitudeBand}`).slice(0, 16)}`,
      precisionKm: 2,
      coordinateSystem: 'gcj02',
      longitude: Number((-180 + (longitudeBand + 0.5) * gridSize).toFixed(4)),
      latitude: Number((-90 + (latitudeBand + 0.5) * gridSize).toFixed(4))
    },
    privateAreaText
  }
}

function timeBucket(isoDate) {
  const date = new Date(isoDate)
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const hour = Math.floor(chinaTime.getUTCHours() / 6) * 6
  return `${chinaTime.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00+08:00`
}

function safeCommunity(community, role) {
  return {
    communityId: community.id,
    name: community.name,
    scope: community.scope,
    status: community.status,
    role: role || undefined,
    createdAt: community.createdAt
  }
}

function deriveFeedbackStage(feedback, proposal) {
  const feedbackStatus = cleanText(feedback && feedback.status, 40) || 'OPEN'
  const hasProposalLink = Boolean(cleanText(feedback && feedback.proposalId, 120))
  const proposalStatus = cleanText(proposal && proposal.status, 40)
  const stageUpdatedAt = proposal && (proposal.updatedAt || proposal.generatedAt) ||
    feedback && (feedback.updatedAt || feedback.createdAt)

  if (feedbackStatus === 'OPEN' && !hasProposalLink) {
    return { stage: FEEDBACK_STAGES.RECEIVED, stageUpdatedAt }
  }
  if (feedbackStatus === 'TRIAGED' && !hasProposalLink) {
    return { stage: FEEDBACK_STAGES.INITIAL_REVIEW, stageUpdatedAt }
  }
  if (feedbackStatus === 'CLOSED' && (!hasProposalLink || proposalStatus === 'COMPLETED')) {
    return { stage: FEEDBACK_STAGES.COMPLETED, stageUpdatedAt }
  }
  if (feedbackStatus !== 'INCLUDED_IN_PROPOSAL') {
    return { stage: FEEDBACK_STAGES.STATUS_PENDING, stageUpdatedAt }
  }

  const linkedStages = {
    READY_FOR_LOCAL_REVIEW: FEEDBACK_STAGES.LOCAL_REVIEW,
    AWAITING_ADMIN_APPROVAL: FEEDBACK_STAGES.LOCAL_REVIEW,
    APPROVED_FOR_LOCAL_EXECUTION: FEEDBACK_STAGES.LOCAL_REVIEW,
    EXECUTING: FEEDBACK_STAGES.EXECUTING,
    COMPLETED: FEEDBACK_STAGES.COMPLETED,
    REJECTED: FEEDBACK_STAGES.REJECTED,
    FAILED: FEEDBACK_STAGES.FAILED
  }
  return {
    stage: linkedStages[proposalStatus] || FEEDBACK_STAGES.STATUS_PENDING,
    stageUpdatedAt
  }
}

function safeFeedback(feedback, proposal) {
  const derived = deriveFeedbackStage(feedback, proposal)
  return {
    feedbackId: feedback.id,
    category: FEEDBACK_CATEGORIES.includes(feedback.category) ? feedback.category : 'other',
    title: cleanText(feedback.title, 60),
    status: cleanText(feedback.status, 40) || 'OPEN',
    createdAt: feedback.createdAt,
    updatedAt: feedback.updatedAt,
    stage: derived.stage,
    stageUpdatedAt: derived.stageUpdatedAt
  }
}

function safePet(pet) {
  return {
    remotePetId: pet.id,
    catId: pet.catId || pet.id,
    localPetId: pet.localPetId,
    communityId: pet.communityId,
    displayName: pet.displayName,
    breed: pet.breed || '',
    gender: pet.gender || '',
    coatColor: pet.coatColor || '',
    estimatedAge: pet.estimatedAge || '',
    syncFingerprint: pet.syncFingerprint || '',
    serverVersion: Number(pet.serverVersion) || 1,
    syncedAt: pet.updatedAt
  }
}

function safeCommunityCat(cat, actorOwnerKey) {
  return {
    catId: cat.id,
    displayName: cat.displayName || '未命名猫咪',
    breed: cat.breed || '',
    coatColor: cat.coatColor || '',
    source: cat.localPetId ? 'linked_pet' : 'identified_cat',
    isMine: Boolean(actorOwnerKey && cat.ownerKey === actorOwnerKey)
  }
}

function emptyVoteCounts() {
  return RELATION_CHOICES.reduce((output, choice) => {
    output[choice] = 0
    return output
  }, {})
}

function safeVoteCounts(value) {
  const counts = emptyVoteCounts()
  RELATION_CHOICES.forEach(choice => {
    const count = Number(value && value[choice])
    counts[choice] = Number.isInteger(count) && count > 0 ? count : 0
  })
  return counts
}

function safeRelationshipEdge(edge, myVote) {
  const counts = safeVoteCounts(edge && edge.voteCounts)
  const totalVotes = RELATION_CHOICES.reduce((sum, choice) => sum + counts[choice], 0)
  const expectedDirectionKey = edge && edge.fromCatId && edge.toCatId && edge.fromCatId !== edge.toCatId
    ? relationshipDirectionKey(edge.fromCatId, edge.toCatId)
    : ''
  const directed = Boolean(expectedDirectionKey &&
    edge.relationshipContractId === RELATION_CONTRACT_ID &&
    Number(edge.relationshipContractVersion) === RELATION_CONTRACT_VERSION &&
    Number(edge.directionVersion) === RELATION_DIRECTION_VERSION &&
    edge.directionState === RELATION_DIRECTION_STATE &&
    edge.directionKey === expectedDirectionKey &&
    edge.catAId === edge.fromCatId && edge.catBId === edge.toCatId)
  const directionKey = directed
    ? expectedDirectionKey
    : cleanText(edge && edge.directionKey, 192) || `legacy::${cleanText(edge && edge.id, 160)}`
  if (!directed) {
    // v1 stored an unordered pair and normalized the submitted cat order before
    // persisting each vote. Its original direction is therefore unrecoverable.
    // Keep the aggregate visible as a migration prompt, but never reinterpret a
    // legacy vote as a v2 directed vote or unlock it for a selected direction.
    return {
      relationshipId: edge.id,
      communityId: edge.communityId,
      relationshipContractId: cleanText(edge && edge.relationshipContractId, 96) || 'cat-ai.relationship.unordered',
      relationshipContractVersion: Number(edge && edge.relationshipContractVersion) || 1,
      directionVersion: Number(edge && edge.directionVersion) || 1,
      directionState: 'legacy_pending',
      directionKey,
      catA: edge.catA,
      catB: edge.catB,
      fromCat: null,
      toCat: null,
      totalVotes,
      voteCounts: null,
      distributionVisible: false,
      myChoice: '',
      roleLabels: null,
      updatedAt: edge.updatedAt
    }
  }
  // Blind voting is enforced at the response boundary for every role. Reviewers
  // can use a separate moderation surface later; this member-facing action never
  // returns the distribution before the current user has voted.
  const distributionVisible = Boolean(myVote)
  return {
    relationshipId: edge.id,
    communityId: edge.communityId,
    relationshipContractId: RELATION_CONTRACT_ID,
    relationshipContractVersion: RELATION_CONTRACT_VERSION,
    directionVersion: RELATION_DIRECTION_VERSION,
    directionState: RELATION_DIRECTION_STATE,
    directionKey,
    fromCat: edge.fromCat,
    toCat: edge.toCat,
    // Retain the old projections during the transition so identity-revocation
    // code and already deployed readers can still locate both endpoint cats.
    catA: edge.catA || edge.fromCat,
    catB: edge.catB || edge.toCat,
    totalVotes,
    voteCounts: distributionVisible ? counts : null,
    distributionVisible,
    myChoice: myVote ? myVote.choice : '',
    roleLabels: myVote ? RELATION_ROLE_LABELS[myVote.choice] : null,
    updatedAt: edge.updatedAt
  }
}

function aggregateMapCells(sightings) {
  const cells = new Map()
  ;(sightings || []).forEach(sighting => {
    const coarse = sighting && sighting.coarseLocation
    const longitude = Number(coarse && coarse.longitude)
    const latitude = Number(coarse && coarse.latitude)
    if (!coarse || !coarse.cellId || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return
    const existing = cells.get(coarse.cellId) || {
      cellId: coarse.cellId,
      longitude,
      latitude,
      precisionKm: Number(coarse.precisionKm) || 2,
      coordinateSystem: coarse.coordinateSystem || 'gcj02',
      areaText: '约 2 公里模糊热区',
      sightingCount: 0,
      catIds: new Set(),
      catNames: new Set(),
      latestTimeBucket: ''
    }
    existing.sightingCount += 1
    const catId = sighting.identityCatId || sighting.catId || sighting.remotePetId
    const cat = sighting.identityCat || sighting.cat
    if (catId) existing.catIds.add(catId)
    if (cat && cat.displayName) existing.catNames.add(cat.displayName)
    if (sighting.observedTimeBucket > existing.latestTimeBucket) existing.latestTimeBucket = sighting.observedTimeBucket
    cells.set(coarse.cellId, existing)
  })
  return Array.from(cells.values())
    .map(item => ({
      cellId: item.cellId,
      longitude: item.longitude,
      latitude: item.latitude,
      precisionKm: item.precisionKm,
      coordinateSystem: item.coordinateSystem,
      areaText: item.areaText,
      sightingCount: item.sightingCount,
      catCount: item.catIds.size,
      catNames: Array.from(item.catNames).slice(0, 4),
      latestTimeBucket: item.latestTimeBucket
    }))
    .sort((left, right) => right.sightingCount - left.sightingCount)
    .slice(0, 80)
}

function safeCoarseLocation(value) {
  if (!value || typeof value !== 'object') return null
  const longitude = Number(value.longitude)
  const latitude = Number(value.latitude)
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  return {
    cellId: cleanText(value.cellId, 80),
    precisionKm: Number(value.precisionKm) || 2,
    coordinateSystem: cleanText(value.coordinateSystem || 'gcj02', 16),
    longitude,
    latitude
  }
}

function safeMedia(mediaByKey, key) {
  const media = mediaByKey && mediaByKey[key]
  if (!media || !media.url) return null
  return {
    url: media.url,
    expiresAt: media.expiresAt || null
  }
}

function publicSighting(sighting, media, canMatch, isMine) {
  return {
    sightingId: sighting.id,
    communityId: sighting.communityId,
    state: sighting.state,
    version: sighting.version,
    catId: sighting.identityCatId || sighting.catId || sighting.remotePetId || null,
    cat: sighting.identityCat || sighting.cat || null,
    observedTimeBucket: sighting.observedTimeBucket,
    coarseLocation: safeCoarseLocation(sighting.coarseLocation),
    caption: sighting.caption || '',
    media: media || null,
    submittedAt: sighting.submittedAt,
    reviewedAt: sighting.reviewedAt || null,
    canMatch: Boolean(canMatch && !sighting.remotePetId && !sighting.identityCatId),
    canEnroll: Boolean(isMine && sighting.remotePetId && !sighting.identityTemplateReady),
    identityTemplateReady: Boolean(sighting.identityTemplateReady),
    isMine: Boolean(isMine)
  }
}

function pendingSighting(sighting, media, canReview, isMine) {
  return {
    sightingId: sighting.id,
    communityId: sighting.communityId,
    state: sighting.state,
    version: sighting.version,
    catId: sighting.catId || sighting.remotePetId || null,
    cat: sighting.cat || null,
    observedTimeBucket: sighting.observedTimeBucket,
    coarseLocation: safeCoarseLocation(sighting.coarseLocation),
    areaText: cleanText(sighting.privateAreaText || (sighting.coarseLocation && sighting.coarseLocation.areaText), 40),
    caption: sighting.caption || '',
    media: media || null,
    submittedAt: sighting.submittedAt,
    canReview: Boolean(canReview),
    isMine: Boolean(isMine)
  }
}

function errorResponse(error, requestId, nowIso) {
  const known = error instanceof DomainError
  return {
    ok: false,
    requestId,
    serverTime: nowIso,
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '服务暂时不可用，请稍后再试',
      retryable: known ? error.retryable : true
    }
  }
}

function assertRepository(repository) {
  const methods = [
    'ensureUser', 'listMemberships', 'createCommunity', 'findCommunityByInviteHash',
    'joinCommunity', 'getMembership', 'upsertPet', 'getPet', 'createUpload',
    'getUpload', 'submitSighting', 'listWorkspace', 'getSighting', 'reviewSighting',
    'getCommunityCat', 'listCommunityInsights', 'castRelationshipVote',
    'createFeedback', 'listMyFeedback', 'listChangeProposalsByIds'
  ]
  methods.forEach(method => {
    if (!repository || typeof repository[method] !== 'function') {
      throw new Error(`catOnline repository missing ${method}()`)
    }
  })
}

function createCatOnlineCore(options) {
  const settings = options || {}
  const repository = settings.repository
  const media = settings.media || {}
  const clock = typeof settings.clock === 'function' ? settings.clock : () => Date.now()
  const ownerSecret = cleanText(settings.ownerSecret, 512)
  const cloudEnvId = cleanText(settings.cloudEnvId, 160)
  const ownerKeyVersion = cleanText(settings.ownerKeyVersion || OWNER_KEY_VERSION, 16) || OWNER_KEY_VERSION
  assertRepository(repository)

  async function ensureActor(context, now) {
    const openid = context && context.openid
    if (!openid) throw new DomainError('AUTH_REQUIRED', '无法获取微信用户身份')
    const ownerKey = ownerKeyFromOpenId(ownerSecret, openid, ownerKeyVersion)
    const user = {
      id: stableId('usr', ownerSecret, `user|${ownerKey}`),
      ownerKey,
      ownerKeyVersion,
      publicUserId: stableId('user', ownerSecret, `public|${ownerKey}`, 20),
      createdAt: now,
      updatedAt: now
    }
    await repository.ensureUser(user)
    return user
  }

  async function requireMembership(communityId, ownerKey, roles) {
    const id = requireText(communityId, 'communityId', 80)
    const membership = await repository.getMembership(id, ownerKey)
    if (!membership || membership.status !== 'active') {
      throw new DomainError('FORBIDDEN', '你还不是该邀请社区的成员')
    }
    if (roles && !roles.has(membership.role)) {
      throw new DomainError('FORBIDDEN', '当前成员角色不能执行此操作')
    }
    return membership
  }

  async function health() {
    return {
      service: 'catOnline',
      phase: 'phase1-manual',
      schemaVersion: SCHEMA_VERSION,
      relationshipContract: {
        id: RELATION_CONTRACT_ID,
        version: RELATION_CONTRACT_VERSION,
        directionVersion: RELATION_DIRECTION_VERSION,
        directionState: RELATION_DIRECTION_STATE,
        edgeUniqueness: 'communityId+directionKey',
        bidirectionalEdgesIndependent: true,
        canonicalEndpoints: true,
        evidenceSupported: false,
        legacyWritesAllowed: false
      },
      ownerSecretConfigured: Buffer.byteLength(ownerSecret, 'utf8') >= 32
    }
  }

  async function bootstrap(event, actor, now) {
    const consentVersion = cleanText(event.consentVersion, 64)
    if (consentVersion && typeof repository.updateConsent === 'function') {
      await repository.updateConsent(actor.id, consentVersion, now)
    }
    const memberships = await repository.listMemberships(actor.ownerKey)
    return {
      communities: memberships.map(item => safeCommunity(item.community, item.membership.role)),
      capabilities: {
        manualReview: true,
        modelMatching: false,
        relationshipVoting: true,
        coarseLocationMap: true,
        optionalLocation: true,
        localCloudLinking: true,
        userFeedback: true
      }
    }
  }

  async function submitFeedback(event, actor, now) {
    const idempotencyKey = requireIdempotencyKey(event)
    const category = cleanText(event.category, 24).toLowerCase()
    if (!FEEDBACK_CATEGORIES.includes(category)) {
      throw new DomainError('VALIDATION_ERROR', '反馈分类无效')
    }
    const title = requireText(event.title, '反馈标题', 60)
    const content = requireText(event.content, '反馈内容', 1000)
    const steps = cleanText(event.steps, 500)
    const client = event.client && typeof event.client === 'object' ? event.client : {}
    const requestHash = sha256Hex(JSON.stringify({ category, title, content, steps }))
    const feedback = {
      id: stableId('fb', ownerSecret, `feedback|${actor.ownerKey}|${idempotencyKey}`, 28),
      ownerKey: actor.ownerKey,
      publicUserId: actor.publicUserId,
      category,
      title,
      content,
      steps,
      client: {
        version: cleanText(client.version, 40),
        platform: cleanText(client.platform, 24),
        sdkVersion: cleanText(client.sdkVersion, 32),
        sourcePage: cleanText(client.sourcePage, 80)
      },
      status: 'OPEN',
      version: 1,
      idempotencyKey,
      requestHash,
      createdAt: now,
      updatedAt: now
    }
    const saved = await repository.createFeedback(feedback)
    if (saved.ownerKey !== actor.ownerKey || saved.requestHash !== requestHash) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', '此幂等键已用于另一条反馈')
    }
    return { feedback: safeFeedback(saved) }
  }

  async function listFeedbackCenter(event, actor) {
    const myFeedback = await repository.listMyFeedback(actor.ownerKey)
    const feedbackRows = myFeedback || []
    const proposalIds = Array.from(new Set(feedbackRows
      .map(item => cleanText(item && item.proposalId, 120))
      .filter(Boolean)))
    const linkedProposals = proposalIds.length
      ? await repository.listChangeProposalsByIds(proposalIds)
      : []
    const linkedById = new Map((linkedProposals || []).map(item => [item.id, item]))
    return {
      myFeedback: feedbackRows.map(item => safeFeedback(item, linkedById.get(item.proposalId))),
      policy: {
        feedbackOnlyClient: true,
        codeExecutionLocation: 'local-only',
        feedbackIsUntrustedInput: true
      }
    }
  }

  async function createCommunity(event, actor, now) {
    const idempotencyKey = requireIdempotencyKey(event)
    const name = requireText(event.name, '社区名称', 40)
    const scope = event.scope === 'private' ? 'private' : 'invite'
    const communityId = stableId('com', ownerSecret, `community|${actor.ownerKey}|${idempotencyKey}`, 24)
    const inviteDigest = hmacHex(ownerSecret, `invite-code|${actor.ownerKey}|${idempotencyKey}`)
    const inviteCode = inviteCodeFromDigest(inviteDigest)
    const inviteHash = hmacHex(ownerSecret, `invite-hash|${normalizeInviteCode(inviteCode)}`)
    const community = {
      id: communityId,
      name,
      scope,
      status: 'active',
      inviteHash,
      creatorOwnerKey: actor.ownerKey,
      requestHash: sha256Hex(JSON.stringify({ name, scope })),
      createdAt: now,
      updatedAt: now
    }
    const membership = {
      id: stableId('mem', ownerSecret, `member|${communityId}|${actor.ownerKey}`),
      communityId,
      ownerKey: actor.ownerKey,
      role: 'owner',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
    const saved = await repository.createCommunity(community, membership)
    if (saved.requestHash && saved.requestHash !== community.requestHash) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', '此幂等键已用于其他社区参数')
    }
    return { community: safeCommunity(saved, 'owner'), inviteCode }
  }

  async function joinCommunity(event, actor, now) {
    const normalizedCode = normalizeInviteCode(requireText(event.inviteCode, '邀请码', 32))
    if (normalizedCode.length !== 10) throw new DomainError('INVALID_INVITE', '邀请码格式不正确')
    const inviteHash = hmacHex(ownerSecret, `invite-hash|${normalizedCode}`)
    const community = await repository.findCommunityByInviteHash(inviteHash)
    if (!community || community.status !== 'active' || community.scope !== 'invite') {
      throw new DomainError('INVALID_INVITE', '邀请码无效或已停用')
    }
    const membership = {
      id: stableId('mem', ownerSecret, `member|${community.id}|${actor.ownerKey}`),
      communityId: community.id,
      ownerKey: actor.ownerKey,
      role: 'member',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
    const saved = await repository.joinCommunity(community, membership)
    return { community: safeCommunity(community, saved.role) }
  }

  async function syncPet(event, actor, now) {
    const communityId = requireText(event.communityId, 'communityId', 80)
    await requireMembership(communityId, actor.ownerKey)
    const input = event.pet || event
    const localPetId = requireText(input.localPetId, 'localPetId', 120)
    const displayName = requireText(input.displayName || input.name, '猫咪昵称', 40)
    const remotePetId = stableId('pet', ownerSecret, `pet|${communityId}|${actor.ownerKey}|${localPetId}`, 28)
    const syncFingerprint = cleanText(input.syncFingerprint, 32)
    if (syncFingerprint && !/^[a-f0-9]{16}$/i.test(syncFingerprint)) {
      throw new DomainError('VALIDATION_ERROR', 'syncFingerprint 格式不正确')
    }
    const pet = {
      id: remotePetId,
      catId: remotePetId,
      ownerKey: actor.ownerKey,
      communityId,
      localPetId,
      displayName,
      breed: cleanText(input.breed, 60),
      gender: cleanText(input.gender, 20),
      coatColor: cleanText(input.coatColor, 60),
      estimatedAge: cleanText(input.estimatedAge, 40),
      syncFingerprint: syncFingerprint.toLowerCase(),
      serverVersion: 1,
      state: 'active',
      createdAt: now,
      updatedAt: now
    }
    const saved = await repository.upsertPet(pet)
    return { pet: safePet(saved) }
  }

  async function createUpload(event, actor, now) {
    const idempotencyKey = requireIdempotencyKey(event)
    const communityId = requireText(event.communityId, 'communityId', 80)
    await requireMembership(communityId, actor.ownerKey)
    const file = event.file || {}
    const mime = normalizeMime(file.mime)
    const sizeBytes = normalizeFileSize(file.sizeBytes)
    const localPetId = cleanText(event.localPetId, 120)
    let remotePetId = ''
    if (localPetId) {
      remotePetId = stableId('pet', ownerSecret, `pet|${communityId}|${actor.ownerKey}|${localPetId}`, 28)
      const pet = await repository.getPet(remotePetId)
      if (!pet || pet.ownerKey !== actor.ownerKey || pet.communityId !== communityId) {
        throw new DomainError('PET_NOT_SYNCED', '请先将这份本地猫咪档案连接到该社区')
      }
    }
    const uploadId = stableId('up', ownerSecret, `upload|${actor.ownerKey}|${idempotencyKey}`, 28)
    const opaqueBucket = hmacHex(ownerSecret, `bucket|${actor.ownerKey}`).slice(0, 24)
    const extension = ALLOWED_MIME[mime]
    const expectedPath = `identity-pending/${opaqueBucket}/${uploadId}/source.${extension}`
    const requestHash = sha256Hex(JSON.stringify({ communityId, mime, sizeBytes, localPetId, source: cleanText(event.source, 16) }))
    const session = {
      id: uploadId,
      ownerKey: actor.ownerKey,
      communityId,
      remotePetId: remotePetId || null,
      expectedPath,
      expectedMime: mime,
      expectedSizeBytes: sizeBytes,
      state: 'CREATED',
      idempotencyKey,
      requestHash,
      source: ['camera', 'album'].includes(event.source) ? event.source : 'unknown',
      expiresAt: new Date(Date.parse(now) + UPLOAD_TTL_MS).toISOString(),
      createdAt: now,
      updatedAt: now
    }
    const saved = await repository.createUpload(session)
    if (saved.requestHash !== requestHash) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', '此幂等键已用于其他上传参数')
    }
    return {
      uploadId: saved.id,
      cloudPath: saved.expectedPath,
      expiresAt: saved.expiresAt,
      maxBytes: MAX_IMAGE_BYTES,
      acceptedMime: Object.keys(ALLOWED_MIME)
    }
  }

  async function submitSighting(event, actor, now) {
    const idempotencyKey = requireIdempotencyKey(event)
    const uploadId = requireText(event.uploadId, 'uploadId', 80)
    const fileID = requireText(event.fileID, 'fileID', 2048)
    const session = await repository.getUpload(uploadId)
    if (!session || session.ownerKey !== actor.ownerKey) {
      throw new DomainError('UPLOAD_NOT_FOUND', '上传会话不存在或不属于当前用户')
    }
    await requireMembership(session.communityId, actor.ownerKey)
    const actualPath = normalizeCloudFilePath(fileID, cloudEnvId)
    if (actualPath !== session.expectedPath) throw new DomainError('INVALID_FILE', '文件路径与上传会话不匹配')
    const suppliedObservedAt = event.observedAt || (event.observation && event.observation.observedAt) || ''
    const observedAt = normalizeObservedAt(suppliedObservedAt, Date.parse(now))
    const rawLocation = event.location || (event.observation && event.observation.location)
    const location = normalizeLocation(rawLocation, ownerSecret)
    const requestHash = sha256Hex(JSON.stringify({
      uploadId,
      path: actualPath,
      observedAt: suppliedObservedAt ? observedAt : null,
      location,
      caption: cleanText(event.caption, 160),
      remotePetId: session.remotePetId
    }))
    if (session.state === 'SUBMITTED') {
      if (session.submitIdempotencyKey !== idempotencyKey || session.submitRequestHash !== requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', '重复提交参数不一致')
      }
      const existing = await repository.getSighting(session.sightingId)
      if (!existing) throw new DomainError('INTERNAL_ERROR', '提交记录不完整，请联系管理员', true)
      return { sightingId: existing.sighting.id, state: existing.sighting.state, version: existing.sighting.version }
    }
    if (session.state !== 'CREATED') throw new DomainError('UPLOAD_ALREADY_USED', '上传会话不可再次使用')
    if (Date.parse(session.expiresAt) <= Date.parse(now)) throw new DomainError('UPLOAD_EXPIRED', '上传会话已过期，请重新选择图片')
    if (typeof media.inspect !== 'function') throw new DomainError('CONFIG_ERROR', '图片检查服务未配置')
    const inspected = await media.inspect({
      fileID,
      expectedMime: session.expectedMime,
      expectedSizeBytes: session.expectedSizeBytes,
      maxBytes: MAX_IMAGE_BYTES
    })
    if (!inspected || inspected.mime !== session.expectedMime || !Number.isInteger(inspected.sizeBytes) || inspected.sizeBytes > MAX_IMAGE_BYTES) {
      throw new DomainError('INVALID_FILE', '图片内容与声明不一致')
    }
    const sightingId = stableId('sig', ownerSecret, `sighting|${actor.ownerKey}|${idempotencyKey}`, 28)
    const assetId = stableId('asset', ownerSecret, `asset|${sightingId}`, 28)
    let cat = null
    if (session.remotePetId) {
      const pet = await repository.getPet(session.remotePetId)
      if (!pet || pet.ownerKey !== actor.ownerKey) throw new DomainError('PET_NOT_SYNCED', '关联的本地猫咪档案不存在')
      cat = { remotePetId: pet.id, catId: pet.catId || pet.id, displayName: pet.displayName }
    }
    const sighting = {
      id: sightingId,
      ownerKey: actor.ownerKey,
      communityId: session.communityId,
      assetId,
      remotePetId: session.remotePetId || null,
      catId: cat && cat.catId || null,
      cat,
      state: 'PENDING_REVIEW',
      version: 1,
      observedAt,
      observedTimeBucket: timeBucket(observedAt),
      exactLocation: location.exact,
      coarseLocation: location.coarse,
      privateAreaText: location.privateAreaText,
      caption: cleanText(event.caption, 160),
      submitIdempotencyKey: idempotencyKey,
      submitRequestHash: requestHash,
      submittedAt: now,
      createdAt: now,
      updatedAt: now
    }
    const asset = {
      id: assetId,
      ownerKey: actor.ownerKey,
      communityId: session.communityId,
      uploadId,
      sourceFileID: fileID,
      sourcePath: session.expectedPath,
      approvedFileID: null,
      mime: inspected.mime,
      sizeBytes: inspected.sizeBytes,
      sha256: cleanText(inspected.sha256, 128),
      state: 'PENDING_REVIEW',
      createdAt: now,
      updatedAt: now
    }
    const saved = await repository.submitSighting({
      session,
      asset,
      sighting,
      idempotencyKey,
      requestHash,
      now
    })
    return { sightingId: saved.id, state: saved.state, version: saved.version }
  }

  async function recoverSighting(event, actor) {
    const idempotencyKey = requireIdempotencyKey(event)
    const expectedSightingId = stableId('sig', ownerSecret, `sighting|${actor.ownerKey}|${idempotencyKey}`, 28)
    let internal = await repository.getSighting(expectedSightingId)
    if (internal && internal.sighting.ownerKey === actor.ownerKey &&
        internal.sighting.submitIdempotencyKey === idempotencyKey) {
      await requireMembership(internal.sighting.communityId, actor.ownerKey)
      return {
        found: true,
        sightingId: internal.sighting.id,
        communityId: internal.sighting.communityId,
        state: internal.sighting.state,
        version: internal.sighting.version
      }
    }

    const uploadId = cleanText(event.uploadId, 80)
    if (!uploadId) return { found: false, state: 'NOT_FOUND' }
    const session = await repository.getUpload(uploadId)
    if (!session || session.ownerKey !== actor.ownerKey) return { found: false, state: 'NOT_FOUND' }
    await requireMembership(session.communityId, actor.ownerKey)
    if (session.state === 'SUBMITTED' && session.submitIdempotencyKey === idempotencyKey && session.sightingId) {
      internal = await repository.getSighting(session.sightingId)
      if (internal && internal.sighting.ownerKey === actor.ownerKey) {
        return {
          found: true,
          sightingId: internal.sighting.id,
          communityId: internal.sighting.communityId,
          state: internal.sighting.state,
          version: internal.sighting.version
        }
      }
    }
    return {
      found: false,
      state: session.state === 'CREATED' ? 'PENDING' : 'NOT_FOUND',
      expiresAt: session.expiresAt || null
    }
  }

  async function listWorkspace(event, actor) {
    const communityId = requireText(event.communityId, 'communityId', 80)
    const membership = await requireMembership(communityId, actor.ownerKey)
    const workspace = await repository.listWorkspace(communityId, actor.ownerKey)
    const canReview = REVIEW_ROLES.has(membership.role)
    const visiblePending = (workspace.pending || []).filter(item => canReview || item.sighting.ownerKey === actor.ownerKey)
    // Legacy approved objects may still be byte-for-byte copies containing EXIF.
    // They remain private until a reviewer reprocesses them through the sanitizer.
    const visibleApproved = (workspace.approved || []).filter(item => item.asset && item.asset.sanitized === true)
    const mediaRequests = []
    visiblePending.forEach(item => {
      if (item.asset && item.asset.sourceFileID) mediaRequests.push({ key: `pending:${item.sighting.id}`, fileID: item.asset.sourceFileID })
    })
    visibleApproved.forEach(item => {
      if (item.asset && item.asset.approvedFileID) mediaRequests.push({ key: `approved:${item.sighting.id}`, fileID: item.asset.approvedFileID })
    })
    let mediaByKey = {}
    if (mediaRequests.length && typeof media.getTempUrls === 'function') {
      mediaByKey = await media.getTempUrls(mediaRequests)
    }
    return {
      community: safeCommunity(workspace.community, membership.role),
      myPets: (workspace.myPets || []).map(safePet),
      pendingReview: visiblePending.map(item => pendingSighting(
        item.sighting,
        safeMedia(mediaByKey, `pending:${item.sighting.id}`),
        canReview,
        item.sighting.ownerKey === actor.ownerKey
      )),
      approvedSightings: visibleApproved.map(item => publicSighting(
        item.sighting,
        safeMedia(mediaByKey, `approved:${item.sighting.id}`),
        canReview || item.sighting.ownerKey === actor.ownerKey,
        item.sighting.ownerKey === actor.ownerKey
      ))
    }
  }

  async function listCommunityInsights(event, actor) {
    const communityId = requireText(event.communityId, 'communityId', 80)
    const membership = await requireMembership(communityId, actor.ownerKey)
    const insights = await repository.listCommunityInsights(communityId, actor.ownerKey)
    if (insights.myVotesTruncated) {
      throw new DomainError('RELATIONSHIP_VOTE_SET_TOO_LARGE', '你的关系投票记录过多，请联系管理员归档后重试')
    }
    const myVotes = new Map((insights.myVotes || []).map(item => [item.edgeId, item]))
    const cats = (insights.cats || []).map(cat => safeCommunityCat(cat, actor.ownerKey))
    const catsById = new Map(cats.map(cat => [cat.catId, cat]))
    const activeCatIds = new Set(cats.map(cat => cat.catId))
    const activeEdges = (insights.edges || []).filter(edge => {
      const directed = Number(edge && edge.directionVersion) === RELATION_DIRECTION_VERSION &&
        edge && edge.fromCatId && edge.toCatId
      const firstId = directed ? edge.fromCatId : edge.catAId
      const secondId = directed ? edge.toCatId : edge.catBId
      return firstId !== secondId && activeCatIds.has(firstId) && activeCatIds.has(secondId)
    })
    return {
      communityId,
      cats,
      relationships: activeEdges.map(edge => {
        const directed = Number(edge && edge.directionVersion) === RELATION_DIRECTION_VERSION
        if (!directed) return safeRelationshipEdge(edge, myVotes.get(edge.id))
        const fromCat = catsById.get(edge.fromCatId)
        const toCat = catsById.get(edge.toCatId)
        return safeRelationshipEdge(Object.assign({}, edge, {
          fromCat,
          toCat,
          catA: fromCat,
          catB: toCat
        }), myVotes.get(edge.id))
      }),
      mapCells: aggregateMapCells(insights.sightings || []),
      policy: {
        blindBeforeVote: true,
        relationshipContractId: RELATION_CONTRACT_ID,
        relationshipContractVersion: RELATION_CONTRACT_VERSION,
        relationshipDirectionVersion: RELATION_DIRECTION_VERSION,
        relationshipDirectionState: RELATION_DIRECTION_STATE,
        relationshipEdgeUniqueness: 'communityId+directionKey',
        bidirectionalEdgesIndependent: true,
        legacyRelationshipWritesAllowed: false,
        relationshipEvidenceSupported: false,
        automaticIdentityMerge: false,
        exactLocationReturned: false,
        catsTruncated: Boolean(insights.catsTruncated),
        relationshipTruncated: Boolean(insights.relationshipsTruncated),
        relationshipReadLimit: 100,
        mapTruncated: (insights.sightings || []).length >= 100
      }
    }
  }

  async function castRelationshipVote(event, actor, now) {
    const idempotencyKey = requireIdempotencyKey(event)
    const communityId = requireText(event.communityId, 'communityId', 80)
    const membership = await requireMembership(communityId, actor.ownerKey)
    if (Number(event.directionVersion) !== RELATION_DIRECTION_VERSION) {
      throw new DomainError('LEGACY_RELATIONSHIP_READ_ONLY', '旧版无向关系只读，请更新小程序后重新确认箭头方向')
    }
    if (event.relationshipContractId !== RELATION_CONTRACT_ID ||
        Number(event.relationshipContractVersion) !== RELATION_CONTRACT_VERSION) {
      throw new DomainError('UNSUPPORTED_RELATIONSHIP_CONTRACT', '猫际关系契约版本不受支持，请更新小程序')
    }
    const requestedFromCatId = requireText(event.fromCatId, 'fromCatId', 80)
    const requestedToCatId = requireText(event.toCatId, 'toCatId', 80)
    relationshipDirectionKey(requestedFromCatId, requestedToCatId)
    const choice = cleanText(event.choice, 24)
    if (!RELATION_CHOICES.includes(choice)) throw new DomainError('VALIDATION_ERROR', '关系投票选项无效')
    const [fromCat, toCat] = await Promise.all([
      repository.getCommunityCat(communityId, requestedFromCatId),
      repository.getCommunityCat(communityId, requestedToCatId)
    ])
    if (!fromCat || !toCat) throw new DomainError('CAT_NOT_FOUND', '所选猫咪不属于当前小屋')
    const fromCatId = requireText(fromCat.id, 'canonicalFromCatId', 80)
    const toCatId = requireText(toCat.id, 'canonicalToCatId', 80)
    const directionKey = relationshipDirectionKey(fromCatId, toCatId)
    const evidenceSightingIds = Array.from(new Set((Array.isArray(event.evidenceSightingIds) ? event.evidenceSightingIds : [])
      .map(value => cleanText(value, 80))
      .filter(Boolean)))
      .slice(0, 3)
    if (evidenceSightingIds.length) {
      throw new DomainError('RELATIONSHIP_EVIDENCE_UNAVAILABLE', '关系证据关联尚未开放，请先提交不含证据的观察')
    }
    const edgeId = stableId('drel', ownerSecret,
      `directed-relationship-v${RELATION_DIRECTION_VERSION}|${communityId}|${fromCatId}|${toCatId}`, 28)
    const voteId = stableId('drvote', ownerSecret, `directed-relationship-vote|${edgeId}|${actor.ownerKey}`, 28)
    const requestHash = sha256Hex(JSON.stringify({
      communityId,
      relationshipContractId: RELATION_CONTRACT_ID,
      relationshipContractVersion: RELATION_CONTRACT_VERSION,
      directionVersion: RELATION_DIRECTION_VERSION,
      fromCatId,
      toCatId,
      choice,
      evidenceSightingIds
    }))
    const edge = {
      id: edgeId,
      communityId,
      relationshipContractId: RELATION_CONTRACT_ID,
      relationshipContractVersion: RELATION_CONTRACT_VERSION,
      directionVersion: RELATION_DIRECTION_VERSION,
      directionState: RELATION_DIRECTION_STATE,
      directionKey,
      fromCatId,
      toCatId,
      fromCat: { catId: fromCat.id, displayName: fromCat.displayName || '未命名猫咪' },
      toCat: { catId: toCat.id, displayName: toCat.displayName || '未命名猫咪' },
      // Compatibility fields are intentionally directional rather than sorted.
      // Identity revocation queries both columns, so either endpoint is fenced.
      catAId: fromCatId,
      catBId: toCatId,
      catA: { catId: fromCat.id, displayName: fromCat.displayName || '未命名猫咪' },
      catB: { catId: toCat.id, displayName: toCat.displayName || '未命名猫咪' },
      voteCounts: emptyVoteCounts(),
      totalVotes: 0,
      state: 'active',
      createdAt: now,
      updatedAt: now
    }
    const vote = {
      id: voteId,
      edgeId,
      communityId,
      relationshipContractId: RELATION_CONTRACT_ID,
      relationshipContractVersion: RELATION_CONTRACT_VERSION,
      directionVersion: RELATION_DIRECTION_VERSION,
      directionState: RELATION_DIRECTION_STATE,
      directionKey,
      fromCatId,
      toCatId,
      ownerKey: actor.ownerKey,
      membershipId: membership.id,
      choice,
      evidenceSightingIds,
      idempotencyKey,
      requestHash,
      createdAt: now,
      updatedAt: now
    }
    const saved = await repository.castRelationshipVote({
      edge,
      vote,
      membershipId: membership.id,
      actorOwnerKey: actor.ownerKey,
      now
    })
    return { relationship: safeRelationshipEdge(saved.edge, saved.vote, true) }
  }

  async function reviewSighting(event, actor, now) {
    const idempotencyKey = requireIdempotencyKey(event)
    const sightingId = requireText(event.sightingId, 'sightingId', 80)
    const decision = cleanText(event.decision, 16).toLowerCase()
    if (!['approved', 'rejected'].includes(decision)) {
      throw new DomainError('VALIDATION_ERROR', 'decision 只能是 approved 或 rejected')
    }
    const expectedVersion = Number(event.expectedVersion)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new DomainError('VALIDATION_ERROR', 'expectedVersion 无效')
    }
    const internal = await repository.getSighting(sightingId)
    if (!internal) throw new DomainError('NOT_FOUND', '目击记录不存在')
    const membership = await requireMembership(internal.sighting.communityId, actor.ownerKey, REVIEW_ROLES)
    const note = cleanText(event.note, 160)
    const reviewRequestHash = sha256Hex(JSON.stringify({ sightingId, decision, note }))
    const legacyResanitize = internal.sighting.state === 'APPROVED' &&
      decision === 'approved' && internal.asset && internal.asset.sanitized !== true
    if (internal.sighting.state !== 'PENDING_REVIEW') {
      if (internal.sighting.lastReviewIdempotencyKey === idempotencyKey) {
        if (internal.sighting.lastReviewRequestHash !== reviewRequestHash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', '同一审核幂等键不能用于不同决定')
        }
        return {
          sightingId: internal.sighting.id,
          state: internal.sighting.state,
          version: internal.sighting.version,
          reviewedAt: internal.sighting.reviewedAt
        }
      }
      if (!legacyResanitize) throw new DomainError('STATE_CONFLICT', '这条目击已经被审核')
    }
    if (internal.sighting.version !== expectedVersion) {
      throw new DomainError('VERSION_CONFLICT', '记录已更新，请刷新后再审核')
    }
    let approvedMedia = null
    if (decision === 'approved') {
      if (typeof media.approve !== 'function') throw new DomainError('CONFIG_ERROR', '图片发布服务未配置')
      approvedMedia = await media.approve({
        sourceFileID: legacyResanitize ? internal.asset.approvedFileID : internal.asset.sourceFileID,
        sightingId,
        assetId: internal.asset.id,
        mime: internal.asset.mime,
        sizeBytes: internal.asset.sizeBytes,
        sha256: internal.asset.sha256
      })
      if (!approvedMedia || !approvedMedia.fileID ||
          !/^[0-9a-f]{64}$/.test(String(approvedMedia.sha256 || '')) ||
          approvedMedia.mime !== 'image/jpeg' ||
          !Number.isInteger(approvedMedia.sizeBytes) || approvedMedia.sizeBytes < 1 ||
          approvedMedia.sizeBytes > MAX_IMAGE_BYTES) {
        throw new DomainError('MEDIA_PROMOTION_FAILED', '图片脱敏发布失败', true)
      }
    }
    const reviewed = await repository.reviewSighting({
      sightingId,
      decision,
      expectedVersion,
      idempotencyKey,
      reviewerOwnerKey: actor.ownerKey,
      reviewerMembershipId: membership.id,
      reviewerRole: membership.role,
      note,
      reviewRequestHash,
      approvedFileID: approvedMedia && approvedMedia.fileID,
      approvedPath: approvedMedia && approvedMedia.cloudPath,
      approvedSha256: approvedMedia && approvedMedia.sha256,
      approvedMime: approvedMedia && approvedMedia.mime,
      approvedSizeBytes: approvedMedia && approvedMedia.sizeBytes,
      legacyResanitize,
      now
    })
    if (decision === 'approved' && typeof media.cleanup === 'function') {
      const oldFileID = legacyResanitize ? internal.asset.approvedFileID : internal.asset.sourceFileID
      try { await media.cleanup(oldFileID) } catch (error) { /* retention cleanup is best effort */ }
    }
    return {
      sightingId: reviewed.id,
      state: reviewed.state,
      version: reviewed.version,
      reviewedAt: reviewed.reviewedAt
    }
  }

  const handlers = {
    health,
    bootstrap,
    createCommunity,
    joinCommunity,
    syncPet,
    createUpload,
    submitSighting,
    recoverSighting,
    listWorkspace,
    listCommunityInsights,
    castRelationshipVote,
    reviewSighting,
    submitFeedback,
    listFeedbackCenter
  }

  async function handle(event, context) {
    const input = event && typeof event === 'object' ? event : {}
    const action = cleanText(input.action, 40)
    const requestId = cleanText(input.requestId, 128) || `req_${crypto.randomBytes(8).toString('hex')}`
    const now = new Date(clock()).toISOString()
    try {
      if (!ACTIONS.has(action)) throw new DomainError('UNKNOWN_ACTION', '不支持的 action')
      if (input.schemaVersion != null && Number(input.schemaVersion) !== SCHEMA_VERSION) {
        throw new DomainError('UNSUPPORTED_SCHEMA', 'schemaVersion 不受支持')
      }
      const actor = action === 'health' ? null : await ensureActor(context, now)
      const data = await handlers[action](input, actor, now)
      return { ok: true, requestId, serverTime: now, data }
    } catch (error) {
      return errorResponse(error, requestId, now)
    }
  }

  return { handle }
}

module.exports = {
  ACTIONS,
  ALLOWED_MIME,
  DomainError,
  FEEDBACK_CATEGORIES,
  FEEDBACK_STAGES,
  MAX_IMAGE_BYTES,
  REVIEW_ROLES,
  RELATION_CHOICES,
  RELATION_CONTRACT_ID,
  RELATION_CONTRACT_VERSION,
  RELATION_DIRECTION_STATE,
  RELATION_DIRECTION_VERSION,
  RELATION_ROLE_LABELS,
  SCHEMA_VERSION,
  UPLOAD_TTL_MS,
  cleanText,
  createCatOnlineCore,
  deriveFeedbackStage,
  normalizeCloudFilePath,
  ownerKeyFromOpenId,
  relationshipDirectionKey
}
