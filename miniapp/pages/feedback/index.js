'use strict'

const online = require('../../services/online')

const CATEGORIES = [
  { key: 'bug', label: '遇到故障' },
  { key: 'usability', label: '不好使用' },
  { key: 'feature', label: '功能建议' },
  { key: 'content', label: '内容问题' },
  { key: 'privacy', label: '隐私与安全' },
  { key: 'other', label: '其他想法' }
]

const FEEDBACK_STAGE_COPY = {
  RECEIVED: {
    label: '已收到',
    next: '已进入产品反馈筛选；部分反馈可能不会形成修改建议。',
    tone: 'neutral'
  },
  INITIAL_REVIEW: {
    label: '已筛选',
    next: '已完成产品反馈整理；若适合改进，将进入开发审阅。',
    tone: 'neutral'
  },
  LOCAL_REVIEW: {
    label: '本地审计中',
    next: '反馈已形成本地修改建议，正由开发端审阅并决定是否执行。',
    tone: 'warning'
  },
  EXECUTING: {
    label: '执行中',
    next: '本地修改正在执行，完成或失败后会按真实结果更新。',
    tone: 'warning'
  },
  COMPLETED: {
    label: '已处理',
    next: '关联修改已经完成并回写结果。',
    tone: 'success'
  },
  REJECTED: {
    label: '暂不采用',
    next: '本次建议暂未进入修改；后续仍可结合新信息重新评估。',
    tone: 'error'
  },
  FAILED: {
    label: '待人工处理',
    next: '本地执行未成功，后续可由开发端恢复或重新审计。',
    tone: 'error'
  },
  STATUS_PENDING: {
    label: '状态待更新',
    next: '历史状态暂不一致，系统不会据此推断为已处理。',
    tone: 'warning'
  }
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function categoryLabel(value) {
  const found = CATEGORIES.find(item => item.key === value)
  return found ? found.label : '其他想法'
}

function normalizeFeedback(item) {
  const stageCopy = FEEDBACK_STAGE_COPY[item.stage] || FEEDBACK_STAGE_COPY.STATUS_PENDING
  return Object.assign({}, item, {
    categoryLabel: categoryLabel(item.category),
    stageLabel: stageCopy.label,
    stageNext: stageCopy.next,
    stageTone: stageCopy.tone,
    createdLabel: formatTime(item.createdAt),
    stageUpdatedLabel: formatTime(item.stageUpdatedAt || item.updatedAt || item.createdAt)
  })
}

function clientContext() {
  let version = 'develop'
  let platform = ''
  let sdkVersion = ''
  try {
    const account = wx.getAccountInfoSync()
    version = account && account.miniProgram && (account.miniProgram.version || account.miniProgram.envVersion) || version
  } catch (error) {}
  try {
    const system = wx.getSystemInfoSync()
    platform = String(system.platform || '')
    sdkVersion = String(system.SDKVersion || '')
  } catch (error) {}
  return { version, platform, sdkVersion, sourcePage: 'pages/feedback/index' }
}

Page({
  data: {
    categories: CATEGORIES,
    categoryNames: CATEGORIES.map(item => item.label),
    categoryIndex: 0,
    form: { title: '', content: '', steps: '' },
    loading: true,
    sending: false,
    errorMessage: '',
    successMessage: '',
    myFeedback: []
  },

  onLoad() {
    this.loadCenter()
  },

  onPullDownRefresh() {
    this.loadCenter().finally(() => wx.stopPullDownRefresh())
  },

  async loadCenter() {
    this.setData({ loading: true, errorMessage: '' })
    try {
      const result = await online.listFeedbackCenter()
      this.setData({ myFeedback: (result.myFeedback || []).map(normalizeFeedback) })
    } catch (error) {
      this.setData({ errorMessage: error.message || '意见信箱暂时无法连接' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onCategoryChange(event) {
    this.setData({ categoryIndex: Number(event.detail.value) || 0 })
  },

  onTitleInput(event) { this.setData({ 'form.title': event.detail.value }) },
  onContentInput(event) { this.setData({ 'form.content': event.detail.value }) },
  onStepsInput(event) { this.setData({ 'form.steps': event.detail.value }) },

  async submit() {
    if (this.data.sending) return
    const title = String(this.data.form.title || '').trim()
    const content = String(this.data.form.content || '').trim()
    const steps = String(this.data.form.steps || '').trim()
    if (!title) {
      this.setData({ errorMessage: '请先写一句反馈标题' })
      return
    }
    if (content.length < 8) {
      this.setData({ errorMessage: '请至少用 8 个字描述遇到的情况或建议' })
      return
    }
    this.setData({ sending: true, errorMessage: '', successMessage: '' })
    try {
      await online.submitFeedback({
        category: CATEGORIES[this.data.categoryIndex].key,
        title,
        content,
        steps,
        client: clientContext()
      })
      this.setData({
        form: { title: '', content: '', steps: '' },
        successMessage: '已收到。接下来会先进行产品反馈筛选，并在适合时进入开发审阅；不承诺处理时限。若内容涉及健康，仅作辅助参考，异常请咨询执业兽医。'
      })
      await this.loadCenter()
    } catch (error) {
      this.setData({ errorMessage: error.message || '提交失败，请稍后再试' })
    } finally {
      this.setData({ sending: false })
    }
  }
})
