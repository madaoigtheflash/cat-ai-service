const { createStore } = require('../../services/cato-lab')
const { createState, transition, project } = require('../../utils/cato-sync-contract')

Page({
  data: { clients: [], serverRecords: [], revision: 0, receiptCount: 0, error: '', retryAvailable: false,
    drafts: { a: '', b: '' }, editing: null, permissionResult: '', failNextSave: false, ready: false },
  onLoad() {
    this._store = createStore('sync-contract')
    try {
      this._state = this._store.load('state', createState())
      if (this._state.schema !== 1) throw Error('schema')
      this.setData({ ...project(this._state), ready: true })
    } catch (_) { this.setData({ error: '本地实验记录读取失败。未覆盖原记录；可返回审计入口重置本实验。', ready: false }) }
  },
  commit(action, afterSave) {
    let next
    try { next = transition(this._state, action) }
    catch (error) { this.setData({ error: error.message }); return false }
    try {
      if (this.data.failNextSave) { this.setData({ failNextSave: false }); throw Error('simulated storage failure') }
      this._store.save('state', next)
    } catch (_) {
      this._retry = { action, afterSave }
      this.setData({ error: '本次写入失败，页面及已保存状态均未推进。请重试；同一命令不会重复应用。', retryAvailable: true })
      return false
    }
    this._state = next
    this._retry = null
    this.setData({ ...project(next), error: '', retryAvailable: false })
    if (afterSave) afterSave()
    return true
  },
  retrySave() { if (this._retry) this.commit(this._retry.action, this._retry.afterSave) },
  armFailure() { this.setData({ failNextSave: !this.data.failNextSave }) },
  setDraft(event) { this.setData({ ['drafts.' + event.currentTarget.dataset.device]: event.detail.value }) },
  createTask(event) {
    const deviceId = event.currentTarget.dataset.device
    this.commit({ type: 'create', deviceId, title: this.data.drafts[deviceId] }, () => this.setData({ ['drafts.' + deviceId]: '' }))
  },
  toggleOnline(event) { this.commit({ type: 'toggleOnline', deviceId: event.currentTarget.dataset.device }) },
  sync(event) { this.commit({ type: event.currentTarget.dataset.loseack === 'yes' ? 'reconnectLostAck' : 'sync', deviceId: event.currentTarget.dataset.device }) },
  editTask(event) {
    const { device, record } = event.currentTarget.dataset
    const client = this._state.clients.find(item => item.id === device)
    this.setData({ editing: { deviceId: device, recordId: record, title: client.records[record].title }, error: '' })
  },
  editTitle(event) { this.setData({ 'editing.title': event.detail.value }) },
  cancelEdit() { this.setData({ editing: null }) },
  saveEdit() { if (this.data.editing) this.commit({ type: 'edit', ...this.data.editing }, () => this.setData({ editing: null })) },
  completeTask(event) {
    const { device, record } = event.currentTarget.dataset
    const current = this._state.clients.find(item => item.id === device).records[record]
    this.commit({ type: 'complete', deviceId: device, recordId: record, completed: !current.completed })
  },
  deleteTask(event) {
    const { device, record } = event.currentTarget.dataset
    wx.showModal({ title: '删除此模拟事项？', content: '离线时先进入本地队列。权威端应用后保留墓碑，旧命令不能恢复；可另建新事项。', success: result => {
      if (result.confirm) this.commit({ type: 'delete', deviceId: device, recordId: record })
    } })
  },
  discardQueue(event) {
    const deviceId = event.currentTarget.dataset.device
    wx.showModal({ title: '放弃此设备的未确认意图？', content: '会清除此设备队列并读取模拟权威端。已应用但回执丢失的命令不会被撤销。', success: result => {
      if (result.confirm) this.commit({ type: 'discardQueue', deviceId })
    } })
  },
  resolve(event) {
    const { device, choice } = event.currentTarget.dataset
    if (choice === 'remote') { this.commit({ type: 'resolve', deviceId: device, choice }); return }
    wx.showModal({ title: '用本地意图重新提交？', content: '将此事项的待处理命令合并为一个新命令，按权威端最新版本提交；会覆盖其名称和完成状态。', success: result => {
      if (result.confirm) this.commit({ type: 'resolve', deviceId: device, choice })
    } })
  },
  permissionProbe() { this.commit({ type: 'permissionProbe' }) }
})
