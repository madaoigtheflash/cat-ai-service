'use strict'

// Offline domain simulation, not authentication or a cloud concurrency guarantee.
// The page receives only an actor-scoped projection; every command rechecks membership.
const ACTORS = Object.freeze([
  Object.freeze({ id: 'lin', name: '小林（模拟）' }),
  Object.freeze({ id: 'qiao', name: '阿乔（模拟）' }),
  Object.freeze({ id: 'visitor', name: '屋外访客（模拟）' })
])
const copy = value => JSON.parse(JSON.stringify(value))
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function actor(id) {
  const found = ACTORS.find(item => item.id === id)
  if (!found) fail('ACTOR', '请选择已列出的模拟身份。')
  return found
}
function text(value, label, limit, optional) {
  if (typeof value !== 'string') fail('INPUT', label + '格式不正确。')
  const result = value.trim()
  if ((!optional && !result) || result.length > limit) fail('INPUT', label + '需为' + (optional ? '0' : '1') + '–' + limit + '个字符。')
  return result
}
function validDate(value) {
  if (value === '') return ''
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('DATE', '日期请使用 YYYY-MM-DD，或留空表示不设截止。')
  const [year, month, day] = value.split('-').map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('DATE', '请输入真实有效的日期（1900–2199年）。')
  return value
}
function deadline(goalDate, taskDate) {
  if (goalDate && taskDate && taskDate > goalDate) fail('DATE', '子任务截止不能晚于目标截止；可先调整目标日期。')
}
function initialState() {
  return { schema: 1, revision: 0, nextId: 1, closed: false,
    members: [{ id: 'lin', role: 'host' }, { id: 'qiao', role: 'member' }], left: [], goals: [] }
}
function validateState(state) {
  if (!state || state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Number.isSafeInteger(state.nextId) || state.nextId < 1 || typeof state.closed !== 'boolean' ||
      !Array.isArray(state.members) || !Array.isArray(state.left) || !Array.isArray(state.goals)) fail('STORAGE', '本地实验数据无法读取，请返回审计入口重置本实验。')
  const knownMembers = ['lin', 'qiao']
  const ids = new Set()
  const invalid = () => fail('STORAGE', '本地实验数据不完整，请返回审计入口重置本实验。')
  state.members.forEach(member => {
    if (!member || !knownMembers.includes(member.id) || ids.has(member.id) || !['host', 'member'].includes(member.role)) invalid()
    ids.add(member.id)
  })
  if (new Set(state.left).size !== state.left.length || state.left.some(id => !knownMembers.includes(id) || ids.has(id)) ||
      state.members.length + state.left.length !== 2 || state.closed !== (state.members.length === 0) ||
      state.members.filter(item => item.role === 'host').length !== (state.closed ? 0 : 1)) invalid()
  const recordIds = new Set()
  function record(item, prefix) {
    if (!item || typeof item.id !== 'string' || !new RegExp('^' + prefix + '[1-9][0-9]*$').test(item.id) || recordIds.has(item.id) ||
        Number(item.id.slice(1)) >= state.nextId || !Number.isSafeInteger(item.version) || item.version < 1) invalid()
    recordIds.add(item.id)
    text(item.title, '标题', 120, false)
    validDate(item.due)
  }
  if (state.goals.length > 30) invalid()
  state.goals.forEach(goal => {
    record(goal, 'g')
    if (!knownMembers.includes(goal.createdBy) || !Array.isArray(goal.tasks) || goal.tasks.length > 40) invalid()
    goal.tasks.forEach(task => {
      record(task, 't')
      if (typeof task.done !== 'boolean' || typeof task.assignee !== 'string' || (task.assignee && !knownMembers.includes(task.assignee))) invalid()
      if ((!task.done && task.assignee && !ids.has(task.assignee)) || (task.done && !task.assignee) || (!task.done && task.evidence)) invalid()
      text(task.evidence, '完成记录', 500, true)
      deadline(goal.due, task.due)
    })
  })
  return state
}
function memberFor(state, actorId) {
  actor(actorId)
  const member = state.members.find(item => item.id === actorId)
  if (!member || state.closed) fail('FORBIDDEN', '当前身份不是小屋成员，无法读取或修改内部目标。')
  return member
}
function mayEditGoal(goal, member) { return goal.createdBy === member.id || member.role === 'host' }
function mayEditTask(goal, task, member) {
  return !task.done && (task.assignee ? task.assignee === member.id : mayEditGoal(goal, member))
}
function version(item, expected) {
  if (expected !== undefined && expected !== item.version) fail('CONFLICT', '内容已变化，请核对最新内容后重新编辑。输入尚未清空。')
}
function transition(input, actorId, command) {
  actor(actorId)
  const state = validateState(input)
  if (!command || typeof command.type !== 'string') fail('INPUT', '操作格式不正确。')
  if (command.type === 'leave' && state.left.includes(actorId)) return copy(state)
  const member = memberFor(state, actorId)
  if (command.assignee !== undefined || command.targetActor !== undefined) fail('ASSIGNMENT', '只能以当前身份自愿认领，不能代他人分配。')
  const next = copy(state)
  let changed = false
  if (command.type === 'leave') {
    next.members = next.members.filter(item => item.id !== actorId)
    next.left.push(actorId)
    if (member.role === 'host' && next.members.length) next.members[0].role = 'host'
    next.closed = next.members.length === 0
    next.goals.forEach(goal => goal.tasks.forEach(task => {
      if (task.assignee === actorId && !task.done) { task.assignee = ''; task.version += 1 }
    }))
    changed = true
  } else if (command.type === 'create-goal') {
    if (next.goals.length >= 30) fail('LIMIT', '此实验最多保存30个目标。')
    const title = text(command.title, '目标名称', 120, false)
    const due = validDate(command.due)
    next.goals.push({ id: 'g' + next.nextId++, title, due, createdBy: actorId, version: 1, tasks: [] })
    changed = true
  } else {
    const goal = next.goals.find(item => item.id === command.goalId)
    if (!goal) fail('NOT_FOUND', '目标不存在，请刷新后重试。')
    if (command.type === 'edit-goal') {
      if (!mayEditGoal(goal, member)) fail('FORBIDDEN', '只有目标创建者或现任房主可以编辑此目标。')
      version(goal, command.expectedVersion)
      const title = text(command.title, '目标名称', 120, false)
      const due = validDate(command.due)
      goal.tasks.forEach(task => deadline(due, task.due))
      changed = goal.title !== title || goal.due !== due
      if (changed) { goal.title = title; goal.due = due; goal.version += 1 }
    } else if (command.type === 'add-task') {
      if (goal.tasks.length >= 40) fail('LIMIT', '每个目标最多保存40个子任务。')
      const title = text(command.title, '子任务名称', 120, false)
      const due = validDate(command.due)
      deadline(goal.due, due)
      goal.tasks.push({ id: 't' + next.nextId++, title, due, assignee: '', done: false, evidence: '', version: 1 })
      changed = true
    } else {
      const task = goal.tasks.find(item => item.id === command.taskId)
      if (!task) fail('NOT_FOUND', '子任务不存在，请刷新后重试。')
      switch (command.type) {
        case 'edit-task': {
          if (!mayEditTask(goal, task, member)) fail('FORBIDDEN', '已完成任务需先撤销；他人认领的任务不能代为编辑。未认领任务由目标创建者或房主编辑。')
          version(task, command.expectedVersion)
          const title = text(command.title, '子任务名称', 120, false)
          const due = validDate(command.due)
          deadline(goal.due, due)
          changed = title !== task.title || due !== task.due
          if (changed) { task.title = title; task.due = due }
          break
        }
        case 'claim':
          if (task.assignee && task.assignee !== actorId) fail('CLAIM_CONFLICT', '这项任务已被另一位成员认领，不能重复认领或覆盖。')
          if (task.done) fail('DONE', '已完成任务不能重新认领。')
          if (!task.assignee) { task.assignee = actorId; changed = true }
          break
        case 'release':
          if (task.assignee && task.assignee !== actorId) fail('FORBIDDEN', '只能释放自己认领的任务。')
          if (task.done) fail('DONE', '请先撤销完成，再释放任务。')
          if (task.assignee) { task.assignee = ''; changed = true }
          break
        case 'complete': {
          if (task.assignee !== actorId) fail('FORBIDDEN', '请先由当前身份自愿认领；只有认领者能标记完成。')
          const evidence = text(command.evidence, '完成记录', 500, true)
          if (task.done && evidence !== task.evidence) fail('DONE', '任务已经完成；修改记录前请先撤销完成。')
          if (!task.done) { task.done = true; task.evidence = evidence; changed = true }
          break
        }
        case 'undo':
          if (task.assignee !== actorId) fail('FORBIDDEN', '只有认领者能撤销完成。')
          if (task.done) { task.done = false; task.evidence = ''; changed = true }
          break
        default: fail('INPUT', '不支持的操作。')
      }
      if (changed) task.version += 1
    }
  }
  if (changed) next.revision += 1
  return validateState(next)
}
function project(input, actorId) {
  const self = actor(actorId)
  const state = validateState(input)
  const member = state.members.find(item => item.id === actorId)
  if (!member || state.closed) return { simulation: true, allowed: false, closed: state.closed, self: copy(self), members: [], goals: [] }
  return { simulation: true, allowed: true, closed: false, revision: state.revision, self: { ...self, role: member.role },
    members: state.members.map(item => ({ ...actor(item.id), role: item.role })),
    goals: state.goals.map(goal => {
      const completed = goal.tasks.filter(task => task.done).length
      return { ...copy(goal), canEdit: mayEditGoal(goal, member), completed, total: goal.tasks.length,
        progress: goal.tasks.length ? Math.round(completed * 100 / goal.tasks.length) : 0,
        tasks: goal.tasks.map(task => ({ ...copy(task), assigneeName: task.assignee ? actor(task.assignee).name : '待自愿认领',
          assigneeLeft: Boolean(task.assignee && state.left.includes(task.assignee)),
          canEdit: mayEditTask(goal, task, member), canClaim: !task.assignee && !task.done,
          isMine: task.assignee === actorId })) }
    }) }
}
function createBackend(store) {
  function load() { return validateState(store.load('room', initialState())) }
  return {
    read(actorId) { return project(load(), actorId) },
    execute(actorId, command) {
      // Always load latest persisted state. Failed writes never publish a successful projection.
      const current = load()
      const next = transition(current, actorId, command)
      if (next.revision !== current.revision) store.save('room', next)
      return project(next, actorId)
    }
  }
}
module.exports = { ACTORS, initialState, validDate, validateState, transition, project, createBackend }
