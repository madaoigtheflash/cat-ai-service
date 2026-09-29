'use strict'

const NAME_LIMIT = 12
const SCENARIOS = ['start', 'interrupted', 'finished']

// Unknown host preference uses the calmer default. A saved explicit choice is preserved.
function defaults(systemReduceMotion) {
  return {
    nickname: '猫咪家长', assistantName: '小猫助手', tone: 'gentle',
    notificationsEnabled: false, quietEnabled: true,
    quietStart: '22:00', quietEnd: '08:00',
    reduceMotion: typeof systemReduceMotion === 'boolean' ? systemReduceMotion : true
  }
}

function minutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null
  const parts = value.split(':').map(Number)
  return parts[0] * 60 + parts[1]
}

function validate(input) {
  const source = input || {}
  const errors = {}
  const value = {}
  ;[['nickname', '你的称呼'], ['assistantName', '助手自称']].forEach(([key, label]) => {
    value[key] = typeof source[key] === 'string' ? source[key].trim() : ''
    if (!value[key] || Array.from(value[key]).length > NAME_LIMIT) errors[key] = `${label}请填写 1–${NAME_LIMIT} 个字，不能只填空格。`
    else if (/[\r\n\t\x00-\x1F\x7F]/.test(value[key])) errors[key] = `${label}不能包含换行或控制字符。`
  })
  value.tone = source.tone
  if (!['gentle', 'concise'].includes(value.tone)) errors.tone = '请选择温柔或简洁语气。'
  ;['notificationsEnabled', 'quietEnabled', 'reduceMotion'].forEach(key => {
    value[key] = source[key]
    if (typeof value[key] !== 'boolean') errors[key] = '开关状态无效，请重新选择。'
  })
  ;['quietStart', 'quietEnd'].forEach(key => {
    value[key] = source[key]
    if (minutes(value[key]) === null) errors[key] = '请选择有效时间（00:00–23:59）。'
  })
  return { ok: !Object.keys(errors).length, value, errors }
}

function restore(stored, systemReduceMotion) {
  if (stored === null) return defaults(systemReduceMotion)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw Error('本机偏好格式无效')
  const result = validate(Object.assign(defaults(systemReduceMotion), stored))
  if (!result.ok) throw Error('本机偏好包含无效内容')
  return result.value
}

// Local wall clock only: start inclusive, end exclusive; equal endpoints mean all day.
function isQuiet(prefs, clock) {
  if (!prefs.quietEnabled) return false
  const now = minutes(clock)
  const start = minutes(prefs.quietStart)
  const end = minutes(prefs.quietEnd)
  if (now === null || start === null || end === null) return true
  if (start === end) return true
  return start < end ? now >= start && now < end : now >= start || now < end
}

function sceneText(prefs, scenario) {
  const person = String(prefs.nickname || '').trim() || '你'
  const name = String(prefs.assistantName || '').trim() || '小猫助手'
  const scene = SCENARIOS.includes(scenario) ? scenario : 'start'
  const gentle = {
    start: `${person}，我是${name}。可以从一件小事开始，也可以先休息。节奏由你决定。`,
    interrupted: `${person}，中断也没关系。需要时再继续，或就停在这里，不用补打卡。`,
    finished: `${person}，这次已结束。你可以回看自己的记录，也可以收起页面，好好休息。`
  }
  const concise = {
    start: `${person}，${name}已就绪。开始一件小事，或先休息。`,
    interrupted: `${person}，已暂停。按需继续，也可以结束。`,
    finished: `${person}，本次结束。回看记录，或休息。`
  }
  return (prefs.tone === 'concise' ? concise : gentle)[scene]
}

function promptResult(prefs, clock, scenario) {
  if (!validate(prefs).ok || minutes(clock) === null) return { shown: false, kind: 'invalid', reason: '偏好或模拟时间无效，未显示提示。', text: '' }
  if (!prefs.notificationsEnabled) return { shown: false, kind: 'off', reason: '页内提示已关闭，本次没有弹出提示。', text: '' }
  if (isQuiet(prefs, clock)) return { shown: false, kind: 'quiet', reason: `模拟 ${clock} 在安静时段内，本次页内提示已拦住。`, text: '' }
  return { shown: true, kind: 'shown', reason: `模拟 ${clock} 不在安静时段，本页显示一条示例提示。`, text: sceneText(prefs, scenario) }
}

function equal(left, right) {
  return Boolean(left && right) && Object.keys(defaults()).every(key => left[key] === right[key])
}

module.exports = { NAME_LIMIT, SCENARIOS, defaults, minutes, validate, restore, isQuiet, sceneText, promptResult, equal }
