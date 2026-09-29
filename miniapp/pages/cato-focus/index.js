const { createStore } = require('../../services/cato-lab')
const { createFocusController, summarize } = require('../../utils/cato-focus')

const pad = value => String(value).padStart(2, '0')
function dateText(time) { const date = new Date(time); return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) }
function timerText(ms) {
  const seconds = Math.floor(ms / 1000)
  return (seconds >= 3600 ? pad(Math.floor(seconds / 3600)) + ':' : '') + pad(Math.floor(seconds / 60) % 60) + ':' + pad(seconds % 60)
}
const minuteText = ms => (ms / 60000).toFixed(1).replace(/\.0$/, '')
const activityText = activity => activity === 'study' ? '学习充电' : '安静陪伴'

Page({
  data: {
    form: { activity: 'companion', title: '陪猫安静读一会儿', mode: 'pomodoro', workMinutes: '25', restMinutes: '5' },
    active: null, current: null, records: [], summaries: [], error: '', notice: '', loadError: '',
    reviewing: false, review: { title: '', tags: '', taskCompleted: false }, editing: null
  },
  onLoad() { this.controller = createFocusController({ store: createStore('focus') }); this.refresh() },
  onShow() {
    if (!this.controller) return
    const restored = this.controller.reload()
    if (!restored.active) this.setData({ reviewing: false })
    // The ticker only redraws. Duration always comes from persisted timestamps.
    this.stopTicker(); this.refresh(); this.ticker = setInterval(() => this.refresh(), 1000)
  },
  onHide() { this.stopTicker() },
  onUnload() { this.stopTicker() },
  stopTicker() { if (this.ticker) { clearInterval(this.ticker); this.ticker = null } },
  refresh() {
    if (!this.controller) return
    const state = this.controller.getState()
    const totals = summarize(state.records, Date.now())
    const current = state.current
    const active = state.active
    const actionLabel = active ? (current.reached ? (active.phase === 'work' ? '开始休息' : '再专注一轮') : active.status === 'running' ? '暂停计时' : '继续计时') : '开始这段时间'
    this.setData({ active, current, loadError: state.loadError, actionLabel,
      timer: current ? timerText(current.remainingMs === null ? current.phaseElapsedMs : current.remainingMs) : '',
      workTotal: current ? minuteText(current.workMs) : '0', restTotal: current ? minuteText(current.restMs) : '0',
      summaries: [{ label: '今天', ...totals.day }, { label: '本周', ...totals.week }, { label: '本月', ...totals.month }].map(item => ({ ...item, minutes: minuteText(item.workMs) })),
      records: state.records.map(record => ({ ...record, date: dateText(record.endedAt), minutes: minuteText(record.workMs), activityLabel: activityText(record.activity), tagsText: record.tags.join(' · ') }))
    })
  },
  attempt(action) {
    try { action(); this.setData({ error: '' }); this.refresh(); return true }
    catch (error) { this.setData({ error: '未保存更改：' + error.message + '。原记录和当前计时仍保留，请检查后重试。' }); this.refresh(); return false }
  },
  retryLoad() { this.controller.reload(); this.refresh() },
  changeForm(event) { const key = event.currentTarget.dataset.field; this.setData({ ['form.' + key]: event.detail.value }) },
  chooseActivity(event) {
    const activity = event.currentTarget.dataset.value
    this.setData({ 'form.activity': activity, 'form.title': activity === 'study' ? '学习一点猫咪知识' : '陪猫安静读一会儿' })
  },
  chooseMode(event) { this.setData({ 'form.mode': event.currentTarget.dataset.value }) },
  primaryAction() {
    const state = this.controller.getState()
    if (!state.active) { this.attempt(() => this.controller.start(this.data.form)); return }
    this.attempt(() => state.current.reached ? this.controller.advance(state.active.id) : state.active.status === 'running' ? this.controller.pause(state.active.id) : this.controller.resume(state.active.id))
  },
  reviewFinish() {
    const active = this.controller.getState().active
    if (!active) return
    if (this.attempt(() => this.controller.pause(active.id))) this.setData({ reviewing: true, reviewId: active.id, review: { title: active.title, tags: '', taskCompleted: false }, notice: '' })
  },
  changeReview(event) { this.setData({ ['review.' + event.currentTarget.dataset.field]: event.detail.value }) },
  changeReviewCompletion(event) { this.setData({ 'review.taskCompleted': event.detail.value }) },
  cancelFinish() { this.setData({ reviewing: false, notice: '已取消结束核对，计时保持暂停；可继续计时。', error: '' }) },
  confirmFinish() {
    if (this.attempt(() => this.controller.finish(this.data.reviewId, this.data.review))) this.setData({ reviewing: false, notice: '本机记录已保存。专注时长与任务完成状态分开记录。' })
  },
  openEdit(event) {
    const record = this.controller.getState().records.find(item => item.id === event.currentTarget.dataset.id)
    if (!record) return
    this.setData({ editing: { id: record.id, title: record.title, tags: record.tags.join('，'), minutes: String(record.workMs / 60000), date: dateText(record.endedAt), taskCompleted: record.taskCompleted, endedAt: record.endedAt }, error: '' }, () => wx.pageScrollTo({ selector: '.edit-card', duration: 0 }))
  },
  changeEdit(event) { this.setData({ ['editing.' + event.currentTarget.dataset.field]: event.detail.value }) },
  changeEditCompletion(event) { this.setData({ 'editing.taskCompleted': event.detail.value }) },
  cancelEdit() { this.setData({ editing: null, error: '' }) },
  saveEdit() {
    const input = this.data.editing
    const parts = input.date.split('-').map(Number)
    const original = new Date(input.endedAt)
    const endedAt = new Date(parts[0], parts[1] - 1, parts[2], original.getHours(), original.getMinutes(), original.getSeconds(), original.getMilliseconds()).getTime()
    if (this.attempt(() => this.controller.edit(input.id, { ...input, endedAt }))) this.setData({ editing: null, notice: '记录已修改，今天／本周／本月统计已更新。' })
  }
})
