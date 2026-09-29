'use strict'

// No platform APIs: domain transitions are pure; the repository receives an isolated store.
const SCHEMA_VERSION = 1
const OWNER = 'local-observer'
const CANDIDATES = Object.freeze([
  Object.freeze({ id: 'demo-taotao', name: '桃桃', description: '合成示例：橘白短毛，尾尖白色。并非真实猫咪档案。' }),
  Object.freeze({ id: 'demo-doudou', name: '豆豆', description: '合成示例：灰白短毛，鼻旁灰色斑。并非真实猫咪档案。' })
])
const CONCLUSIONS = Object.freeze({ insufficient: '证据不足', possible_same: '可能同一只', different: '不同' })
function fail(message) { throw new Error(message) }
function copy(value) { return JSON.parse(JSON.stringify(value)) }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function exact(value, keys) {
  if (!object(value) || Object.keys(value).sort().join('|') !== keys.slice().sort().join('|')) fail('记录结构不受支持，请勿覆盖原数据')
}
function string(value, label, max, min = 1) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max) fail(label + '格式无效')
  return value
}
function id(value) { if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,100}$/.test(value)) fail('记录标识无效'); return value }
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) fail('记录版本无效') }
function dateValue(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) fail('请填写有效日期和时间（2000—2099年）')
  const [year, month, day, hour, minute] = value.match(/\d+/g).map(Number)
  const date = new Date(year, month - 1, day, hour, minute)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) fail('日期或时间不存在')
  return date.getTime()
}
function area(value) {
  string(value, '粗略区域', 60, 2)
  if (/[-+]?\d{1,3}\.\d+\s*[,，、\s]\s*[-+]?\d{1,3}\.\d+|\d+\s*(号|栋|幢|室|单元)|1[3-9]\d{9}|经度|纬度|GPS/i.test(value)) fail('只填写粗略区域，不填坐标、门牌或联系方式')
  return value
}
function candidate(value, optional) {
  if (optional && value === null) return value
  if (!CANDIDATES.some(item => item.id === value)) fail('只能选择本页的合成示例猫名片')
  return value
}
function emptyState() { return { schemaVersion: SCHEMA_VERSION, revision: 0, encounters: [], operations: [] } }
function validateRecord(record) {
  exact(record, ['id', 'ownerId', 'version', 'area', 'observedAt', 'revisitAt', 'note', 'evidence', 'candidateId', 'conclusion', 'reason', 'linkedCardId', 'completedAt'])
  id(record.id); integer(record.version)
  if (record.version < 1 || record.ownerId !== OWNER) fail('目击角色或版本无效')
  area(record.area); string(record.note, '观察笔记', 500)
  const seen = dateValue(record.observedAt)
  if (dateValue(record.revisitAt) <= seen) fail('回访时间须晚于目击时间')
  if (!Array.isArray(record.evidence) || record.evidence.length > 100) fail('证据列表无效')
  const ids = new Set()
  record.evidence.forEach(item => {
    exact(item, ['id', 'at', 'note']); id(item.id); string(item.note, '证据笔记', 800)
    if (ids.has(item.id) || dateValue(item.at) < seen) fail('证据时间或标识无效')
    ids.add(item.id)
  })
  candidate(record.candidateId, true)
  if (!Object.prototype.hasOwnProperty.call(CONCLUSIONS, record.conclusion)) fail('人工结论无效')
  string(record.reason, '判断说明', 500, record.candidateId === null ? 0 : 1)
  if (record.candidateId === null && (record.conclusion !== 'insufficient' || record.reason !== '')) fail('请先选择候选猫')
  if (record.conclusion !== 'insufficient' && record.evidence.length === 0) fail('请先补充一次带时间的证据笔记')
  if (record.linkedCardId !== null && (candidate(record.linkedCardId) !== record.candidateId || record.conclusion !== 'possible_same' || record.evidence.length === 0)) fail('名片关联与人工假设不一致')
  if (record.completedAt !== null && dateValue(record.completedAt) < seen) fail('回访完成时间无效')
  return record
}
function validateState(state) {
  exact(state, ['schemaVersion', 'revision', 'encounters', 'operations'])
  if (state.schemaVersion !== SCHEMA_VERSION) fail('数据版本不受支持，请保留原数据')
  integer(state.revision)
  if (!Array.isArray(state.encounters) || state.encounters.length > 100 || !Array.isArray(state.operations) || state.operations.length > 1000) fail('本地记录容量或结构无效')
  const ids = new Set()
  state.encounters.forEach(record => { validateRecord(record); if (ids.has(record.id)) fail('目击标识重复'); ids.add(record.id) })
  const operations = new Set()
  state.operations.forEach(operation => {
    exact(operation, ['id', 'signature']); id(operation.id); string(operation.signature, '操作凭据', 5000)
    if (operations.has(operation.id)) fail('操作凭据重复')
    operations.add(operation.id)
  })
  if (state.revision !== state.operations.length) fail('记录版本与操作凭据不一致')
  return copy(state)
}
function signature(value) {
  if (Array.isArray(value)) return '[' + value.map(signature).join(',') + ']'
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + signature(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function applyCommand(state, command, now) {
  const next = validateState(state)
  if (!object(command) || !object(command.actor) || command.actor.id !== OWNER || command.actor.role !== 'observer') fail('当前为只读角色，不能修改本机记录')
  id(command.operationId); id(command.encounterId)
  const receipt = signature(command)
  const duplicate = next.operations.find(item => item.id === command.operationId)
  if (duplicate) { if (duplicate.signature !== receipt) fail('重复操作标识对应了不同内容，请重新操作'); return next }
  integer(command.expectedRevision)
  if (command.expectedRevision !== next.revision) fail('记录已有更新，请重新载入后再操作')
  if (next.operations.length >= 1000) fail('实验操作数量已达上限，请先保留所需笔记')
  const nowValue = dateValue(now)
  let record = next.encounters.find(item => item.id === command.encounterId)
  const input = command.input || {}
  if (command.type === 'create') {
    if (record) fail('目击标识重复')
    if (next.encounters.length >= 100) fail('最多保存100条目击，请先整理记录')
    exact(input, ['area', 'observedAt', 'revisitAt', 'note'])
    if (dateValue(input.observedAt) > nowValue) fail('目击时间不能晚于当前时间')
    record = { id: command.encounterId, ownerId: OWNER, version: 1, ...input, evidence: [], candidateId: null, conclusion: 'insufficient', reason: '', linkedCardId: null, completedAt: null }
    validateRecord(record); next.encounters.unshift(record)
  } else {
    if (!record) fail('目击记录不存在')
    integer(command.expectedVersion)
    if (command.expectedVersion !== record.version) fail('该目击已更新，请重新载入后再操作')
    switch (command.type) {
      case 'edit':
        exact(input, ['area', 'observedAt', 'revisitAt', 'note'])
        if (dateValue(input.observedAt) > nowValue) fail('目击时间不能晚于当前时间')
        Object.assign(record, input)
        break
      case 'evidence':
        exact(input, ['id', 'at', 'note']); id(input.id)
        if (record.evidence.some(item => item.id === input.id)) fail('证据标识重复')
        if (dateValue(input.at) > nowValue) fail('证据时间不能晚于当前时间')
        record.evidence.push(copy(input))
        break
      case 'review':
        exact(input, ['candidateId', 'conclusion', 'reason']); candidate(input.candidateId)
        if (record.linkedCardId && (input.candidateId !== record.candidateId || input.conclusion !== record.conclusion)) fail('请先撤销名片关联，再修改候选或结论')
        Object.assign(record, input)
        break
      case 'link':
        exact(input, ['candidateId']); candidate(input.candidateId)
        if (record.linkedCardId) fail('已有名片关联，无需重复关联')
        if (record.candidateId !== input.candidateId || record.conclusion !== 'possible_same' || record.evidence.length === 0) fail('仅可关联已补充证据且人工判断为“可能同一只”的候选')
        record.linkedCardId = input.candidateId
        break
      case 'unlink':
        exact(input, [])
        if (!record.linkedCardId) fail('当前没有可撤销的关联')
        record.linkedCardId = null
        break
      case 'complete':
        exact(input, [])
        if (record.completedAt) fail('回访已完成，无需重复完成')
        if (record.evidence.length === 0) fail('请先补充本次回访的时间和证据笔记')
        record.completedAt = now
        break
      case 'reopen':
        exact(input, [])
        if (!record.completedAt) fail('回访尚未完成')
        record.completedAt = null
        break
      default: fail('不支持的操作')
    }
    record.version += 1
    validateRecord(record)
  }
  next.revision += 1
  next.operations.push({ id: command.operationId, signature: receipt })
  return validateState(next)
}
function createRepository(store) {
  let current = null
  let ready = false
  function load() {
    ready = false
    const loaded = validateState(store.load('notebook', emptyState()))
    current = loaded; ready = true
    return copy(current)
  }
  return {
    load,
    isReady() { return ready },
    commit(command, now) {
      if (!ready) fail('读取未成功，请先重新载入，原记录不会被覆盖')
      let latest
      try { latest = validateState(store.load('notebook', emptyState())) } catch (error) { ready = false; throw error }
      if (signature(latest) !== signature(current)) { ready = false; fail('本地记录已变化，请重新载入后再操作') }
      const next = applyCommand(current, command, now)
      if (next.revision === current.revision) return copy(current)
      try { store.save('notebook', next) } catch (error) { ready = false; throw new Error('保存未获确认；已保留表单，请重新载入核对记录后再操作') }
      current = next
      return copy(current)
    }
  }
}
module.exports = { SCHEMA_VERSION, OWNER, CANDIDATES, CONCLUSIONS, emptyState, validateState, dateValue, applyCommand, createRepository }
