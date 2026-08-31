'use strict'

const crypto = require('crypto')

const SCHEMA_VERSION = 1
const OWNER_KEY_VERSION = 'v1'
const MAX_TEMPLATES = 100
const TOP_K = 5
// Longer than the maximum Worker HTTP timeout plus media URL and database work.
// A timed-out cloud function can therefore be reclaimed without overlapping a
// still-valid first attempt.
const PROCESSING_LEASE_MS = 90 * 1000
const REVIEW_ROLES = new Set(['owner', 'admin', 'reviewer'])
const ACTIONS = new Set(['health', 'startMatch', 'enrollLinkedSighting', 'getTask', 'confirm', 'undo'])

const CONTRACT = Object.freeze({
  modelId: 'open-noodle/pet-recognition-small',
  modelSha256: '6a5e2373ab348bed588cef4072f3914ca9c8bacde3e8d0651019e8dad86b24ba',
  modelVersion: 'pet-recognition-small@sha256:6a5e2373ab348bed588cef4072f3914ca9c8bacde3e8d0651019e8dad86b24ba',
  preprocessVersion: 'open-noodle-imagenet-fit224-v1',
  cropVersion: 'whole-animal-manual-v1',
  dimension: 512,
  encoding: 'f32le-base64'
})

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

function requireSafeId(value, field) {
  const id = requireText(value, field, 128)
  if (!/^[A-Za-z0-9._:@-]+$/.test(id)) {
    throw new DomainError('VALIDATION_ERROR', `${field}格式不正确`)
  }
  return id
}

function requireIdempotencyKey(event) {
  const value = requireText(event && event.idempotencyKey, 'idempotencyKey', 128)
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new DomainError('VALIDATION_ERROR', 'idempotencyKey格式不正确')
  }
  return value
}

function requireExpectedVersion(value) {
  const version = Number(value)
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError('VALIDATION_ERROR', 'expectedVersion必须是正整数')
  }
  return version
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex')
}

function sha256Hex(value) {
  const input = Buffer.isBuffer(value) ? value : String(value == null ? '' : value)
  return crypto.createHash('sha256').update(input).digest('hex')
}

function stableId(prefix, secret, scope, length) {
  return `${prefix}_${hmacHex(secret, scope).slice(0, length || 28)}`
}

function ownerKeyFromOpenId(secret, openid, version) {
  const safeOpenId = requireText(openid, 'OPENID', 256)
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new DomainError('CONFIG_ERROR', 'CAT_ONLINE_OWNER_SECRET尚未配置为至少32字节')
  }
  const keyVersion = cleanText(version || OWNER_KEY_VERSION, 16) || OWNER_KEY_VERSION
  return `owner_${keyVersion}_${hmacHex(secret, `owner|${keyVersion}|${safeOpenId}`)}`
}

function strictBase64Bytes(value, expectedBytes) {
  const text = cleanText(value, 4096)
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new DomainError('REID_CONTRACT_ERROR', '识别服务返回了无效特征', true)
  }
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== text) {
    throw new DomainError('REID_CONTRACT_ERROR', '识别服务返回了无效特征', true)
  }
  return text
}

function normalizeCat(cat) {
  const catId = requireSafeId(cat && (cat.id || cat.catId), 'catId')
  const displayName = requireText(cat && cat.displayName, '猫咪名称', 40)
  return {
    catId,
    displayName,
    ownerKey: cleanText(cat && (cat.ownerKey || cat.createdByOwnerKey), 160)
  }
}

function templateContractIdentity(contract) {
  const source = contract || CONTRACT
  return {
    modelVersion: source.modelVersion,
    modelSha256: source.modelSha256,
    preprocessVersion: source.preprocessVersion,
    cropVersion: source.cropVersion,
    embeddingEncoding: source.embeddingEncoding || source.encoding,
    embeddingDimension: Number(source.embeddingDimension == null ? source.dimension : source.embeddingDimension)
  }
}

function templateMatchesContract(template, contract) {
  const identity = templateContractIdentity(contract)
  return Boolean(template) &&
    template.modelVersion === identity.modelVersion &&
    template.modelSha256 === identity.modelSha256 &&
    template.preprocessVersion === identity.preprocessVersion &&
    template.cropVersion === identity.cropVersion &&
    template.embeddingEncoding === identity.embeddingEncoding &&
    Number(template.embeddingDimension) === identity.embeddingDimension
}

function normalizeTemplate(template) {
  if (!template || template.state !== 'active') return null
  if (!templateMatchesContract(template, CONTRACT)) return null
  const quality = Number(template.quality)
  return {
    templateId: requireSafeId(template.id || template.templateId, 'templateId'),
    catId: requireSafeId(template.catId, 'catId'),
    sessionId: requireSafeId(template.sessionId, 'sessionId'),
    embeddingBase64: strictBase64Bytes(template.embeddingBase64, CONTRACT.dimension * 4),
    quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 1,
    view: cleanText(template.view, 32) || undefined,
    version: Number.isInteger(template.version) ? template.version : 1
  }
}

