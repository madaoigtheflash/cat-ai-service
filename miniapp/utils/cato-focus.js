'use strict'

const MINUTE = 60000
const ACTIVITIES = ['companion', 'study']
const MODES = ['pomodoro', 'countup']
const clone = value => JSON.parse(JSON.stringify(value))
function demand(condition, message) { if (!condition) throw new Error(message) }
function timestamp(value) { demand(Number.isFinite(value) && value >= 0 && value <= 8640000000000000, '时间无效'); return value }
function title(value) { const result = String(value || '').trim(); demand(result.length > 0 && result.length <= 60, '请填写 1–60 字的活动名称'); return result }
function minutes(value, max, label) { const result = Number(value); demand(Number.isInteger(result) && result >= 1 && result <= max, label + '需为 1–' + max + ' 的整数分钟'); return result }
function parseTags(value) {
  const tags = Array.isArray(value) ? value : String(value || '').split(/[,，、\n]/)
  const result = [...new Set(tags.map(tag => String(tag).trim()).filter(Boolean))]
  demand(result.length <= 5 && result.every(tag => tag.length <= 16), '标签最多 5 个，每个不超过 16 字')
  return result
}
function createSession(input, now, id) {
  timestamp(now)
  demand(typeof id === 'string' && id.length > 0, '记录标识无效')
  demand(ACTIVITIES.includes(input.activity), '请选择陪伴或学习活动')
  demand(MODES.includes(input.mode), '请选择计时方式')
  return { id, activity: input.activity, title: title(input.title), mode: input.mode,
    workMinutes: input.mode === 'countup' ? 25 : minutes(input.workMinutes, 180, '专注时长'), restMinutes: input.mode === 'countup' ? 5 : minutes(input.restMinutes, 60, '休息时长'),
    phase: 'work', status: 'running', phaseElapsedMs: 0, workMs: 0, restMs: 0,
    runSince: now, startedAt: now, updatedAt: now, rounds: 1 }
}
function snapshot(session, now) {
  timestamp(now)
  const limit = session.mode === 'pomodoro' ? (session.phase === 'work' ? session.workMinutes : session.restMinutes) * MINUTE : null
  const delta = session.status === 'running' ? Math.max(0, now - session.runSince) : 0
  const phaseMs = limit === null ? session.phaseElapsedMs + delta : Math.min(limit, session.phaseElapsedMs + delta)
  const added = Math.max(0, phaseMs - session.phaseElapsedMs)
  return { phaseElapsedMs: phaseMs, workMs: session.workMs + (session.phase === 'work' ? added : 0),
    restMs: session.restMs + (session.phase === 'rest' ? added : 0), remainingMs: limit === null ? null : Math.max(0, limit - phaseMs),
    reached: limit !== null && phaseMs >= limit, clockMovedBack: session.status === 'running' && now < session.runSince }
}
function pauseSession(session, now) {
  const current = snapshot(session, now)
  return { ...session, phaseElapsedMs: current.phaseElapsedMs, workMs: current.workMs, restMs: current.restMs, status: 'paused', runSince: null, updatedAt: now }
}
function resumeSession(session, now) {
  timestamp(now)
  demand(session.status === 'paused', '当前计时没有暂停')
  demand(!snapshot(session, now).reached, '本阶段已到点，请选择下一阶段或结束')
  return { ...session, status: 'running', runSince: now, updatedAt: now }
}
function advancePhase(session, now) {
  demand(session.mode === 'pomodoro' && snapshot(session, now).reached, '本阶段尚未到点')
  const settled = pauseSession(session, now)
  const phase = session.phase === 'work' ? 'rest' : 'work'
  return { ...settled, phase, phaseElapsedMs: 0, status: 'running', runSince: now, updatedAt: now,
    rounds: session.rounds + (phase === 'work' ? 1 : 0) }
}
function finishSession(session, input, now) {
  demand(session.status === 'paused', '请先暂停并核对，再确认结束')
  timestamp(now)
  return { id: session.id, title: title(input.title === undefined ? session.title : input.title), activity: session.activity,
    mode: session.mode, workMs: session.workMs, restMs: session.restMs, startedAt: session.startedAt, endedAt: now,
    tags: parseTags(input.tags), taskCompleted: input.taskCompleted === true, rounds: session.rounds, edited: false }
}
function editRecord(record, input) {
  const duration = Number(input.minutes)
  demand(String(input.minutes).trim() !== '' && Number.isFinite(duration) && duration >= 0 && duration <= 10080, '专注分钟数需在 0–10080 之间')
  const endedAt = input.endedAt === undefined ? record.endedAt : timestamp(input.endedAt)
  return { ...record, title: title(input.title), tags: parseTags(input.tags), workMs: Math.round(duration * MINUTE), endedAt,
    taskCompleted: input.taskCompleted === true, edited: true }
}
function summarize(records, now) {
  timestamp(now)
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
  const week = new Date(today); week.setDate(week.getDate() - (week.getDay() + 6) % 7)
  const nextWeek = new Date(week); nextWeek.setDate(nextWeek.getDate() + 7)
  const month = new Date(today); month.setDate(1)
  const nextMonth = new Date(month); nextMonth.setMonth(nextMonth.getMonth() + 1)
  const sum = (start, end) => records.filter(record => record.endedAt >= +start && record.endedAt < +end)
    .reduce((result, record) => ({ workMs: result.workMs + record.workMs, count: result.count + 1,
      completed: result.completed + (record.taskCompleted ? 1 : 0) }), { workMs: 0, count: 0, completed: 0 })
  return { day: sum(today, tomorrow), week: sum(week, nextWeek), month: sum(month, nextMonth) }
}
function validateState(value) {
  demand(value && value.version === 1 && Array.isArray(value.records), '本机记录格式无法读取；请勿覆盖，可返回入口后决定是否重置')
  const ids = new Set()
  value.records.forEach(record => {
    demand(record && typeof record.id === 'string' && record.id && !ids.has(record.id), '本机记录标识异常')
    ids.add(record.id); title(record.title); parseTags(record.tags); timestamp(record.startedAt); timestamp(record.endedAt)
    demand(ACTIVITIES.includes(record.activity) && MODES.includes(record.mode) && typeof record.taskCompleted === 'boolean' &&
      Number.isFinite(record.workMs) && record.workMs >= 0 && Number.isFinite(record.restMs) && record.restMs >= 0, '本机记录内容异常')
  })
  if (value.active) {
    const active = value.active
    createSession(active, active.startedAt, active.id)
    demand(!ids.has(active.id) && ['running', 'paused'].includes(active.status) && ['work', 'rest'].includes(active.phase), '本机计时状态异常')
    demand(active.mode !== 'countup' || active.phase === 'work', '正计时阶段异常')
    ;['phaseElapsedMs', 'workMs', 'restMs'].forEach(key => demand(Number.isFinite(active[key]) && active[key] >= 0, '本机计时时长异常'))
    demand(active[active.phase === 'work' ? 'workMs' : 'restMs'] >= active.phaseElapsedMs, '本机阶段累计异常')
    demand(Number.isInteger(active.rounds) && active.rounds > 0, '本机轮次异常')
    if (active.status === 'running') timestamp(active.runSince)
    else demand(active.runSince === null, '本机暂停时间戳异常')
    timestamp(active.updatedAt)
    const limit = active.phase === 'work' ? active.workMinutes : active.restMinutes
    demand(active.mode !== 'pomodoro' || active.phaseElapsedMs <= limit * MINUTE, '本机阶段时长异常')
  } else demand(value.active === null, '本机计时状态异常')
  return clone(value)
}
function createFocusController({ store, clock = Date.now, idFactory = now => 'focus_' + now + '_' + Math.random().toString(36).slice(2, 10) }) {
  let state = { version: 1, active: null, records: [] }
  let loadError = ''
  function reload() {
    try { state = validateState(store.load('state', { version: 1, active: null, records: [] })); loadError = '' }
    catch (error) { loadError = '读取本机记录失败：' + error.message }
    return getState()
  }
  function ready() { demand(!loadError, loadError) }
  function save(next) { ready(); store.save('state', next); state = next; return getState() }
  function getState() { return { ...clone(state), loadError, current: state.active ? snapshot(state.active, clock()) : null } }
  function activeFor(id) { ready(); demand(state.active && state.active.id === id, '本次计时已结束或不存在'); return state.active }
  const controller = {
    reload, getState,
    start(input) { ready(); demand(!state.active, '请先处理当前计时'); const now = clock(); const id = idFactory(now); demand(!state.records.some(record => record.id === id), '记录标识重复，请重试'); return save({ ...state, active: createSession(input, now, id) }) },
    pause(id) { return save({ ...state, active: pauseSession(activeFor(id), clock()) }) },
    resume(id) { return save({ ...state, active: resumeSession(activeFor(id), clock()) }) },
    advance(id) { return save({ ...state, active: advancePhase(activeFor(id), clock()) }) },
    finish(id, input) {
      ready()
      const existing = state.records.find(record => record.id === id)
      if (existing) return clone(existing)
      const record = finishSession(activeFor(id), input, clock())
      save({ ...state, active: null, records: [record, ...state.records] })
      return clone(record)
    },
    edit(id, input) { ready(); demand(state.records.some(record => record.id === id), '记录不存在'); return save({ ...state, records: state.records.map(record => record.id === id ? editRecord(record, input) : record) }) }
  }
  reload()
  return controller
}
module.exports = { MINUTE, createSession, snapshot, pauseSession, resumeSession, advancePhase, finishSession, editRecord, parseTags, summarize, validateState, createFocusController }
