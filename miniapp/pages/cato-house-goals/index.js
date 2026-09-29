const { createStore } = require('../../services/cato-lab')
const { ACTORS, createBackend } = require('../../utils/cato-house-goals')

const blankEditor = () => ({ mode: '', heading: '', goalId: '', goalTitle: '', taskId: '', title: '', due: '', evidence: '', expectedVersion: null })
const emptyRoom = () => ({ allowed: false, closed: false, goals: [], members: [] })

Page({
  data: {
    actors: ACTORS, actorId: 'lin', room: emptyRoom(), editor: blankEditor(),
    error: '', feedback: '', loading: true, busy: false, failNextSave: false
  },
  onShow() {
    if (!this._backend) {
      const store = createStore('house-goals')
      this._backend = createBackend({
        load: (key, fallback) => store.load(key, fallback),
        save: (key, value) => {
          if (this.data.failNextSave) {
            this.setData({ failNextSave: false })
            throw new Error('模拟存储失败')
          }
          return store.save(key, value)
        }
      })
    }
    this.refresh()
  },
  refresh() {
    try {
      const room = this._backend.read(this.data.actorId)
      this.setData({ room, loading: false, error: '', ...(room.allowed ? {} : { editor: blankEditor() }) })
    } catch (error) {
      this.setData({ room: emptyRoom(), editor: blankEditor(), loading: false,
        error: error.code ? error.message : '本机实验数据读取失败，未展示内部目标。请重试读取；不会自动覆盖原记录。' })
    }
  },
  switchActor(event) {
    const actorId = event.currentTarget.dataset.id
    if (!ACTORS.some(item => item.id === actorId) || actorId === this.data.actorId || this.data.busy) return
    // Clear private form/evidence before any asynchronous display of another identity.
    this.setData({ actorId, room: emptyRoom(), editor: blankEditor(), error: '', feedback: '', loading: true, failNextSave: false })
    this.refresh()
  },
  findGoal(goalId) { return this.data.room.goals.find(goal => goal.id === goalId) },
  openEditor(event) {
    if (!this.data.room.allowed || this.data.busy) return
    const { mode, goalId, taskId } = event.currentTarget.dataset
    const goal = goalId ? this.findGoal(goalId) : null
    const task = goal && goal.tasks.find(item => item.id === taskId)
    const headings = { 'create-goal': '新建一个共同目标', 'edit-goal': '编辑目标', 'add-task': '添加自定子任务', 'edit-task': '编辑子任务', complete: '确认我已完成' }
    if (!headings[mode] || (mode !== 'create-goal' && !goal) || (['edit-task', 'complete'].includes(mode) && !task)) return
    const source = mode === 'edit-goal' ? goal : mode === 'edit-task' ? task : null
    const editor = { ...blankEditor(), mode, heading: headings[mode], goalId: goalId || '', goalTitle: goal ? goal.title : '', taskId: taskId || '',
      title: source ? source.title : mode === 'complete' ? task.title : '', due: source ? source.due : '', expectedVersion: source ? source.version : null }
    const apply = () => {
      this.setData({ editor, error: '', feedback: '' })
      if (wx.pageScrollTo) wx.pageScrollTo({ selector: '#goal-editor', duration: 0 })
    }
    if (this.data.editor.mode) {
      wx.showModal({ title: '切换编辑内容？', content: '当前尚未保存的输入会被放弃；取消可继续编辑。', success: result => { if (result.confirm) apply() } })
    } else apply()
  },
  inputField(event) {
    const field = event.currentTarget.dataset.field
    if (!['title', 'due', 'evidence'].includes(field)) return
    this.setData({ ['editor.' + field]: event.detail.value })
  },
  cancelEditor() {
    wx.showModal({ title: '放弃这次编辑？', content: '尚未保存的输入会清空，已经保存的目标不受影响。',
      success: result => { if (result.confirm) this.setData({ editor: blankEditor(), error: '', feedback: '已取消编辑，没有修改目标。' }) } })
  },
  saveEditor() {
    const editor = this.data.editor
    if (!editor.mode) return
    const command = { type: editor.mode, goalId: editor.goalId, taskId: editor.taskId }
    if (editor.mode === 'complete') command.evidence = editor.evidence
    else { command.title = editor.title; command.due = editor.due }
    if (editor.expectedVersion !== null) command.expectedVersion = editor.expectedVersion
    this.execute(command, editor.mode === 'complete' ? '完成已保存到本机，可随时撤销。' : '已保存到本机实验空间；尚未发送任何通知。', true)
  },
  execute(command, message, clearEditor) {
    if (this.data.busy) return
    this.setData({ busy: true, error: '', feedback: '' })
    try {
      const room = this._backend.execute(this.data.actorId, command)
      this.setData({ room, feedback: message, ...((clearEditor || !room.allowed) ? { editor: blankEditor() } : {}) })
    } catch (error) {
      if (error.code === 'FORBIDDEN') {
        // A membership change must also revoke any previously rendered internal content.
        try {
          const room = this._backend.read(this.data.actorId)
          this.setData({ room, ...(room.allowed ? {} : { editor: blankEditor() }) })
        } catch (_) { this.setData({ room: emptyRoom(), editor: blankEditor() }) }
      }
      this.setData({ error: error.code ? error.message : '本机保存失败，未显示为保存成功。输入仍保留，请重试；若持续失败，请先复制自己的输入。' })
      return false
    } finally { this.setData({ busy: false }) }
    return true
  },
  taskAction(event) {
    const { action, goalId, taskId } = event.currentTarget.dataset
    if (!['claim', 'release', 'undo'].includes(action)) return
    const command = { type: action, goalId, taskId }
    const messages = { claim: '当前模拟身份已自愿认领。', release: '已释放，其他成员可以自愿认领。', undo: '已撤销完成并清空旧完成记录，仍由你认领。' }
    if (action === 'undo') {
      wx.showModal({ title: '撤销完成？', content: '任务会回到未完成，并清空此任务的完成记录；不会通知其他人。',
        success: result => { if (result.confirm) this.execute(command, messages[action], false) } })
    } else this.execute(command, messages[action], false)
  },
  leaveRoom() {
    const last = this.data.room.members.length === 1
    wx.showModal({ title: '退出这个模拟小屋？',
      content: last ? '你是最后一位成员。退出后小屋关闭，所有身份失去内部访问权。仅能在审计入口重置实验重新开始。' : '退出后立即失去目标和记录访问权。未完成的认领会释放；已完成记录留在小屋。房主会交接给剩余成员。',
      success: result => {
        if (result.confirm) this.execute({ type: 'leave' }, '已退出模拟小屋，内部目标和表单已从页面清除。', true)
      }
    })
  },
  simulateFailure() {
    this.setData({ failNextSave: !this.data.failNextSave, error: '', feedback: this.data.failNextSave ? '已取消保存失败模拟。' : '下次发生数据变更的保存将模拟失败一次；输入会保留。' })
  }
})