function buildGallerySnapshot(templates) {
  const digestInput = templates
    .map(item => `${item.templateId}:${item.version}:${item.catId}`)
    .sort()
    .join('|')
  return `gallery_${sha256Hex(`${CONTRACT.modelVersion}|${CONTRACT.preprocessVersion}|${CONTRACT.cropVersion}|${digestInput}`).slice(0, 32)}`
}

function evidenceLabel(rank, independentSessions) {
  if (rank === 1 && Number(independentSessions) >= 2) return '优先核对 · 多次记录'
  if (rank === 1) return '优先核对'
  return '可供核对'
}

function validateWorkerResponse(response, input) {
  if (!response || response.ok !== true || !response.data) {
    throw new DomainError('REID_UNAVAILABLE', '同猫识别服务暂时不可用', true)
  }
  const data = response.data
  if (response.requestId !== input.requestId ||
      data.gallerySnapshotId !== input.gallerySnapshotId ||
      data.modelVersion !== CONTRACT.modelVersion ||
      data.modelSha256 !== CONTRACT.modelSha256 ||
      data.preprocessVersion !== CONTRACT.preprocessVersion ||
      data.cropVersion !== CONTRACT.cropVersion ||
      data.decisionPolicy !== 'candidate_only' ||
      data.searchMode !== 'exact_cosine') {
    throw new DomainError('REID_CONTRACT_ERROR', '识别服务版本与当前任务不匹配', true)
  }
  if (typeof data.testOnly !== 'boolean') {
    throw new DomainError('REID_CONTRACT_ERROR', '识别服务未声明运行模式', true)
  }
  if (!data.image || data.image.mimeType !== input.image.mimeType || Number(data.image.sizeBytes) !== input.image.sizeBytes) {
    throw new DomainError('REID_CONTRACT_ERROR', '识别服务返回的图片信息不匹配', true)
  }
  const embedding = data.queryEmbedding || {}
  if (embedding.encoding !== CONTRACT.encoding || Number(embedding.dimension) !== CONTRACT.dimension ||
      !/^[0-9a-f]{64}$/.test(String(embedding.sha256 || ''))) {
    throw new DomainError('REID_CONTRACT_ERROR', '识别服务返回的特征契约无效', true)
  }
  const embeddingBase64 = strictBase64Bytes(embedding.data, CONTRACT.dimension * 4)
  const embeddingBytes = Buffer.from(embeddingBase64, 'base64')
  if (sha256Hex(embeddingBytes) !== embedding.sha256) {
    throw new DomainError('REID_CONTRACT_ERROR', '识别服务返回的特征校验失败', true)
  }
  const allowedCats = input.allowedCats || new Map()
  const seenCats = new Set()
  const candidates = []
  for (const raw of Array.isArray(data.candidates) ? data.candidates : []) {
    const catId = requireSafeId(raw && raw.catId, 'candidate.catId')
    const rank = Number(raw && raw.rank)
    if (!allowedCats.has(catId) || seenCats.has(catId) || !Number.isInteger(rank) || rank < 1) {
      throw new DomainError('REID_CONTRACT_ERROR', '识别服务返回了无效候选', true)
    }
    seenCats.add(catId)
    const allowedCat = allowedCats.get(catId)
    candidates.push({
      catId,
      displayName: typeof allowedCat === 'string' ? allowedCat : allowedCat.displayName,
      rank,
      evidenceLabel: evidenceLabel(rank, raw.independentSessions)
    })
  }
  candidates.sort((left, right) => left.rank - right.rank)
  if (candidates.length > TOP_K || candidates.some((item, index) => item.rank !== index + 1)) {
    throw new DomainError('REID_CONTRACT_ERROR', '识别服务候选排序无效', true)
  }
  return {
    candidates,
    embeddingBase64,
    embeddingSha256: embedding.sha256,
    modelVersion: data.modelVersion,
    modelSha256: data.modelSha256,
    preprocessVersion: data.preprocessVersion,
    cropVersion: data.cropVersion,
    workerTestOnly: data.testOnly,
    workerEngine: cleanText(data.engine, 64)
  }
}

