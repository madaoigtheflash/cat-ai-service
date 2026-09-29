'use strict'

// This module has no wx, network, storage, model, or original-record dependency.
const CATS = Object.freeze([
  Object.freeze({ id: 'sim-nuomi', name: '糯米', label: '糯米 · 合成猫 A' }),
  Object.freeze({ id: 'sim-zhima', name: '芝麻', label: '芝麻 · 合成猫 B' }),
  Object.freeze({ id: 'sim-taosu', name: '桃酥', label: '桃酥 · 合成猫 C' })
])
const OBSERVERS = Object.freeze([
  Object.freeze({ id: 'sim-observer-a', name: '观察者小禾（模拟）' }),
  Object.freeze({ id: 'sim-observer-b', name: '观察者阿宁（模拟）' })
])
const KINDS = Object.freeze([
  Object.freeze({ id: 'approach', name: '主动接近', fromRole: '接近发起方', toRole: '被接近方', checklist: '分别记录谁先移动、另一只猫如何回应；留意距离变化与当时环境，不主动诱导互动。' }),
  Object.freeze({ id: 'follow', name: '跟随移动', fromRole: '跟随方', toRole: '被跟随方', checklist: '分别记录移动先后、持续时长与是否多次发生；保留没有跟随的时段，不用一次互动推断长期关系。' }),
  Object.freeze({ id: 'groom', name: '发起梳理', fromRole: '梳理发起方', toRole: '接受梳理方', checklist: '分别记录谁先发起梳理、持续时长与对方反应；只记录自然发生的行为，不推断亲缘或健康状况。' })
])
const CHOICES = Object.freeze([
  Object.freeze({ id: 'consistent', name: '这段记录与假设相符' }),
  Object.freeze({ id: 'uncertain', name: '暂不能判断' }),
  Object.freeze({ id: 'inconsistent', name: '这段记录与假设不符' })
])
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const clone = value => JSON.parse(JSON.stringify(value))
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function requireValue(value, code, message) { if (!value) fail(code, message) }
function exactKeys(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_DATA', '实验数据格式无效，未覆盖已有记录。')
  requireValue(Object.keys(value).length === keys.length && keys.every(key => own(value, key)), 'INVALID_DATA', '实验数据字段无效，未覆盖已有记录。')
}
function textValue(value, max, message) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_INPUT', message)
  return value.trim()
}
function identifier(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) }
function member(list, id) { return list.find(item => item.id === id) }
function validTime(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false
  const parts = value.split(/[-T:]/).map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4])
  return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2] && date.getHours() === parts[3] && date.getMinutes() === parts[4]
}
function directionId(fromId, toId) { return fromId + '>' + toId }
function checkDirection(fromId, toId, kindId, fromRole, toRole) {
  requireValue(member(CATS, fromId) && member(CATS, toId), 'INVALID_CAT', '只能选择列表中的合成猫，不能关联真实身份。')
  requireValue(fromId !== toId, 'SAME_CAT', '请选择两只不同的合成猫。')
  const kind = member(KINDS, kindId)
  requireValue(kind && kind.fromRole === fromRole && kind.toRole === toRole, 'INVALID_ROLE', '关系类型或方向角色不在允许范围内。')
}
function initialState() { return { schemaVersion: 1, version: 0, plans: [], receipts: [] } }
function validateState(state) {
  exactKeys(state, ['schemaVersion', 'version', 'plans', 'receipts'])
  requireValue(state.schemaVersion === 1 && Number.isSafeInteger(state.version) && state.version >= 0, 'INVALID_DATA', '实验数据版本不受支持，未覆盖已有记录。')
  requireValue(Array.isArray(state.plans) && state.plans.length <= 6 && Array.isArray(state.receipts) && state.receipts.length <= 2000 && state.receipts.length === state.version, 'INVALID_DATA', '实验数据数量或版本无效。')
  const planIds = new Set()
  state.plans.forEach(plan => {
    exactKeys(plan, ['id', 'fromId', 'toId', 'kindId', 'fromRole', 'toRole', 'observeAt', 'checklist', 'status', 'evidence', 'votes'])
    checkDirection(plan.fromId, plan.toId, plan.kindId, plan.fromRole, plan.toRole)
    requireValue(plan.id === directionId(plan.fromId, plan.toId) && !planIds.has(plan.id), 'INVALID_DATA', '同一方向只能有一个观察计划。')
    planIds.add(plan.id)
    requireValue(validTime(plan.observeAt), 'INVALID_TIME', '请设定有效的观察日期与时间（2000—2099 年）。')
    textValue(plan.checklist, 800, '观察清单需填写 1—800 字。')
    requireValue(['active', 'completed'].includes(plan.status), 'INVALID_DATA', '计划状态无效。')
    requireValue(Array.isArray(plan.evidence) && plan.evidence.length <= 200 && Array.isArray(plan.votes) && plan.votes.length <= OBSERVERS.length, 'INVALID_DATA', '证据或投票数量无效。')
    const evidenceIds = new Set()
    plan.evidence.forEach(item => {
      exactKeys(item, ['id', 'observedAt', 'note', 'active'])
      requireValue(identifier(item.id) && !evidenceIds.has(item.id) && typeof item.active === 'boolean', 'INVALID_DATA', '证据标识或状态无效。')
      requireValue(validTime(item.observedAt), 'INVALID_TIME', '请填写有效的证据记录日期与时间。')
      textValue(item.note, 800, '证据笔记需填写 1—800 字。')
      evidenceIds.add(item.id)
    })
    const voters = new Set()
    plan.votes.forEach(vote => {
      exactKeys(vote, ['observerId', 'choice', 'evidenceIds'])
      requireValue(member(OBSERVERS, vote.observerId) && !voters.has(vote.observerId), 'INVALID_OBSERVER', '每位模拟观察者每个方向只能有一票。')
      requireValue(member(CHOICES, vote.choice), 'INVALID_CHOICE', '请选择允许的中性判断。')
      requireValue(Array.isArray(vote.evidenceIds) && vote.evidenceIds.length > 0 && new Set(vote.evidenceIds).size === vote.evidenceIds.length && vote.evidenceIds.every(id => plan.evidence.some(item => item.id === id && item.active)), 'MISSING_EVIDENCE', '投票必须引用本方向仍有效的证据。')
      voters.add(vote.observerId)
    })
    requireValue(plan.status !== 'completed' || plan.evidence.some(item => item.active), 'MISSING_EVIDENCE', '没有有效证据的计划不能标为完成。')
  })
  const requestIds = new Set()
  state.receipts.forEach(receipt => {
    exactKeys(receipt, ['id', 'fingerprint'])
    requireValue(identifier(receipt.id) && !requestIds.has(receipt.id) && typeof receipt.fingerprint === 'string' && receipt.fingerprint.length <= 30000, 'INVALID_DATA', '实验提交记录无效。')
    requestIds.add(receipt.id)
  })
  return state
}
const FIELDS = {
  create: ['fromId', 'toId', 'kindId', 'fromRole', 'toRole', 'observeAt', 'checklist'],
  edit: ['planId', 'observeAt', 'checklist'],
  addEvidence: ['planId', 'evidenceId', 'observedAt', 'note'],
  withdrawEvidence: ['planId', 'evidenceId'],
  vote: ['planId', 'observerId', 'choice', 'evidenceIds'],
  withdrawVote: ['planId', 'observerId'],
  setStatus: ['planId', 'status']
}
function applyCommand(state, command) {
  validateState(state)
  requireValue(command && own(FIELDS, command.type), 'INVALID_COMMAND', '不支持此操作。')
  exactKeys(command, ['type', 'opId', 'expectedVersion'].concat(FIELDS[command.type]))
  requireValue(identifier(command.opId) && Number.isSafeInteger(command.expectedVersion) && command.expectedVersion >= 0, 'INVALID_COMMAND', '提交标识或版本无效。')
  const fingerprint = JSON.stringify(['type', 'opId', 'expectedVersion'].concat(FIELDS[command.type]).map(key => [key, command[key]]))
  const receipt = state.receipts.find(item => item.id === command.opId)
  if (receipt) {
    requireValue(receipt.fingerprint === fingerprint, 'OP_REUSED', '该提交标识已用于其他内容，请重新发起。')
    return { state: clone(state), replayed: true }
  }
  requireValue(command.expectedVersion === state.version, 'VERSION_CONFLICT', '记录已在另一页面改变。已刷新列表，输入仍保留，请核对后再次保存。')
  requireValue(state.receipts.length < 2000, 'CAPACITY', '本实验已达到 2000 次操作上限，请先审计记录。')
  const next = clone(state)
  let plan = next.plans.find(item => item.id === command.planId)
  if (command.type !== 'create') requireValue(plan, 'MISSING_PLAN', '此方向计划已不存在，请重新选择。')
  if (['edit', 'addEvidence', 'vote'].includes(command.type)) requireValue(plan.status === 'active', 'COMPLETED', '计划已完成；请先撤销完成，再编辑或补充。')
  switch (command.type) {
    case 'create': {
      checkDirection(command.fromId, command.toId, command.kindId, command.fromRole, command.toRole)
      const id = directionId(command.fromId, command.toId)
      requireValue(!next.plans.some(item => item.id === id), 'DUPLICATE_DIRECTION', '这个方向已有计划，请在列表打开；反向需要另建。')
      plan = { id, fromId: command.fromId, toId: command.toId, kindId: command.kindId, fromRole: command.fromRole, toRole: command.toRole, observeAt: command.observeAt, checklist: textValue(command.checklist, 800, '观察清单需填写 1—800 字。'), status: 'active', evidence: [], votes: [] }
      next.plans.push(plan)
      break
    }
    case 'edit':
      plan.observeAt = command.observeAt
      plan.checklist = textValue(command.checklist, 800, '观察清单需填写 1—800 字。')
      break
    case 'addEvidence':
      requireValue(identifier(command.evidenceId) && !plan.evidence.some(item => item.id === command.evidenceId), 'DUPLICATE_EVIDENCE', '证据标识无效或已经保存，未重复添加。')
      plan.evidence.push({ id: command.evidenceId, observedAt: command.observedAt, note: textValue(command.note, 800, '证据笔记需填写 1—800 字。'), active: true })
      break
    case 'withdrawEvidence': {
      const evidence = plan.evidence.find(item => item.id === command.evidenceId)
      requireValue(evidence && evidence.active, 'MISSING_EVIDENCE', '该证据不存在或已经撤回。')
      evidence.active = false
      plan.votes = plan.votes.filter(vote => !vote.evidenceIds.includes(evidence.id))
      if (!plan.evidence.some(item => item.active)) plan.status = 'active'
      break
    }
    case 'vote': {
      requireValue(member(OBSERVERS, command.observerId), 'INVALID_OBSERVER', '只能以两位明确标记的模拟观察者操作。')
      requireValue(member(CHOICES, command.choice), 'INVALID_CHOICE', '请选择允许的中性判断。')
      requireValue(Array.isArray(command.evidenceIds), 'MISSING_EVIDENCE', '请选择本方向的有效证据。')
      const vote = { observerId: command.observerId, choice: command.choice, evidenceIds: command.evidenceIds.slice() }
      plan.votes = plan.votes.filter(item => item.observerId !== vote.observerId).concat(vote)
      break
    }
    case 'withdrawVote':
      requireValue(member(OBSERVERS, command.observerId), 'INVALID_OBSERVER', '模拟观察者身份无效。')
      requireValue(plan.votes.some(item => item.observerId === command.observerId), 'MISSING_VOTE', '这位模拟观察者在本方向尚未投票。')
      plan.votes = plan.votes.filter(item => item.observerId !== command.observerId)
      break
    case 'setStatus':
      requireValue(['active', 'completed'].includes(command.status), 'INVALID_STATUS', '计划状态无效。')
      plan.status = command.status
      break
  }
  next.version += 1
  next.receipts.push({ id: command.opId, fingerprint })
  validateState(next)
  return { state: next, replayed: false }
}
function describePlan(plan) {
  const from = member(CATS, plan.fromId)
  const to = member(CATS, plan.toId)
  return { ...plan, fromName: from.name, toName: to.name, direction: from.name + ' → ' + to.name, roles: from.name + '：' + plan.fromRole + '；' + to.name + '：' + plan.toRole, kindName: member(KINDS, plan.kindId).name, timeLabel: plan.observeAt.replace('T', ' '), statusLabel: plan.status === 'completed' ? '已完成记录' : '待观察 / 记录中' }
}
function distribution(state, planId) {
  validateState(state)
  const plan = state.plans.find(item => item.id === planId)
  requireValue(plan, 'MISSING_PLAN', '请先选择方向。')
  return { direction: describePlan(plan).direction, total: plan.votes.length, unvoted: OBSERVERS.length - plan.votes.length, rows: CHOICES.map(choice => ({ ...choice, count: plan.votes.filter(vote => vote.choice === choice.id).length })) }
}
module.exports = { CATS, OBSERVERS, KINDS, CHOICES, initialState, validateState, validTime, directionId, applyCommand, describePlan, distribution }
