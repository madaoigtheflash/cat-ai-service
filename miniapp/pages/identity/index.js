const identity = require('../../services/identity')

function stateLabel(state) {
  return {
    PROCESSING: '正在整理候选',
    AWAITING_CONFIRMATION: '等待你的确认',
    MANUAL_ONLY: '人工确认模式',
    COMPLETED: '已完成确认',
    NEEDS_MORE_EVIDENCE: '需要更多照片',
    UNDONE: '确认已撤销',
    UNRESOLVED: '暂时无法判断',
    FAILED: '候选生成失败'
  }[state] || '正在准备'
}

function modeLabel(mode, simulation) {
  if (simulation) return '模拟验证结果'
  if (mode === 'model_candidate' || mode === 'MODEL_ASSISTED') return '视觉模型候选'
  if (mode === 'manual_only' || mode === 'MANUAL_ONLY') return '人工确认'
  return '候选辅助'
}

function normalizeTask(value) {
  const task = value && (value.task || value)
  const candidates = (task.candidates || []).map((item, index) => ({
    catId: item.catId,
    displayName: item.displayName || '未命名猫咪',
    rank: item.rank || index + 1,
    evidenceLabel: item.evidenceLabel || '仅作为外观候选，仍需人工核对'
  }))
  const availableCats = task.availableCats || []
  return Object.assign({}, task, {
    candidates,
    availableCats,
    stateLabel: stateLabel(task.state),
    modeLabel: modeLabel(task.mode, task.simulation),
    canDecide: ['AWAITING_CONFIRMATION', 'MANUAL_ONLY', 'UNRESOLVED'].includes(task.state),
    isComplete: task.state === 'COMPLETED',
    needsMoreEvidence: task.state === 'NEEDS_MORE_EVIDENCE',
    isFinal: ['COMPLETED', 'NEEDS_MORE_EVIDENCE'].includes(task.state)
  })
}

