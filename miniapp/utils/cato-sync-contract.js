'use strict'

// Deliberately pure, in-process protocol model. This is not a network adapter.
const OWNER = 'demo-user'
const TYPES = ['create', 'edit', 'complete', 'delete', 'replace']
const clone = value => JSON.parse(JSON.stringify(value))
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw Error('事项名称须为 1–80 个字符')
  return value.trim()
}
function createState() {
  return {
    schema: 1, nextId: 1,
    server: { ownerId: OWNER, revision: 0, records: {}, receipts: {} },
    clients: ['a', 'b'].map(id => ({
      id, label: '设备 ' + id.toUpperCase(), userId: OWNER, online: true,
      records: {}, queue: [], conflict: null, lastConflict: null,
      lastMessage: '尚未发送；本机模拟身份 demo-user'
    })), permissionResult: ''
  }
}
function readServer(server, principal) {
  if (principal !== server.ownerId) return { code: 'DENIED', records: {} }
  return { code: 'OK', records: clone(server.records) }
}
function fingerprint(command) {
  return JSON.stringify([command.actorId, command.deviceId, command.recordId, command.type,
    command.expectedVersion, command.payload && command.payload.title, command.payload && command.payload.completed])
}
function validCommand(command) {
  if (!command || !/^cmd-[ab]-[1-9][0-9]*$/.test(command.id || '') ||
      !/^task-[1-9][0-9]*$/.test(command.recordId || '') || !['a', 'b'].includes(command.deviceId) ||
      !TYPES.includes(command.type) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0 ||
      !command.payload || typeof command.payload !== 'object') throw Error('命令格式无效')
  if (['create', 'edit', 'replace'].includes(command.type)) title(command.payload.title)
  if (['complete', 'create', 'replace'].includes(command.type) && typeof command.payload.completed !== 'boolean') throw Error('完成状态无效')
  if (command.type === 'create' && command.expectedVersion !== 0) throw Error('新建版本须为 0')
}
function applyCommand(server, principal, command) {
  // Authorize before receipts or record lookup: a reused ID cannot leak another user's data.
  if (principal !== server.ownerId || !command || command.actorId !== principal) {
    return { server, result: { code: 'DENIED', message: '模拟权限拒绝：不能访问其他用户的事项。' } }
  }
  try { validCommand(command) } catch (error) { return { server, result: { code: 'INVALID', message: error.message } } }
  const signature = fingerprint(command)
  if (own(server.receipts, command.id)) {
    const receipt = server.receipts[command.id]
    return receipt.signature === signature
      ? { server, result: { ...clone(receipt.result), duplicate: true } }
      : { server, result: { code: 'ID_REUSE', message: '同一命令 ID 不得更换内容。' } }
  }
  const current = server.records[command.recordId]
  if (current && current.ownerId !== principal) return { server, result: { code: 'DENIED', message: '模拟权限拒绝。' } }
  if (current && current.deleted) return { server, result: { code: 'DELETED', record: clone(current), message: '权威端已保留删除墓碑；旧命令不能恢复此 ID。' } }
  if ((current ? current.version : 0) !== command.expectedVersion || (command.type === 'create' && current)) {
    return { server, result: { code: 'CONFLICT', record: current ? clone(current) : null, message: '版本已变化，等待明确选择。' } }
  }
  if (!current && command.type !== 'create') return { server, result: { code: 'MISSING', record: null, message: '事项不存在，不能直接修改。' } }
  const next = clone(server)
  const record = current ? clone(current) : { id: command.recordId, ownerId: principal, version: 0, title: '', completed: false, deleted: false }
  if (['create', 'edit', 'replace'].includes(command.type)) record.title = title(command.payload.title)
  if (['create', 'complete', 'replace'].includes(command.type)) record.completed = command.payload.completed
  if (command.type === 'delete') { record.deleted = true; record.title = ''; record.completed = false }
  record.version += 1
  next.records[record.id] = record
  next.revision += 1
  const result = { code: 'APPLIED', record: clone(record), duplicate: false }
  next.receipts[command.id] = { signature, result: clone(result) }
  return { server: next, result }
}
function clientFor(state, deviceId) {
  const client = state.clients.find(item => item.id === deviceId)
  if (!client) throw Error('请选择设备 A 或 B')
  if (client.userId !== state.server.ownerId) throw Error('模拟权限拒绝')
  return client
}
function allocate(state, prefix) { return prefix + state.nextId++ }
function drain(state, client, loseAck) {
  if (!client.online) throw Error('设备离线，请先重新连接')
  let applied = 0
  let duplicates = 0
  while (client.queue.length) {
    const command = client.queue[0]
    const outcome = applyCommand(state.server, client.userId, command)
    state.server = outcome.server
    const result = outcome.result
    if (result.code !== 'APPLIED') {
      client.conflict = { commandId: command.id, recordId: command.recordId, code: result.code,
        local: clone(client.records[command.recordId] || null), remote: clone(result.record || null), message: result.message }
      client.lastConflict = { ...clone(client.conflict), resolution: '待选择' }
      client.lastMessage = result.message
      return
    }
    if (loseAck) {
      client.lastMessage = '已模拟一次回执丢失：权威端已应用，队列保留同一 ID。请点“发送 / 拉取”重试。'
      return
    }
    if (result.duplicate) duplicates += 1
    else applied += 1
    client.queue.shift()
  }
  client.records = readServer(state.server, client.userId).records
  client.conflict = null
  client.lastMessage = '模拟传输结束：应用 ' + applied + ' 条，去重 ' + duplicates + ' 条；已拉取权威端。'
}
function enqueue(state, client, type, recordId, payload) {
  if (client.conflict) throw Error('请先明确解决此设备的冲突')
  if (client.queue.length >= 100) throw Error('离线队列最多 100 条，请先发送或放弃')
  const current = client.records[recordId]
  if (type !== 'create' && (!current || current.deleted)) throw Error('不能修改已删除或不存在的事项')
  if (type === 'create' && Object.keys(client.records).length >= 40) throw Error('实验最多保留 40 个事项及墓碑，请在审计入口重置')
  const command = { id: allocate(state, 'cmd-' + client.id + '-'), actorId: client.userId, deviceId: client.id,
    recordId, expectedVersion: current ? current.version : 0, type, payload }
  validCommand(command)
  const local = current ? clone(current) : { id: recordId, ownerId: client.userId, version: 0, title: '', completed: false, deleted: false }
  if (['create', 'edit', 'replace'].includes(type)) local.title = title(payload.title)
  if (['create', 'complete', 'replace'].includes(type)) local.completed = payload.completed
  if (type === 'delete') { local.deleted = true; local.title = ''; local.completed = false }
  local.version += 1
  client.records[recordId] = local
  client.queue.push(command)
  client.lastMessage = '已保存本地意图，等待模拟发送。'
  if (client.online) drain(state, client, false)
}
function transition(previous, action) {
  if (!previous || previous.schema !== 1 || !action) throw Error('实验状态无效，请从审计入口重置')
  const state = clone(previous)
  if (action.type === 'permissionProbe') {
    const result = readServer(state.server, 'demo-other-user')
    state.permissionResult = result.code === 'DENIED' ? '模拟身份 demo-other-user 的读取已拒绝；返回 0 条记录。' : '权限检查异常'
    return state
  }
  const client = clientFor(state, action.deviceId)
  if (action.type === 'create') enqueue(state, client, 'create', allocate(state, 'task-'), { title: title(action.title), completed: false })
  else if (action.type === 'edit') enqueue(state, client, 'edit', action.recordId, { title: title(action.title) })
  else if (action.type === 'complete') {
    if (typeof action.completed !== 'boolean') throw Error('完成状态无效')
    enqueue(state, client, 'complete', action.recordId, { completed: action.completed })
  } else if (action.type === 'delete') enqueue(state, client, 'delete', action.recordId, {})
  else if (action.type === 'toggleOnline') {
    client.online = !client.online
    client.lastMessage = client.online ? '已模拟重连。' : '已切为模拟离线；后续操作只进入本地队列。'
    if (client.online) drain(state, client, false)
  } else if (action.type === 'reconnectLostAck') {
    client.online = true
    drain(state, client, true)
  } else if (action.type === 'sync') drain(state, client, false)
  else if (action.type === 'discardQueue') {
    client.records = readServer(state.server, client.userId).records
    client.queue = []
    client.conflict = null
    if (client.lastConflict && client.lastConflict.resolution === '待选择') client.lastConflict.resolution = '已放弃本地队列'
    client.lastMessage = '已放弃此设备全部未确认意图，并读取模拟权威端快照；不撤销已应用的命令。'
  } else if (action.type === 'resolve') {
    if (!client.conflict) throw Error('当前没有待解决冲突')
    if (!['remote', 'local'].includes(action.choice)) throw Error('请选择保留权威端或重新提交本地')
    const recordId = client.conflict.recordId
    const remote = state.server.records[recordId] || null
    const local = client.records[recordId] || null
    if (action.choice === 'local' && remote && remote.deleted) throw Error('删除墓碑不可恢复；请保留权威端，另建新事项')
    if (action.choice === 'local' && !local) throw Error('没有可提交的本地意图')
    client.queue = client.queue.filter(command => command.recordId !== recordId)
    client.conflict = null
    if (remote) client.records[recordId] = clone(remote)
    else delete client.records[recordId]
    client.lastConflict.resolution = action.choice === 'remote' ? '已明确保留权威端' : '已明确按最新版本重新提交本地'
    client.lastMessage = client.lastConflict.resolution
    if (action.choice === 'local') {
      if (local.deleted && !remote) throw Error('权威端已不存在此事项，请保留权威端')
      enqueue(state, client, local.deleted ? 'delete' : remote ? 'replace' : 'create', recordId,
        local.deleted ? {} : { title: local.title, completed: local.completed })
    }
  } else throw Error('未知实验操作')
  return state
}
function summarize(record) { return !record ? '无记录' : record.deleted ? '删除墓碑 · v' + record.version : record.title + ' · ' + (record.completed ? '已完成' : '未完成') + ' · v' + record.version }
function project(state) {
  const labels = { create: '新建', edit: '改名', complete: '完成状态', delete: '删除', replace: '明确重新提交' }
  const records = map => Object.keys(map).map(key => ({ ...map[key], status: map[key].deleted ? '已删除 · 墓碑' : map[key].completed ? '已完成' : '未完成' }))
  return {
    revision: state.server.revision,
    receiptCount: Object.keys(state.server.receipts).length,
    serverRecords: records(state.server.records), permissionResult: state.permissionResult,
    clients: state.clients.map(client => ({
      ...clone(client), records: records(client.records).map(record => ({ ...record,
        serverVersion: state.server.records[record.id] ? state.server.records[record.id].version : 0,
        pending: client.queue.filter(command => command.recordId === record.id).length })),
      queue: client.queue.map(command => ({ ...command, label: labels[command.type] })),
      canResubmit: !!client.conflict && !(state.server.records[client.conflict.recordId] || {}).deleted,
      conflictLocal: client.lastConflict ? summarize(client.lastConflict.local) : '',
      conflictRemote: client.lastConflict ? summarize(client.lastConflict.remote) : ''
    }))
  }
}
module.exports = { OWNER, createState, readServer, applyCommand, transition, project }
