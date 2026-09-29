'use strict'

const KINDS = ['start', 'ddl', 'anytime']
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'workday']
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const copy = value => JSON.parse(JSON.stringify(value))
const pad = value => String(value).padStart(2, '0')
function fail(message) { throw new Error(message) }
function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) }
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('请选择有效日期。')
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year < 1900 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail('日期不存在，请重新选择。')
  return { year, month, day, weekday: date.getUTCDay(), serial: date.getTime() / 86400000 }
}
function validTime(value) { return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) }
function validNow(now) { if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) fail('当前时间无效。') }
function localDate(now) {
  validNow(now)
  const date = new Date(now)
  const result = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  parseDate(result)
  return result
}
function localTime(now) { validNow(now); const date = new Date(now); return `${pad(date.getHours())}:${pad(date.getMinutes())}` }
function shiftDate(value, days) {
  const parsed = parseDate(value)
  if (!Number.isInteger(days)) fail('日期步长无效。')
  const date = new Date((parsed.serial + days) * 86400000)
  const result = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  parseDate(result)
  return result
}
function validateTask(task) {
  if (!task || !validId(task.id) || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 80) fail('事项数据无效。')
  parseDate(task.date)
  if (!KINDS.includes(task.kind) || !REPEATS.includes(task.repeat) || typeof task.paused !== 'boolean') fail('事项规则无效。')
  if (task.kind === 'anytime' ? task.time !== '' : !validTime(task.time)) fail('请选择有效时间。')
  validNow(task.createdAt)
}
function occursOn(task, day) {
  validateTask(task)
  const anchor = parseDate(task.date)
  const current = parseDate(day)
  if (day < task.date) return false
  switch (task.repeat) {
    case 'none': return day === task.date
    case 'daily': return true
    case 'weekly': return current.weekday === anchor.weekday
    case 'workday': return current.weekday >= 1 && current.weekday <= 5
    case 'monthly': return current.day === Math.min(anchor.day, new Date(Date.UTC(current.year, current.month, 0)).getUTCDate())
    default: return false
  }
}
function emptyState() { return { version: 1, tasks: [], logs: {}, commands: [] } }
function assertState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.commands) || !state.logs || typeof state.logs !== 'object' || Array.isArray(state.logs)) fail('本机日程数据无法读取，请勿覆盖；可重试或在审计入口手动重置。')
  const ids = new Set()
  state.tasks.forEach(task => { validateTask(task); if (ids.has(task.id)) fail('事项标识重复。'); ids.add(task.id) })
  if (state.commands.some(id => !validId(id)) || new Set(state.commands).size !== state.commands.length) fail('操作记录无效。')
  Object.keys(state.logs).forEach(key => {
    const split = key.lastIndexOf('@')
    const task = state.tasks.find(item => item.id === key.slice(0, split))
    if (!task || !occursOn(task, key.slice(split + 1))) fail('打卡日期无效。')
    const log = state.logs[key]
    if (!log || !Array.isArray(log.checks) || typeof log.skipped !== 'boolean' || (log.skipped && log.checks.length)) fail('打卡记录无效。')
    const checkIds = new Set()
    log.checks.forEach(check => {
      if (!check || !validId(check.id) || checkIds.has(check.id)) fail('打卡标识无效。')
      validNow(check.at); checkIds.add(check.id)
    })
  })
  return state
}
function applyCommand(state, command, now) {
  assertState(state); validNow(now)
  if (!command || !validId(command.id)) fail('操作标识无效。')
  // A retried command returns the existing state, including retried undo/skip.
  if (state.commands.includes(command.id)) return state
  const next = copy(state)
  if (command.type === 'add') {
    const fields = command.task || {}
    if (next.tasks.length >= 200) fail('本地实验最多保存 200 个事项。')
    const task = { id: command.id, title: typeof fields.title === 'string' ? fields.title.trim() : '', kind: fields.kind, date: fields.date, time: fields.kind === 'anytime' ? '' : fields.time, repeat: fields.repeat, paused: false, createdAt: now }
    validateTask(task)
    next.tasks.push(task)
  } else {
    const task = next.tasks.find(item => item.id === command.taskId)
    if (!task) fail('未找到这条事项。')
    if (command.type === 'pause' || command.type === 'resume') {
      task.paused = command.type === 'pause'
    } else {
      const day = command.date
      parseDate(day)
      if (!occursOn(task, day)) fail('这天不在该事项的日程中。')
      if (day > localDate(now)) fail('不能提前记录未来日期；请在当天回来。')
      const key = `${task.id}@${day}`
      const log = own(next.logs, key) ? next.logs[key] : { checks: [], skipped: false }
      if (command.type === 'check') {
        if (task.paused) fail('事项已暂停，请先恢复。')
        if (log.skipped) fail('这天已跳过，请先撤销跳过。')
        log.checks.push({ id: command.id, at: now })
      } else if (command.type === 'skip') {
        if (task.paused) fail('事项已暂停，请先恢复。')
        if (log.checks.length) fail('已有打卡，请先逐次撤销再跳过。')
        log.skipped = true
      } else if (command.type === 'undo') {
        if (log.skipped) log.skipped = false
        else if (log.checks.length) log.checks.pop()
        else fail('这天没有可撤销的记录。')
      } else fail('不支持这项操作。')
      next.logs[key] = log
    }
  }
  next.commands.push(command.id)
  return next
}
function occurrences(state, day, now) {
  assertState(state); parseDate(day); validNow(now)
  const today = localDate(now)
  return state.tasks.filter(task => occursOn(task, day)).map(task => {
    const log = state.logs[`${task.id}@${day}`] || { checks: [], skipped: false }
    const isFuture = day > today
    const reached = day < today || (day === today && (task.kind === 'anytime' || localTime(now) >= task.time))
    let status = task.kind === 'anytime' ? '当天随时' : task.kind === 'start' ? (reached ? '已到开始时间' : '等待开始时间') : (reached ? '已到截止时间' : '截止前')
    if (isFuture) status = '未来日程'
    if (log.checks.length) status = `已打卡 ${log.checks.length} 次`
    if (log.skipped) status = '当天已跳过'
    if (task.paused) status += ' · 事项暂停'
    return { ...task, occurrenceDate: day, count: log.checks.length, skipped: log.skipped, status, canCheck: !isFuture && !task.paused && !log.skipped, canSkip: !isFuture && !task.paused && !log.skipped && !log.checks.length, canUndo: !isFuture && (log.skipped || log.checks.length > 0), checks: copy(log.checks) }
  }).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.createdAt - b.createdAt)
}

module.exports = { KINDS, REPEATS, parseDate, localDate, localTime, shiftDate, occursOn, emptyState, assertState, applyCommand, occurrences }
