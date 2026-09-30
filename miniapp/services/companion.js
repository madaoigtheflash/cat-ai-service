'use strict'

const defaultStorage = require('../utils/storage')
const intents = require('../utils/companion-intents')
const KEYS = Object.freeze({
  messages: 'catai_companion_messages_v1', draft: 'catai_companion_actions_v1',
  composer: 'catai_companion_composer_v1', locations: 'catai_companion_sightings_v1'
})
const clone = value => JSON.parse(JSON.stringify(value))
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function requireValue(value, code, message) { if (!value) fail(code, message) }
function fingerprint(value) {
  if (Array.isArray(value)) return '[' + value.map(fingerprint).join(',') + ']'
  if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + fingerprint(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function textField(value, max, label, optional) {
  requireValue(typeof value === 'string', 'INVALID_INPUT', label + '格式无效。')
  const cleaned = value.trim()
  requireValue((optional || cleaned.length > 0) && Array.from(cleaned).length <= max && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(cleaned), 'INVALID_INPUT', label + '内容为空、过长或包含控制字符。')
  return cleaned
}
function sameFields(record, payload) { return Boolean(record) && Object.keys(payload).every(key => fingerprint(record[key]) === fingerprint(payload[key])) }
function emptyActions() { return { schema: 1, revision: 0, pending: null, receipts: [] } }

function createService(options) {
  const settings = options || {}
  const storage = settings.storage || defaultStorage
  const now = settings.now || Date.now
  const makeId = settings.makeId || (() => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10))
  let observedActions = null
  const io = () => settings.io || wx
  function freshId(prefix) {
    const id = prefix + '_' + makeId()
    requireValue(/^[a-zA-Z0-9_-]{1,140}$/.test(id), 'INVALID_ID', '本机操作标识无效。')
    return id
  }
  function read(key, fallback) {
    const value = io().getStorageSync(key)
    return value === undefined || value === null || value === '' ? clone(fallback) : clone(value)
  }
  function write(key, value) {
    const snapshot = clone(value)
    io().setStorageSync(key, snapshot)
    // An intentionally saved empty composer is not a missing key. Compare the
    // exact serialized payload against raw readback, not read()'s empty fallback.
    requireValue(fingerprint(io().getStorageSync(key)) === fingerprint(snapshot), 'WRITE_UNCONFIRMED', '本机保存尚未确认，请保留输入并重新核对。')
  }
  function actions() {
    const value = read(KEYS.draft, emptyActions())
    requireValue(isObject(value) && value.schema === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 && Array.isArray(value.receipts) && value.receipts.length <= 5000,
      'CORRUPT_DATA', '操作记录损坏或版本不受支持，未覆盖原数据。')
    const ids = new Set()
    value.receipts.forEach(receipt => {
      requireValue(isObject(receipt) && typeof receipt.id === 'string' && !ids.has(receipt.id) && typeof receipt.fingerprint === 'string' && ['pet', 'relationship', 'location'].includes(receipt.kind) && typeof receipt.targetId === 'string', 'CORRUPT_DATA', '确认回执损坏，未覆盖原数据。')
      ids.add(receipt.id)
    })
    if (value.pending !== null) {
      const draft = value.pending
      requireValue(isObject(draft) && typeof draft.id === 'string' && !ids.has(draft.id) && ['pet', 'relationship', 'location'].includes(draft.kind) && ['pending', 'saving', 'uncertain'].includes(draft.status) && isObject(draft.fields) && Number.isSafeInteger(draft.revision) && Array.isArray(draft.targets), 'CORRUPT_DATA', '草稿记录损坏，未覆盖原数据。')
      requireValue(draft.contentFingerprint === fingerprint(draft.fields), 'CORRUPT_DATA', '草稿内容校验未通过，未覆盖原数据。')
    }
    return value
  }
  function editableActions() {
    const value = actions()
    requireValue(observedActions === null || fingerprint(value) === observedActions, 'STALE_DRAFT', '草稿已在其他页面改变，请重新载入后核对。')
    return value
  }
  function saveActions(value) { write(KEYS.draft, value); observedActions = fingerprint(value) }
  function checkOriginalData() {
    ;['catai_mini_pets_v1', 'catai_mini_relationships_v1'].forEach(key => {
      const value = read(key, [])
      requireValue(Array.isArray(value) && value.every(isObject), 'CORRUPT_DATA', '原档案格式需要检查，未写入任何实体。')
    })
  }
  function pets() { checkOriginalData(); return clone(storage.listPets()) }
  function relationships() { checkOriginalData(); return clone(storage.listRelationships()) }
  function listMessages() {
    const value = read(KEYS.messages, { schema: 1, messages: [] })
    requireValue(isObject(value) && value.schema === 1 && Array.isArray(value.messages) && value.messages.length <= 2000, 'CORRUPT_DATA', '本机对话记录损坏，未覆盖原历史。')
    const ids = new Set()
    value.messages.forEach(message => {
      requireValue(isObject(message) && typeof message.id === 'string' && !ids.has(message.id) && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string' && Number.isSafeInteger(message.time) && ['你', '本地引导', '云端回复'].includes(message.label) && message.localOnly === true, 'CORRUPT_DATA', '本机消息格式无效，未覆盖原历史。')
      ids.add(message.id)
    })
    return value.messages
  }
  function getComposerDraft() {
    const value = read(KEYS.composer, '')
    requireValue(typeof value === 'string' && value.length <= 2000, 'CORRUPT_DATA', '未发送文字格式无效，未覆盖。')
    return value
  }
  function saveComposerDraft(text) {
    requireValue(typeof text === 'string' && text.length <= 2000, 'INVALID_INPUT', '未发送文字最多 2000 字。')
    write(KEYS.composer, text)
    return text
  }
  function getDraft() {
    const value = actions()
    observedActions = fingerprint(value)
    return clone(value.pending)
  }
  function getState() {
    const draft = getDraft(); const messages = listMessages()
    const latestReply = messages.slice().reverse().find(message => message.role === 'assistant')
    return { messages, draft, pending: clone(draft), composerText: getComposerDraft(), replySource: latestReply ? latestReply.source : '本地引导', mode: 'local-guide', storage: 'local', localOnly: true }
  }
  function listLocations() {
    const value = read(KEYS.locations, [])
    requireValue(Array.isArray(value) && value.length <= 2000, 'CORRUPT_DATA', '本机地点记录格式无效，未覆盖。')
    value.forEach(item => requireValue(isObject(item) && Object.keys(item).sort().join('|') === ['petId', 'areaText', 'latitude', 'longitude', 'time'].sort().join('|') && typeof item.petId === 'string' && typeof item.areaText === 'string' && Number.isFinite(item.latitude) && Math.abs(item.latitude) <= 85.02 && Number.isFinite(item.longitude) && Math.abs(item.longitude) <= 180 && Number.isSafeInteger(item.time) && item.time >= 0, 'CORRUPT_DATA', '本机地点记录损坏，未覆盖。'))
    return value
  }
  function normalizeFields(kind, input, alreadyCoarse, complete) {
    requireValue(isObject(input), 'INVALID_INPUT', '请填写结构化草稿。')
    const allowed = kind === 'pet' ? ['name', 'breed', 'coatColor', 'gender', 'notes', 'imagePath'] : kind === 'relationship' ? ['fromPetId', 'toPetId', 'fromRole', 'toRole', 'note'] : kind === 'location' ? ['petId', 'areaText', 'latitude', 'longitude', 'time'] : []
    requireValue(allowed.length && Object.keys(input).every(key => allowed.includes(key)), 'INVALID_INPUT', '草稿类型或字段不受支持，未保存额外信息。')
    if (kind === 'pet') {
      const name = input.name || ''
      const result = { name: !complete && !name.trim() ? '' : intents.cleanName(name), breed: textField(input.breed || '', 60, '品种', true), coatColor: textField(input.coatColor || '', 60, '毛色', true), gender: input.gender || '未知', notes: textField(input.notes || '', 500, '备注', true), imagePath: textField(input.imagePath || '', 1000, '本机图片路径', true) }
      requireValue(['未知', '公', '母', '雄', '雌'].includes(result.gender), 'INVALID_INPUT', '请选择有效性别或未知。')
      // WeChat uses an http(s)://usr pseudo-origin for some persisted local files.
      // It is not an arbitrary network URL. Temporary wxfile/tmp origins are not
      // accepted as persisted photos, and protocol-relative network paths fail.
      requireValue(!result.imagePath || /^(?:wxfile:\/\/usr\/|https?:\/\/usr\/|\/(?!\/)|[a-zA-Z]:[\\/])/i.test(result.imagePath), 'INVALID_INPUT', '照片草稿只接受用户主动保存的本机图片，不自动下载云端图片。')
      return result
    }
    if (kind === 'relationship') {
      const result = { fromPetId: textField(input.fromPetId || '', 140, '起点猫咪', !complete), toPetId: textField(input.toPetId || '', 140, '终点猫咪', !complete), fromRole: input.fromRole || 'mother', toRole: input.toRole || 'child', note: textField(input.note || '', 160, '关系说明', true) }
      if (complete) requireValue(result.fromPetId !== result.toPetId, 'SAME_CAT', '请选择两只不同的猫咪。')
      requireValue(['mother:child', 'father:child', 'caregiver:cared_for', 'friend:friend', 'playmate:playmate'].includes(result.fromRole + ':' + result.toRole), 'INVALID_INPUT', '请选择允许且成对的关系角色。')
      return result
    }
    const areaText = textField(input.areaText || '', 80, '粗略区域', !complete)
    requireValue(!/[-+]?\d{1,3}\.\d+\s*[,，、\s]\s*[-+]?\d{1,3}\.\d+|\d+\s*(号|栋|幢|室|单元)|1[3-9]\d{9}|经度|纬度|GPS/i.test(areaText), 'PRECISE_LOCATION', '区域文字请勿填写坐标、门牌或联系方式。')
    const noPoint = (input.latitude === undefined || input.latitude === null) && (input.longitude === undefined || input.longitude === null)
    const point = !complete && noPoint ? { latitude: null, longitude: null } : alreadyCoarse ? { latitude: input.latitude, longitude: input.longitude } : intents.coarseLocation(input.latitude, input.longitude)
    requireValue((!complete && noPoint) || (typeof point.latitude === 'number' && typeof point.longitude === 'number' && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 85.02 && Math.abs(point.longitude) <= 180), 'INVALID_INPUT', '请主动选择有效的粗略位置。')
    const time = input.time === undefined ? now() : input.time
    requireValue(Number.isSafeInteger(time) && time >= 0 && time <= now(), 'INVALID_INPUT', '目击时间应为有效且不晚于当前的本机毫秒时间。')
    return { petId: textField(input.petId || '', 140, '猫咪档案', !complete), areaText, latitude: point.latitude, longitude: point.longitude, time }
  }
  function captureTargets(kind, fields, complete) {
    const allPets = pets()
    if (kind === 'pet') {
      if (complete) requireValue(!allPets.some(pet => pet.name === fields.name), 'DUPLICATE_NAME', '已有同名猫咪，请先核对档案；不会自动创建第二份。')
      return []
    }
    const ids = kind === 'relationship' ? [fields.fromPetId, fields.toPetId] : [fields.petId]
    const targets = ids.filter(Boolean).map(id => {
      const pet = allPets.find(item => item.id === id)
      requireValue(pet, 'STALE_TARGET', '目标猫咪不存在或已删除，请重新选择。')
      // Target guards contain identity/version only, not duplicate medical or
      // private care histories inside a conversational draft or its export.
      return { id, fingerprint: fingerprint({ id: pet.id, name: pet.name, updatedAt: pet.updatedAt || 0 }) }
    })
    if (complete && kind === 'relationship') requireValue(!relationships().some(item => [item.petAId, item.petBId].includes(fields.fromPetId) && [item.petAId, item.petBId].includes(fields.toPetId)), 'RELATION_EXISTS', '这两只猫已有关系，不能从对话静默覆盖。请到关系记录中核对。')
    return targets
  }
  function createDraft(kind, input) {
    const value = editableActions()
    requireValue(!value.pending, 'PENDING_DRAFT', '已有一张待处理草稿，请先确认或取消；聊天不会丢失。')
    const fields = normalizeFields(kind, input, false)
    const id = freshId('draft')
    requireValue(!value.receipts.some(receipt => receipt.id === id), 'ID_REUSE', '草稿标识已使用，请重新发起。')
    const draft = { id, kind, fields, contentFingerprint: fingerprint(fields), status: 'pending', createdAt: now(), revision: 0, localOnly: true, targets: captureTargets(kind, fields), targetId: kind === 'location' ? id : (kind === 'pet' ? 'pet_' : 'relationship_') + id }
    value.pending = draft; value.revision += 1
    saveActions(value)
    return clone(draft)
  }
  function updateDraft(id, patch) {
    const value = editableActions()
    const draft = value.pending
    requireValue(draft && draft.id === id, 'STALE_DRAFT', '这张草稿已过期，请重新载入。')
    requireValue(draft.status === 'pending', 'UNKNOWN_COMMIT', '上次提交尚未确认，不能改写原请求；请先核对或取消。')
    requireValue(isObject(patch), 'INVALID_INPUT', '修改字段无效。')
    const hasCoordinates = own(patch, 'latitude') || own(patch, 'longitude')
    requireValue(!hasCoordinates || (own(patch, 'latitude') && own(patch, 'longitude')), 'INVALID_INPUT', '重新选位置时必须同时提供经纬度。')
    const fields = normalizeFields(draft.kind, Object.assign({}, draft.fields, patch), draft.kind === 'location' && !hasCoordinates)
    draft.fields = fields; draft.contentFingerprint = fingerprint(fields); draft.targets = captureTargets(draft.kind, fields); draft.revision += 1
    value.revision += 1; saveActions(value)
    return clone(draft)
  }
  function appendExchange(text, reply, source, requestId) {
    const userText = textField(text, 2000, '对话文字')
    const assistantText = textField(reply, 6000, '回复文字')
    const label = source || '云端回复'
    requireValue(['本地引导', '云端回复'].includes(label), 'INVALID_SOURCE', '回复来源必须如实标为本地引导或云端回复。')
    const messages = listMessages()
    const exchangeId = requestId || freshId('exchange')
    requireValue(typeof exchangeId === 'string' && /^[a-zA-Z0-9_-]{1,140}$/.test(exchangeId), 'INVALID_ID', '对话请求标识无效。')
    const exchangeFingerprint = fingerprint([userText, assistantText, label])
    const existing = messages.filter(message => message.requestId === exchangeId)
    if (existing.length) {
      requireValue(existing.length === 2 && existing.every(message => message.exchangeFingerprint === exchangeFingerprint), 'ID_REUSE', '同一回复请求标识不能替换内容。')
      return { reply: assistantText, draft: getDraft(), messages, source: label, duplicate: true }
    }
    requireValue(messages.length + 2 <= 2000, 'CAPACITY', '本机对话已达 2000 条，请先导出历史；未静默删除。')
    const time = now()
    messages.push({ id: exchangeId + '_user', role: 'user', text: userText, time, label: '你', source: '用户输入', requestId: exchangeId, exchangeFingerprint, localOnly: true },
      { id: exchangeId + '_assistant', role: 'assistant', text: assistantText, time, label, source: label, requestId: exchangeId, exchangeFingerprint, localOnly: true })
    write(KEYS.messages, { schema: 1, messages })
    return { reply: assistantText, draft: getDraft(), messages: clone(messages), source: label, duplicate: false }
  }
  function send(text) {
    const userText = textField(text, 2000, '对话文字')
    const intent = intents.parseIntent(userText)
    let reply = intent.reply
    if (intent.kind !== 'unknown') {
      if (getDraft()) reply = '你已有一张待处理草稿。请先确认或取消，我没有替换它；这句话只留在本机聊天中。'
      else {
        let fields = intent.fields
        if (intent.kind === 'relationship') {
          const allPets = pets()
          const from = allPets.filter(pet => pet.name === intent.fromName)
          const to = allPets.filter(pet => pet.name === intent.toName)
          if (from.length !== 1 || to.length !== 1) reply = '找不到唯一对应的两只猫咪档案。请先登记缺少的猫，或在卡片中核对同名档案；我没有建立关系。'
          else fields = Object.assign({}, fields, { fromPetId: from[0].id, toPetId: to[0].id })
        }
        if (!reply) {
          try {
            createDraft(intent.kind, fields)
            reply = intent.kind === 'pet' ? '已整理为猫咪档案草稿，尚未登记。请编辑核对后确认；仅保存到本机。' : '已整理为有向关系草稿，尚未保存。请核对谁是母亲或父亲、谁是孩子；这仅记录你的陈述，不是亲缘鉴定。'
          } catch (error) {
            if (!['DUPLICATE_NAME', 'RELATION_EXISTS', 'SAME_CAT'].includes(error.code)) throw error
            reply = error.message
          }
        }
      }
    }
    return appendExchange(userText, reply, '本地引导')
  }
  function payloadFor(draft) {
    if (draft.kind === 'pet') return Object.assign({ id: draft.targetId }, draft.fields)
    if (draft.kind === 'relationship') {
      const mutual = ['friend', 'playmate'].includes(draft.fields.fromRole)
      const type = draft.fields.fromRole === 'caregiver' ? 'caregiver' : draft.fields.fromRole === 'friend' ? 'bonded' : draft.fields.fromRole === 'playmate' ? 'playmate' : 'family'
      return Object.assign({ id: draft.targetId, petAId: draft.fields.fromPetId, petBId: draft.fields.toPetId, type, directionMode: mutual ? 'mutual' : 'directed' }, draft.fields)
    }
    return clone(draft.fields)
  }
  function findApplied(draft) {
    const payload = payloadFor(draft)
    if (draft.kind === 'pet') {
      const record = pets().find(item => item.id === draft.targetId)
      return { found: Boolean(record), matches: sameFields(record, payload) }
    }
    if (draft.kind === 'relationship') {
      const record = relationships().find(item => item.id === draft.targetId)
      const pair = [payload.petAId, payload.petBId].sort()
      payload.petAId = pair[0]; payload.petBId = pair[1]
      return { found: Boolean(record), matches: sameFields(record, payload) }
    }
    const record = listLocations().find(item => fingerprint(item) === fingerprint(payload))
    return { found: Boolean(record), matches: Boolean(record) }
  }
  function finalize(value, draft) {
    requireValue(value.receipts.length < 5000, 'CAPACITY', '确认回执已达上限，请先导出并核对数据。')
    const receipt = { id: draft.id, fingerprint: draft.contentFingerprint, kind: draft.kind, targetId: draft.targetId, confirmedAt: now() }
    value.receipts.push(receipt); value.pending = null; value.revision += 1
    saveActions(value)
    return { status: 'confirmed', kind: receipt.kind, targetId: receipt.targetId, localOnly: true }
  }
  function confirm(id) {
    const value = editableActions()
    const receipt = value.receipts.find(item => item.id === id)
    if (receipt) return { status: 'already-confirmed', kind: receipt.kind, targetId: receipt.targetId, localOnly: true }
    const draft = value.pending
    requireValue(draft && draft.id === id, 'STALE_DRAFT', '草稿已过期或已取消，不能登记。')
    requireValue(value.receipts.length < 5000, 'CAPACITY', '确认回执已达上限，暂不创建新记录。')
    if (draft.status !== 'pending') {
      const applied = findApplied(draft)
      requireValue(applied.matches, 'UNKNOWN_COMMIT', applied.found ? '上次记录已被修改，请核对；不会覆盖。' : '上次提交结果无法确认，目标可能未保存或已删除；不会自动重建。请取消草稿、核对数据后再主动发起。')
      return finalize(value, draft)
    }
    normalizeFields(draft.kind, draft.fields, draft.kind === 'location', true)
    const currentTargets = captureTargets(draft.kind, draft.fields, true)
    requireValue(fingerprint(currentTargets) === fingerprint(draft.targets), 'STALE_TARGET', '目标档案已改变，请重新编辑核对后确认。')
    const existing = findApplied(draft)
    requireValue(!existing.found, 'ID_REUSE', '这项记录标识已存在，不能覆盖或重复保存。')
    const payload = payloadFor(draft)
    if (draft.kind === 'location') requireValue(listLocations().length < 2000, 'CAPACITY', '本机地点最多 2000 条，未静默删除。')
    draft.status = 'saving'; value.revision += 1
    saveActions(value) // Write-ahead intent: no entity mutation until this succeeds.
    try {
      if (draft.kind === 'pet') storage.savePet(payload)
      else if (draft.kind === 'relationship') storage.saveRelationship(payload)
      else write(KEYS.locations, listLocations().concat(payload))
      requireValue(findApplied(draft).matches, 'WRITE_UNCONFIRMED', '记录尚未读回确认，请勿重复创建。')
    } catch (error) {
      // Keep the write-ahead request unchanged. A later retry only reconciles an
      // existing exact result; it never resurrects a missing/deleted entity.
      error.message = '保存结果尚未确认：' + error.message + '。草稿和聊天均保留，请重试核对；若目标不存在请取消后检查数据。'
      throw error
    }
    return finalize(value, draft)
  }
  function cancel(id) {
    const value = editableActions()
    requireValue(value.pending && value.pending.id === id, 'STALE_DRAFT', '草稿已过期或已处理。')
    const uncertain = value.pending.status !== 'pending'
    value.pending = null; value.revision += 1; saveActions(value)
    return { cancelled: true, uncertain, localOnly: true, message: uncertain ? '已关闭待核对草稿；不撤销可能已经保存的记录，请到自己的数据核对。' : '已取消草稿，聊天记录保留。' }
  }
  function getOverview() {
    const allPets = pets(); const allRelationships = relationships(); const locations = listLocations(); const messages = listMessages()
    return { pets: allPets, relationships: allRelationships, locations, actionReceipts: publicReceipts(), counts: { pets: allPets.length, relationships: allRelationships.length, locations: locations.length, messages: messages.length }, localOnly: true }
  }
  function publicReceipts() {
    // Historical confirmations are not an assertion that the target still
    // exists. Export only this explicit allowlist, never content fingerprints.
    return actions().receipts.map(receipt => ({ id: receipt.id, kind: receipt.kind, targetId: receipt.targetId, confirmedAt: receipt.confirmedAt }))
  }
  function exportHistory() {
    const state = getState()
    const draft = state.draft ? { id: state.draft.id, kind: state.draft.kind, fields: state.draft.fields, status: state.draft.status, createdAt: state.draft.createdAt, revision: state.draft.revision, localOnly: true } : null
    return JSON.stringify({ schema: 1, exportedAt: now(), scope: '本机对话、草稿与历史确认回执，不含云端备份；回执不表示目标仍存在', messages: state.messages, draft, actionReceipts: publicReceipts(), composerText: state.composerText, replySource: state.replySource, storage: 'local', localOnly: true }, null, 2)
  }
  return { getState, listMessages, loadHistory: listMessages, getDraft, createDraft, updateDraft, send, appendExchange, confirm, cancel, getOverview, listLocations, exportHistory, saveComposerDraft, getComposerDraft, coarseLocation: intents.coarseLocation }
}

module.exports = Object.assign({ createService, KEYS, MEDICAL_NOTICE: intents.MEDICAL_NOTICE }, createService())