Page({
  data: {
    loading: true,
    actionLoading: '',
    errorMessage: '',
    feedbackMessage: '',
    communityId: '',
    sightingId: '',
    task: null,
    knownCatNames: [],
    knownCatIndex: 0,
    newCatName: ''
  },

  onLoad(options) {
    const communityId = decodeURIComponent(options.communityId || '')
    const sightingId = decodeURIComponent(options.sightingId || '')
    this.setData({ communityId, sightingId })
    if (!communityId || !sightingId) {
      this.setData({ loading: false, errorMessage: '缺少目击记录，请从“云端猫站”重新进入。' })
      return
    }
    this.startMatch()
  },

  onPullDownRefresh() {
    this.refreshTask().finally(() => wx.stopPullDownRefresh())
  },

  applyTask(payload) {
    const task = normalizeTask(payload)
    this.setData({
      task,
      knownCatNames: (task.availableCats || []).map(item => item.displayName || '未命名猫咪'),
      knownCatIndex: Math.min(this.data.knownCatIndex, Math.max((task.availableCats || []).length - 1, 0)),
      loading: false
    })
  },

  async startMatch() {
    this.setData({ loading: true, errorMessage: '', feedbackMessage: '' })
    try {
      const result = await identity.startMatch(this.data.communityId, this.data.sightingId)
      this.applyTask(result)
    } catch (error) {
      this.setData({ loading: false, errorMessage: error.message || '同猫候选暂时不可用' })
    }
  },

  async refreshTask() {
    const task = this.data.task
    if (!task || !task.taskId) return this.startMatch()
    this.setData({ errorMessage: '' })
    try {
      const result = task.state === 'PROCESSING'
        ? await identity.startMatch(this.data.communityId, this.data.sightingId)
        : await identity.getTask(task.taskId)
      this.applyTask(result)
    } catch (error) {
      this.setData({ errorMessage: error.message || '刷新候选失败' })
    }
  },

  async restartMatch() {
    const previousTaskId = this.data.task && this.data.task.taskId
    this.setData({ loading: true, errorMessage: '', feedbackMessage: '' })
    try {
      const result = await identity.restartMatch(this.data.communityId, this.data.sightingId, previousTaskId)
      this.applyTask(result)
    } catch (error) {
      this.setData({ loading: false, errorMessage: error.message || '重新生成候选失败' })
    }
  },

  onKnownCatChange(event) {
    this.setData({ knownCatIndex: Number(event.detail.value) || 0 })
  },

  onNewCatName(event) {
    this.setData({ newCatName: event.detail.value })
  },

  confirmCandidate(event) {
    const catId = event.currentTarget.dataset.id
    const candidate = (this.data.task.candidates || []).find(item => item.catId === catId)
    if (!candidate) return
    this.askDecision(
      `确认是「${candidate.displayName}」？`,
      '请对照耳缘、脸部与身体花纹。模型排名不是身份证明，确认后仍可撤销。',
      { type: 'same_cat', catId }
    )
  },

  confirmKnownCat() {
    const cats = (this.data.task && this.data.task.availableCats) || []
    const cat = cats[this.data.knownCatIndex]
    if (!cat) return wx.showToast({ title: '小屋里还没有已同步猫咪', icon: 'none' })
    this.askDecision(
      `关联到「${cat.displayName}」？`,
      '这是人工选择，不代表模型已经验证。请确认花纹和稳定身体特征一致。',
      { type: 'same_cat', catId: cat.catId }
    )
  },

  confirmNewCat() {
    const displayName = String(this.data.newCatName || '').trim()
    if (!displayName) return wx.showToast({ title: '请先填写猫咪昵称', icon: 'none' })
    this.askDecision(
      `将「${displayName}」作为新猫？`,
      '新建不会自动合并其他档案；以后找到更多照片时仍可重新核对。',
      { type: 'new_cat', displayName }
    )
  },

  confirmUnsure() {
    this.askDecision(
      '暂时无法判断？',
      '保留为待确认不会扣分。之后可补拍正脸、左右侧身和明显花纹再判断。',
      { type: 'unsure' }
    )
  },

  askDecision(title, content, decision) {
    if (this.data.actionLoading || !this.data.task) return
    wx.showModal({
      title,
      content,
      confirmText: '确认选择',
      confirmColor: '#FF6F91',
      success: result => {
        if (result.confirm) this.submitDecision(decision)
      }
    })
  },

  async submitDecision(decision) {
    const task = this.data.task
    this.setData({ actionLoading: 'confirm', errorMessage: '', feedbackMessage: '' })
    try {
      const result = await identity.confirm(task.taskId, task.version, decision)
      this.applyTask(result)
      this.setData({ feedbackMessage: decision.type === 'unsure' ? '已保留为待确认，可稍后补拍。' : '身份确认已保存；如果发现不对，可以立即撤销。' })
    } catch (error) {
      this.setData({ errorMessage: error.message || '保存确认失败，请刷新后重试' })
    } finally {
      this.setData({ actionLoading: '' })
    }
  },

  undoDecision() {
    const task = this.data.task
    if (!task || !task.taskId || this.data.actionLoading) return
    wx.showModal({
      title: '撤销这次身份确认？',
      content: '撤销会停止使用这张照片作为该猫的识别模板，并把目击恢复为待确认。原始目击不会丢失。',
      confirmText: '确认撤销',
      confirmColor: '#B94955',
      success: async result => {
        if (!result.confirm) return
        this.setData({ actionLoading: 'undo', errorMessage: '', feedbackMessage: '' })
        try {
          const response = await identity.undo(task.taskId, task.version)
          this.applyTask(response)
          this.setData({ feedbackMessage: '已经撤销。需要重新判断时，请生成一组新的候选。' })
        } catch (error) {
          this.setData({ errorMessage: error.message || '撤销失败，请刷新后重试' })
        } finally {
          this.setData({ actionLoading: '' })
        }
      }
    })
  }
})