function safeTask(task) {
  const result = {
    taskId: task.id,
    sightingId: task.sightingId,
    communityId: task.communityId,
    state: task.state,
    version: task.version,
    mode: task.mode,
    simulation: Boolean(task.workerTestOnly),
    linkedCatId: task.linkedCatId || null,
    linkedCatName: task.linkedCatName || null,
    candidates: (task.candidates || []).map(item => ({
      catId: item.catId,
      displayName: item.displayName,
      rank: item.rank,
      evidenceLabel: item.evidenceLabel
    })),
    availableCats: (task.availableCats || []).map(item => ({
      catId: item.catId,
      displayName: item.displayName
    })),
    notice: task.notice || '候选只用于人工核对，不会自动合并猫咪档案。',
    modelVersion: task.modelVersion || null
  }
  return result
}

function safeTaskWithAssignment(task) {
  const result = safeTask(task)
  if (task.assignmentId && task.linkedCatId && task.linkedCatName && task.state === 'COMPLETED') {
    result.assignment = { catId: task.linkedCatId, displayName: task.linkedCatName }
  }
  return result
}

function safeEnrollment(template, cat, alreadyEnrolled) {
  return {
    enrolled: true,
    alreadyEnrolled: Boolean(alreadyEnrolled),
    templateId: template.id,
    sightingId: template.sightingId,
    catId: template.catId,
    displayName: cat.displayName,
    modelVersion: template.modelVersion,
    notice: alreadyEnrolled
      ? '这张照片已经在该猫的识别图库中。'
      : '已加入识别图库。它只会帮助后续生成候选，不会自动合并任何档案。'
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
    'getMembership', 'getSightingWithAsset', 'listCats', 'listTemplates',
    'getTemplate', 'enrollTemplate', 'getJob', 'createJob', 'completeJob', 'confirmTask', 'undoTask'
  ]
  methods.forEach(method => {
    if (!repository || typeof repository[method] !== 'function') {
      throw new Error(`catIdentity repository missing ${method}()`)
    }
  })
}

