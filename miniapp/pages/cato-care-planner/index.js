const { createStore, uid } = require('../../services/cato-lab')
const planner = require('../../utils/cato-care-planner')
const kindLabels = ['开始事项', '截止事项', '当天随时']
const repeatLabels = ['不重复', '每天', '每周同一天', '每月同一日（短月取月末）', '周一至周五（不识别节假日）']
const blankDraft = () => ({ title: '', kindIndex: 0, date: '', time: '', repeatIndex: 0 })

Page({
  data: { loading: true, error: '', feedback: '', showForm: false, draft: blankDraft(), kindLabels, repeatLabels, day: '', today: '', entries: [], tasks: [], total: 0 },
  onLoad() { this.store = createStore('care-planner'); this.reload() },
  onShow() { if (this.state) this.refresh(Date.now()) },
  reload() {
    try {
      const state = this.store.load('planner', planner.emptyState())
      planner.assertState(state)
      this.state = state
      this.setData({ loading: false, error: '' })
      this.refresh(Date.now())
    } catch (_) {
      this.state = null
      this.setData({ loading: false, error: '无法读取本机日程，未覆盖任何记录。请重试；若数据损坏，可在审计入口明确确认后重置本实验。', entries: [], tasks: [], total: 0 })
    }
  },
  refresh(now) {
    const today = planner.localDate(now)
    const day = !this.data.day || this.data.day === this.data.today ? today : this.data.day
    const entries = planner.occurrences(this.state, day, now).map(item => ({ ...item, kindLabel: kindLabels[planner.KINDS.indexOf(item.kind)], repeatLabel: repeatLabels[planner.REPEATS.indexOf(item.repeat)], checkSummary: item.checks.map((check, index) => `${index + 1}. ${planner.localDate(check.at)} ${planner.localTime(check.at)}`).join('；') }))
    const tasks = this.state.tasks.map(item => ({ ...item, repeatLabel: repeatLabels[planner.REPEATS.indexOf(item.repeat)], kindLabel: kindLabels[planner.KINDS.indexOf(item.kind)] }))
    this.setData({ today, day, entries, tasks, total: tasks.length })
  },
  openForm() { this.setData({ showForm: true, error: '', feedback: '' }) },
  cancelForm() { this.setData({ showForm: false, draft: blankDraft(), error: '', feedback: '已取消，本机没有新增记录。' }) },
  updateTitle(event) { this.setData({ 'draft.title': event.detail.value }) },
  selectKind(event) { this.setData({ 'draft.kindIndex': Number(event.detail.value), 'draft.time': '' }) },
  selectRepeat(event) { this.setData({ 'draft.repeatIndex': Number(event.detail.value) }) },
  selectDate(event) { this.setData({ 'draft.date': event.detail.value }) },
  selectTime(event) { this.setData({ 'draft.time': event.detail.value }) },
  saveTask() {
    const draft = this.data.draft
    if (!draft.date || (Number(draft.kindIndex) !== 2 && !draft.time)) {
      this.setData({ error: '请亲自选择日期；开始或截止事项还需选择时间。' }); return
    }
    const succeeded = this.commit({ type: 'add', task: { title: draft.title, kind: planner.KINDS[draft.kindIndex], date: draft.date, time: draft.time, repeat: planner.REPEATS[draft.repeatIndex] } }, '事项已保存到本机。')
    if (succeeded) {
      this.setData({ day: draft.date, showForm: false, draft: blankDraft() })
      this.refresh(Date.now())
    }
  },
  commit(command, feedback) {
    if (!this.state || this.busy) return false
    this.busy = true
    try {
      const now = Date.now()
      const next = planner.applyCommand(this.state, { ...command, id: uid('command') }, now)
      // Publish new UI state only after storage has accepted the complete snapshot.
      try { this.store.save('planner', next) }
      catch (_) { throw new Error('本机保存失败，本次操作未生效。原记录仍保留，请检查存储空间后重试。') }
      this.state = next
      this.setData({ error: '', feedback })
      this.refresh(now)
      return true
    } catch (error) {
      this.setData({ error: error.message || '本机操作失败，请重试。', feedback: '' })
      return false
    } finally { this.busy = false }
  },
  act(event) {
    const { action, id } = event.currentTarget.dataset
    const messages = { check: '已保存一次打卡。还可继续记录同一天的其他次数。', undo: '已撤销最近一次打卡或当天跳过。', skip: '已跳过这一天，不影响后续重复日程。', pause: '已暂停此事项；现有记录保留，不会自动补记。', resume: '已恢复此事项；暂停期间不会自动补记。' }
    if (!messages[action]) return
    this.commit({ type: action, taskId: id, date: this.data.day }, messages[action])
  },
  chooseDay(event) {
    try { planner.parseDate(event.detail.value); this.setData({ day: event.detail.value, feedback: '' }); this.refresh(Date.now()) }
    catch (_) { this.setData({ error: '日期无效，请重新选择。' }) }
  },
  moveDay(event) {
    try { this.setData({ day: planner.shiftDate(this.data.day, Number(event.currentTarget.dataset.days)), feedback: '' }); this.refresh(Date.now()) }
    catch (_) { this.setData({ error: '已到可选择的日期边界。' }) }
  },
  goToday() { this.setData({ day: planner.localDate(Date.now()), feedback: '' }); this.refresh(Date.now()) }
})