function createCatIdentityCore(options) {
  const settings = options || {}
  const repository = settings.repository
  const worker = settings.worker || { configured: false }
  const media = settings.media || {}
  const clock = typeof settings.clock === 'function' ? settings.clock : () => Date.now()
  const ownerSecret = cleanText(settings.ownerSecret, 512)
  const ownerKeyVersion = cleanText(settings.ownerKeyVersion || OWNER_KEY_VERSION, 16) || OWNER_KEY_VERSION
  assertRepository(repository)

  function actorFromContext(context) {
    const openid = context && context.openid
    if (!openid) throw new DomainError('AUTH_REQUIRED', '无法获取微信用户身份')
    return { ownerKey: ownerKeyFromOpenId(ownerSecret, openid, ownerKeyVersion) }
  }

  async function requireMembership(communityId, actor) {
    const membership = await repository.getMembership(communityId, actor.ownerKey)
    if (!membership || membership.status !== 'active') {
      throw new DomainError('FORBIDDEN', '你还不是该社区的有效成员')
    }
    return membership
  }

  function assertOwnerOrReviewer(ownerKey, actor, membership) {
    if (ownerKey !== actor.ownerKey && !REVIEW_ROLES.has(membership.role)) {
      throw new DomainError('FORBIDDEN', '仅图片上传者或社区审核员可以处理这项识别')
    }
  }

  async function loadAuthorizedSighting(sightingId, actor) {
    const internal = await repository.getSightingWithAsset(sightingId)
    if (!internal || !internal.sighting || !internal.asset) {
      throw new DomainError('NOT_FOUND', '找不到这条目击记录')
    }
    const sighting = internal.sighting
    const asset = internal.asset
    const membership = await requireMembership(sighting.communityId, actor)
    assertOwnerOrReviewer(sighting.ownerKey, actor, membership)
    if (sighting.state !== 'APPROVED' || asset.state !== 'APPROVED' || !asset.approvedFileID || asset.sanitized !== true) {
      throw new DomainError('SIGHTING_NOT_APPROVED', '只有审核通过的单猫照片才能进入同猫识别')
    }
    if (sighting.remotePetId || sighting.identityCatId) {
      throw new DomainError('SIGHTING_ALREADY_LINKED', '这条目击已经关联猫咪；如需更正，请先撤销原确认')
    }
    if (!/^[0-9a-f]{64}$/.test(String(asset.sha256 || '')) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(asset.mime) ||
        !Number.isInteger(asset.sizeBytes) || asset.sizeBytes < 1) {
      throw new DomainError('INVALID_ASSET', '审核图片缺少完整校验信息')
    }
    return { sighting, asset, membership }
  }

  async function loadAuthorizedEnrollmentSighting(sightingId, actor) {
    const internal = await repository.getSightingWithAsset(sightingId)
    if (!internal || !internal.sighting || !internal.asset) {
      throw new DomainError('NOT_FOUND', '找不到这条目击记录')
    }
    const sighting = internal.sighting
    const asset = internal.asset
    const membership = await requireMembership(sighting.communityId, actor)
    if (sighting.ownerKey !== actor.ownerKey) {
      throw new DomainError('FORBIDDEN', '只有档案主人可以把已关联照片加入识别图库')
    }
    if (sighting.state !== 'APPROVED' || asset.state !== 'APPROVED' || !asset.approvedFileID || asset.sanitized !== true) {
      throw new DomainError('SIGHTING_NOT_APPROVED', '只有审核通过的单猫照片才能加入识别图库')
    }
    const catId = requireSafeId(sighting.catId || sighting.remotePetId, 'catId')
    if (!sighting.remotePetId) {
      throw new DomainError('SIGHTING_NOT_LINKED', '请先把这条目击关联到自己的本地猫咪档案')
    }
    if (!/^[0-9a-f]{64}$/.test(String(asset.sha256 || '')) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(asset.mime) ||
        !Number.isInteger(asset.sizeBytes) || asset.sizeBytes < 1) {
      throw new DomainError('INVALID_ASSET', '审核图片缺少完整校验信息')
    }
    const cats = await repository.listCats(sighting.communityId)
    let cat = null
    for (const item of cats || []) {
      try {
        const normalized = normalizeCat(item)
        if (normalized.catId === catId && normalized.ownerKey === actor.ownerKey) {
          cat = normalized
          break
        }
      } catch (error) { /* malformed legacy cat is ignored */ }
    }
    if (!cat) throw new DomainError('CAT_NOT_FOUND', '已关联猫咪不属于当前用户或小屋')
    return { sighting, asset, membership, cat }
  }

  async function loadAuthorizedTask(taskId, actor) {
    const task = await repository.getJob(taskId)
    if (!task) throw new DomainError('NOT_FOUND', '识别任务不存在')
    const membership = await requireMembership(task.communityId, actor)
    assertOwnerOrReviewer(task.sightingOwnerKey, actor, membership)
    return { task, membership }
  }

  async function recoverExpiredIdentityRevocations(now) {
    if (typeof repository.recoverExpiredIdentityRevocations !== 'function') {
      return { configured: false, recovered: 0, available: false }
    }
    try {
      const recovered = await repository.recoverExpiredIdentityRevocations(now)
      return {
        configured: true,
        recovered: Number.isInteger(recovered) && recovered >= 0 ? recovered : 0,
        available: true
      }
    } catch (error) {
      return { configured: true, recovered: 0, available: false }
    }
  }

  async function health(recovery) {
    return {
      service: 'catIdentity',
      schemaVersion: SCHEMA_VERSION,
      policy: 'candidate_only_manual_confirmation',
      ownerSecretConfigured: Buffer.byteLength(ownerSecret, 'utf8') >= 32,
      workerConfigured: Boolean(worker.configured),
      revocationRecoveryConfigured: recovery.configured,
      revocationRecoveryAvailable: recovery.available,
      recoveredIdentityRevocations: recovery.recovered,
      automaticMerge: false
    }
  }

  async function startMatch(event, actor, now) {
    const sightingId = requireSafeId(event.sightingId, 'sightingId')
    const idempotencyKey = requireIdempotencyKey(event)
    const internal = await loadAuthorizedSighting(sightingId, actor)
    const taskId = stableId('idjob', ownerSecret, `identity-job|${actor.ownerKey}|${idempotencyKey}`, 32)
    const requestHash = sha256Hex(JSON.stringify({ sightingId }))
    const existing = await repository.getJob(taskId)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', '此幂等键已经用于另一项识别任务')
      }
      const leaseDeadline = Date.parse(existing.leaseUntil || existing.updatedAt || existing.createdAt || '')
      const leaseExpired = existing.state === 'PROCESSING' && Number.isFinite(leaseDeadline) && leaseDeadline <= Date.parse(now)
      if (!leaseExpired) return safeTaskWithAssignment(existing)
    }

    const rawCats = await repository.listCats(internal.sighting.communityId)
    const catMap = new Map()
    ;(rawCats || []).forEach(item => {
      try {
        const cat = normalizeCat(item)
        const canUse = REVIEW_ROLES.has(internal.membership.role) || (cat.ownerKey && cat.ownerKey === actor.ownerKey)
        if (canUse && !catMap.has(cat.catId)) catMap.set(cat.catId, cat)
      } catch (error) {
        // A malformed legacy record must not block the manual confirmation path.
      }
    })
    const availableCats = Array.from(catMap.values(), ({ catId, displayName }) => ({ catId, displayName }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))

    const rawTemplates = await repository.listTemplates(internal.sighting.communityId, CONTRACT, MAX_TEMPLATES)
    const templates = []
    ;(rawTemplates || []).forEach(item => {
      try {
        const template = normalizeTemplate(item)
        if (template && catMap.has(template.catId)) templates.push(template)
      } catch (error) {
        // Corrupt templates are quarantined by omission; users can still decide manually.
      }
    })
    const gallerySnapshotId = buildGallerySnapshot(templates)
    const leaseToken = crypto.randomBytes(16).toString('hex')
    const task = {
      id: taskId,
      sightingId,
      sightingOwnerKey: internal.sighting.ownerKey,
      communityId: internal.sighting.communityId,
      createdByOwnerKey: actor.ownerKey,
      requestHash,
      idempotencyKey,
      state: 'PROCESSING',
      version: existing ? existing.version : 1,
      leaseToken,
      leaseUntil: new Date(Date.parse(now) + PROCESSING_LEASE_MS).toISOString(),
      mode: 'MANUAL_ONLY',
      workerTestOnly: false,
      linkedCatId: null,
      linkedCatName: null,
      candidates: [],
      availableCats,
      notice: worker.configured
        ? '正在生成仅供人工核对的候选。'
        : '识别 Worker 尚未配置，请从现有猫咪中手动选择，或创建新猫。',
      modelVersion: null,
      gallerySnapshotId,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    }

    const reserved = await repository.createJob(task, existing && existing.leaseToken)
    if (reserved.requestHash !== requestHash) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', '此幂等键已经用于另一项识别任务')
    }
    if (reserved.leaseToken !== leaseToken) return safeTaskWithAssignment(reserved)

    if (worker.configured) {
      try {
        if (typeof worker.process !== 'function' || typeof media.getApprovedUrl !== 'function') {
          throw new DomainError('CONFIG_ERROR', '同猫识别服务配置不完整')
        }
        const imageUrl = await media.getApprovedUrl(internal.asset.approvedFileID)
        if (!imageUrl) throw new DomainError('MEDIA_URL_FAILED', '暂时无法读取审核图片', true)
        const workerInput = {
        schemaVersion: SCHEMA_VERSION,
        requestId: `reid-${taskId}`,
        idempotencyKey: taskId,
        gallerySnapshotId,
        contract: {
          modelId: CONTRACT.modelId,
          modelSha256: CONTRACT.modelSha256,
          preprocessVersion: CONTRACT.preprocessVersion,
          cropVersion: CONTRACT.cropVersion,
          dimension: CONTRACT.dimension,
          encoding: CONTRACT.encoding
        },
        image: {
          url: imageUrl,
          sha256: internal.asset.sha256,
          sizeBytes: internal.asset.sizeBytes,
          mimeType: internal.asset.mime
        },
        gallery: templates.map(item => ({
          templateId: item.templateId,
          catId: item.catId,
          sessionId: item.sessionId,
          embeddingBase64: item.embeddingBase64,
          quality: item.quality,
          view: item.view
        })),
        topK: TOP_K
      }
        const response = await worker.process(workerInput)
        const normalized = validateWorkerResponse(response, {
          requestId: workerInput.requestId,
          gallerySnapshotId,
          image: workerInput.image,
          allowedCats: catMap
        })
        Object.assign(task, normalized, {
          mode: 'MODEL_ASSISTED',
          notice: normalized.workerTestOnly
            ? '当前为本地模拟结果，只用于流程验证；仍需人工确认，且不会登记为识别模板。'
            : '候选由模型排序，仅用于人工核对，不代表概率，也不会自动合并档案。'
        })
      } catch (error) {
        task.mode = 'MANUAL_ONLY'
        task.candidates = []
        task.workerFailureCode = error instanceof DomainError ? error.code : 'REID_UNAVAILABLE'
        task.notice = '模型候选暂时不可用，已安全切换为人工确认；不会自动合并档案。'
      }
    }
    task.state = 'AWAITING_CONFIRMATION'
    task.version = 2
    delete task.leaseToken
    delete task.leaseUntil
    const saved = await repository.completeJob(task, leaseToken)
    return safeTaskWithAssignment(saved)
  }

  async function getTask(event, actor) {
    const taskId = requireSafeId(event.taskId, 'taskId')
    const internal = await loadAuthorizedTask(taskId, actor)
    return safeTaskWithAssignment(internal.task)
  }

  async function enrollLinkedSighting(event, actor, now) {
    const sightingId = requireSafeId(event.sightingId, 'sightingId')
    const idempotencyKey = requireIdempotencyKey(event)
    const internal = await loadAuthorizedEnrollmentSighting(sightingId, actor)
    const templateContract = templateContractIdentity(CONTRACT)
    const requestHash = sha256Hex(JSON.stringify({
      sightingId,
      catId: internal.cat.catId,
      templateContract
    }))
    const contractFingerprint = sha256Hex(JSON.stringify(templateContract))
    const templateId = stableId(
      'tpl',
      ownerSecret,
      `linked-enrollment|${internal.sighting.communityId}|${sightingId}|${internal.cat.catId}|${contractFingerprint}`,
      32
    )
    const legacyTemplateId = stableId(
      'tpl',
      ownerSecret,
      `linked-enrollment|${internal.sighting.communityId}|${sightingId}|${internal.cat.catId}|${CONTRACT.modelSha256}`,
      32
    )
    let existing = await repository.getTemplate(templateId)
    if (!existing && legacyTemplateId !== templateId) {
      existing = await repository.getTemplate(legacyTemplateId)
    }
    if (existing) {
      if (existing.state !== 'active' || existing.catId !== internal.cat.catId ||
          existing.sightingId !== sightingId || !templateMatchesContract(existing, CONTRACT)) {
        throw new DomainError('ENROLLMENT_CONFLICT', '现有识别模板与当前猫咪或模型版本不一致')
      }
      const repaired = await repository.enrollTemplate({
        template: existing,
        contract: templateContract,
        sightingId,
        remotePetId: internal.sighting.remotePetId,
        catId: internal.cat.catId,
        actorOwnerKey: actor.ownerKey,
        membershipId: internal.membership.id,
        requestHash,
        repairOnly: true,
        now
      })
      return safeEnrollment(repaired, internal.cat, true)
    }
    if (!worker.configured || typeof worker.process !== 'function' || typeof media.getApprovedUrl !== 'function') {
      throw new DomainError('REID_NOT_CONFIGURED', '云端同猫识别 Worker 尚未启用，照片尚未加入识别图库')
    }

    const rawCats = await repository.listCats(internal.sighting.communityId)
    const catMap = new Map()
    ;(rawCats || []).forEach(item => {
      try {
        const cat = normalizeCat(item)
        if (!catMap.has(cat.catId)) catMap.set(cat.catId, cat)
      } catch (error) { /* malformed legacy cat is ignored */ }
    })
    const rawTemplates = await repository.listTemplates(internal.sighting.communityId, CONTRACT, MAX_TEMPLATES)
    const templates = []
    ;(rawTemplates || []).forEach(item => {
      try {
        const template = normalizeTemplate(item)
        if (template && catMap.has(template.catId)) templates.push(template)
      } catch (error) { /* corrupt templates do not block a fresh enrollment */ }
    })
    const gallerySnapshotId = buildGallerySnapshot(templates)
    const imageUrl = await media.getApprovedUrl(internal.asset.approvedFileID)
    if (!imageUrl) throw new DomainError('MEDIA_URL_FAILED', '暂时无法读取审核图片', true)
    const workerInput = {
      schemaVersion: SCHEMA_VERSION,
      requestId: `reid-enroll-${templateId}`,
      idempotencyKey: templateId,
      gallerySnapshotId,
      contract: {
        modelId: CONTRACT.modelId,
        modelSha256: CONTRACT.modelSha256,
        preprocessVersion: CONTRACT.preprocessVersion,
        cropVersion: CONTRACT.cropVersion,
        dimension: CONTRACT.dimension,
        encoding: CONTRACT.encoding
      },
      image: {
        url: imageUrl,
        sha256: internal.asset.sha256,
        sizeBytes: internal.asset.sizeBytes,
        mimeType: internal.asset.mime
      },
      gallery: templates.map(item => ({
        templateId: item.templateId,
        catId: item.catId,
        sessionId: item.sessionId,
        embeddingBase64: item.embeddingBase64,
        quality: item.quality,
        view: item.view
      })),
      topK: TOP_K
    }
    const response = await worker.process(workerInput)
    const normalized = validateWorkerResponse(response, {
      requestId: workerInput.requestId,
      gallerySnapshotId,
      image: workerInput.image,
      allowedCats: catMap
    })
    if (normalized.workerTestOnly) {
      throw new DomainError('REID_TEST_ONLY', '当前识别 Worker 是测试模式，不能写入真实猫咪模板')
    }
    const template = {
      id: templateId,
      communityId: internal.sighting.communityId,
      catId: internal.cat.catId,
      sessionId: sightingId,
      sightingId,
      assignmentId: null,
      state: 'active',
      version: 1,
      embeddingBase64: normalized.embeddingBase64,
      embeddingSha256: normalized.embeddingSha256,
      embeddingEncoding: CONTRACT.encoding,
      embeddingDimension: CONTRACT.dimension,
      modelVersion: CONTRACT.modelVersion,
      modelSha256: CONTRACT.modelSha256,
      preprocessVersion: CONTRACT.preprocessVersion,
      cropVersion: CONTRACT.cropVersion,
      quality: 0.75,
      view: 'whole_animal_reviewed',
      source: 'explicit_linked_pet_enrollment',
      enrollmentIdempotencyKey: idempotencyKey,
      enrollmentRequestHash: requestHash,
      createdByOwnerKey: actor.ownerKey,
      createdAt: now,
      updatedAt: now
    }
    const saved = await repository.enrollTemplate({
      template,
      contract: templateContract,
      sightingId,
      remotePetId: internal.sighting.remotePetId,
      catId: internal.cat.catId,
      actorOwnerKey: actor.ownerKey,
      membershipId: internal.membership.id,
      requestHash,
      now
    })
    return safeEnrollment(saved, internal.cat, false)
  }

  function normalizeDecision(event, taskId) {
    const raw = event.decision || {}
    const type = cleanText(raw.type, 24)
    if (!['same_cat', 'new_cat', 'unsure'].includes(type)) {
      throw new DomainError('VALIDATION_ERROR', 'decision.type必须是same_cat、new_cat或unsure')
    }
    if (type === 'same_cat') {
      return { type, catId: requireSafeId(raw.catId, 'decision.catId') }
    }
    if (type === 'new_cat') {
      if (raw.catId) throw new DomainError('VALIDATION_ERROR', '创建新猫时不能指定catId')
      return {
        type,
        catId: stableId('cat', ownerSecret, `identity|${taskId}`, 32),
        displayName: requireText(raw.displayName, '新猫名称', 40)
      }
    }
    if (raw.catId || raw.displayName) {
      throw new DomainError('VALIDATION_ERROR', '无法判断时不应携带猫咪归属')
    }
    return { type }
  }

  async function confirm(event, actor, now) {
    const taskId = requireSafeId(event.taskId, 'taskId')
    const expectedVersion = requireExpectedVersion(event.expectedVersion)
    const internal = await loadAuthorizedTask(taskId, actor)
    const task = internal.task
    const decision = normalizeDecision(event, taskId)
    const decisionHash = sha256Hex(JSON.stringify(decision))
    if (['COMPLETED', 'NEEDS_MORE_EVIDENCE'].includes(task.state)) {
      if (task.decisionHash === decisionHash) return safeTaskWithAssignment(task)
      throw new DomainError('STATE_CONFLICT', '这项任务已经确认，请刷新后查看')
    }
    if (task.state !== 'AWAITING_CONFIRMATION') {
      throw new DomainError('STATE_CONFLICT', '当前任务状态不能确认')
    }
    if (task.version !== expectedVersion) {
      throw new DomainError('VERSION_CONFLICT', '任务已更新，请刷新后再确认')
    }

    const cats = await repository.listCats(task.communityId)
    const catMap = new Map()
    ;(cats || []).forEach(item => {
      const cat = normalizeCat(item)
      const canUse = REVIEW_ROLES.has(internal.membership.role) || (cat.ownerKey && cat.ownerKey === actor.ownerKey)
      if (canUse && !catMap.has(cat.catId)) catMap.set(cat.catId, cat)
    })
    if (decision.type === 'same_cat') {
      if (!catMap.has(decision.catId)) {
        throw new DomainError('CAT_CONFIRMATION_REQUIRED', '关联其他成员的猫咪需要猫主或小屋审核员确认')
      }
      decision.displayName = catMap.get(decision.catId).displayName
    }

    const nextState = decision.type === 'unsure' ? 'NEEDS_MORE_EVIDENCE' : 'COMPLETED'
    const assignment = decision.type === 'unsure' ? null : {
      id: stableId('assign', ownerSecret, `current-assignment|${task.communityId}|${task.sightingId}`, 32),
      communityId: task.communityId,
      sightingId: task.sightingId,
      taskId: task.id,
      catId: decision.catId,
      displayName: decision.displayName,
      decisionType: decision.type,
      state: 'active',
      confirmedByOwnerKey: actor.ownerKey,
      createdAt: now,
      updatedAt: now
    }
    const identity = assignment ? {
      id: decision.catId,
      communityId: task.communityId,
      displayName: decision.displayName,
      state: 'active',
      source: decision.type === 'new_cat' ? 'manual_new_cat' : 'manual_same_cat',
      sourceTaskId: task.id,
      ownerKey: decision.type === 'new_cat'
        ? task.sightingOwnerKey
        : (catMap.get(decision.catId) && catMap.get(decision.catId).ownerKey) || task.sightingOwnerKey,
      createdAt: now,
      updatedAt: now
    } : null
    let template = null
    if (assignment && task.workerTestOnly === false && task.embeddingBase64 && task.embeddingSha256 &&
        task.modelVersion === CONTRACT.modelVersion && task.modelSha256 === CONTRACT.modelSha256 &&
        task.preprocessVersion === CONTRACT.preprocessVersion && task.cropVersion === CONTRACT.cropVersion) {
      strictBase64Bytes(task.embeddingBase64, CONTRACT.dimension * 4)
      template = {
        id: stableId('tpl', ownerSecret, `template|${task.id}|${task.version}`, 32),
        communityId: task.communityId,
        catId: assignment.catId,
        sessionId: task.sightingId,
        sightingId: task.sightingId,
        assignmentId: assignment.id,
        state: 'active',
        version: 1,
        embeddingBase64: task.embeddingBase64,
        embeddingSha256: task.embeddingSha256,
        embeddingEncoding: CONTRACT.encoding,
        embeddingDimension: CONTRACT.dimension,
        modelVersion: CONTRACT.modelVersion,
        modelSha256: CONTRACT.modelSha256,
        preprocessVersion: CONTRACT.preprocessVersion,
        cropVersion: CONTRACT.cropVersion,
        quality: 0.75,
        view: 'whole_animal_reviewed',
        source: 'explicit_manual_confirmation',
        createdAt: now,
        updatedAt: now
      }
    }
    const feedback = {
      id: stableId('feedback', ownerSecret, `feedback|confirm|${task.id}|${task.version}`, 32),
      communityId: task.communityId,
      taskId: task.id,
      sightingId: task.sightingId,
      actorOwnerKey: actor.ownerKey,
      type: decision.type,
      catId: assignment ? assignment.catId : null,
      createdAt: now
    }
    const saved = await repository.confirmTask({
      taskId,
      expectedVersion,
      expectedState: 'AWAITING_CONFIRMATION',
      actorOwnerKey: actor.ownerKey,
      membershipId: internal.membership.id,
      reviewerRoles: Array.from(REVIEW_ROLES),
      decision,
      decisionHash,
      nextState,
      assignment,
      identity,
      template,
      feedback,
      now
    })
    return safeTaskWithAssignment(saved)
  }

  async function undo(event, actor, now) {
    const taskId = requireSafeId(event.taskId, 'taskId')
    const expectedVersion = requireExpectedVersion(event.expectedVersion)
    const internal = await loadAuthorizedTask(taskId, actor)
    const task = internal.task
    if (task.state === 'UNDONE') return safeTask(task)
    if (!['COMPLETED', 'NEEDS_MORE_EVIDENCE'].includes(task.state)) {
      throw new DomainError('STATE_CONFLICT', '只有已确认的任务可以撤销')
    }
    if (task.version !== expectedVersion) {
      throw new DomainError('VERSION_CONFLICT', '任务已更新，请刷新后再撤销')
    }
    const feedback = {
      id: stableId('feedback', ownerSecret, `feedback|undo|${task.id}|${task.version}`, 32),
      communityId: task.communityId,
      taskId: task.id,
      sightingId: task.sightingId,
      actorOwnerKey: actor.ownerKey,
      type: 'undo',
      previousDecisionType: task.decisionType || null,
      createdAt: now
    }
    const saved = await repository.undoTask({
      taskId,
      expectedVersion,
      actorOwnerKey: actor.ownerKey,
      membershipId: internal.membership.id,
      reviewerRoles: Array.from(REVIEW_ROLES),
      feedback,
      revokeIdentityId: task.decisionType === 'new_cat' ? task.linkedCatId : null,
      now
    })
    return safeTask(saved)
  }

  async function handle(event, context) {
    const nowMs = clock()
    const now = new Date(nowMs).toISOString()
    const requestId = cleanText(event && event.requestId, 128) || `req-${nowMs}`
    try {
      const action = cleanText(event && event.action, 40)
      if (!ACTIONS.has(action)) throw new DomainError('UNKNOWN_ACTION', '不支持的操作')
      const recovery = await recoverExpiredIdentityRevocations(now)
      let data
      if (action === 'health') {
        data = await health(recovery)
      } else {
        const actor = actorFromContext(context)
        if (action === 'startMatch') data = await startMatch(event || {}, actor, now)
        if (action === 'enrollLinkedSighting') data = await enrollLinkedSighting(event || {}, actor, now)
        if (action === 'getTask') data = await getTask(event || {}, actor)
        if (action === 'confirm') data = await confirm(event || {}, actor, now)
        if (action === 'undo') data = await undo(event || {}, actor, now)
      }
      return { ok: true, requestId, serverTime: now, data }
    } catch (error) {
      return errorResponse(error, requestId, now)
    }
  }

  return { handle }
}

module.exports = {
  ACTIONS,
  CONTRACT,
  DomainError,
  MAX_TEMPLATES,
  PROCESSING_LEASE_MS,
  SCHEMA_VERSION,
  TOP_K,
  buildGallerySnapshot,
  createCatIdentityCore,
  ownerKeyFromOpenId,
  safeTask,
  safeEnrollment,
  strictBase64Bytes,
  templateContractIdentity,
  templateMatchesContract,
  validateWorkerResponse
}
