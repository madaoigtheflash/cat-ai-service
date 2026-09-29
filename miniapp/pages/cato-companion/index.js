'use strict'

const model = require('../../utils/cato-companion')
const { createStore } = require('../../services/cato-lab')

function createPageOptions(dependencies) {
  const deps = dependencies || {}
  return {
    data: {
      draft: model.defaults(), dirty: false, busy: false, loadFailed: false,
      error: '', status: '', fieldErrors: {}, scenario: 'start', simulatedTime: '23:00',
      previewText: '', attempted: false, prompt: null, quietDescription: '',
      scenarios: [{ id: 'start', label: '开始' }, { id: 'interrupted', label: '中断' }, { id: 'finished', label: '结束' }],
      timePresets: ['23:00', '07:59', '08:00', '12:00']
    },
    onLoad() {
      this.api = deps.api || wx
      this.store = createStore('companion', this.api)
      this.saved = model.defaults(deps.systemReduceMotion)
      this.loadPreferences()
    },
    loadPreferences() {
      if (this.data.busy) return
      try {
        this.saved = model.restore(this.store.load('preferences', null), deps.systemReduceMotion)
        this.setData({ draft: Object.assign({}, this.saved), loadFailed: false, error: '', status: '偏好仅保存在本机；修改后请点保存。', fieldErrors: {}, attempted: false })
      } catch (_) {
        this.setData({ draft: Object.assign({}, this.saved), loadFailed: true, error: '读取本机偏好失败，暂不覆盖旧数据。请重试读取，或确认恢复默认。', status: '' })
      }
      this.refresh()
    },
    refresh() {
      const prefs = this.data.draft
      const equalTimes = prefs.quietStart === prefs.quietEnd
      const crossing = model.minutes(prefs.quietStart) > model.minutes(prefs.quietEnd)
      this.setData({
        dirty: !model.equal(prefs, this.saved),
        previewText: model.sceneText(prefs, this.data.scenario),
        prompt: this.data.attempted ? model.promptResult(prefs, this.data.simulatedTime, this.data.scenario) : null,
        quietDescription: !prefs.quietEnabled ? '安静时段已停用；仍需开启页内提示才会展示。' : equalTimes ? '开始与结束相同：按全天安静处理。' : `${crossing ? '跨午夜：' : ''}${prefs.quietStart} 起安静，${prefs.quietEnd} 恢复；结束时刻不在安静时段。`
      })
    },
    edit(event) {
      if (this.data.busy) return
      const key = event.currentTarget.dataset.key
      if (!['nickname', 'assistantName', 'tone', 'notificationsEnabled', 'quietEnabled', 'quietStart', 'quietEnd', 'reduceMotion'].includes(key)) return
      let value = event.detail && event.detail.value
      if (key === 'tone') value = event.currentTarget.dataset.value
      const draft = Object.assign({}, this.data.draft, { [key]: value })
      this.setData({ draft, error: this.data.loadFailed ? this.data.error : '', fieldErrors: {}, status: '' })
      this.refresh()
    },
    chooseScenario(event) {
      const scenario = event.currentTarget.dataset.value
      if (!model.SCENARIOS.includes(scenario)) return
      this.setData({ scenario }); this.refresh()
    },
    changeClock(event) {
      const value = (event.detail && event.detail.value) || event.currentTarget.dataset.value
      if (model.minutes(value) === null) return
      this.setData({ simulatedTime: value }); this.refresh()
    },
    simulatePrompt() { this.setData({ attempted: true }); this.refresh() },
    confirm(title, content, action) {
      if (this.data.busy) return
      this.setData({ busy: true, error: '', status: '' })
      const failure = () => this.setData({ busy: false, error: '确认窗口未能打开，尚未更改本机偏好。请重试。' })
      try {
        this.api.showModal({ title, content, confirmText: '确认', cancelText: '取消',
          success: result => {
            if (!this.data.busy) return
            if (!result.confirm) { this.setData({ busy: false, status: '已取消，偏好未更改。' }); return }
            try { action() } catch (_) { this.setData({ error: '本机保存失败，未标记为已保存。当前草稿仍在，可重试；离开前请留意未保存提示。', status: '' }) }
            finally { this.setData({ busy: false }); this.refresh() }
          }, fail: failure
        })
      } catch (_) { failure() }
    },
    save() {
      if (this.data.busy || this.data.loadFailed) return
      const result = model.validate(this.data.draft)
      if (!result.ok) { this.setData({ fieldErrors: result.errors, error: '请先修正标出的偏好，再保存。', status: '' }); return }
      if (model.equal(result.value, this.saved)) {
        this.setData({ draft: result.value, status: '与已保存偏好一致，无需重复写入。', error: '' }); this.refresh(); return
      }
      this.confirm('保存本机陪伴偏好？', '仅保存称呼、语气、页内提示、安静时段和动效偏好。不会设置微信免打扰、订阅通知或云端偏好；模拟时钟与示例对话不保存。', () => {
        const saved = this.store.save('preferences', result.value)
        this.saved = saved
        this.setData({ draft: Object.assign({}, saved), fieldErrors: {}, status: '已保存到本机实验空间。没有发送消息或设置微信通知。' })
      })
    },
    discard() {
      if (this.data.busy || !this.data.dirty) return
      this.confirm('放弃未保存的修改？', '称呼、语气和开关恢复到修改前的状态。不写入本机，也不删除已经保存的偏好。', () => {
        this.setData({ draft: Object.assign({}, this.saved), fieldErrors: {}, attempted: false, status: '已放弃草稿，恢复到修改前状态。未写入本机。' })
      })
    },
    reset() {
      if (this.data.busy) return
      this.confirm('恢复并保存默认偏好？', '将覆盖本实验的本机偏好：页内提示关闭、22:00–08:00 安静、默认减少动态。原版档案和云端数据不受影响。', () => {
        const next = model.defaults(deps.systemReduceMotion)
        const saved = this.store.save('preferences', next)
        this.saved = saved
        this.setData({ draft: Object.assign({}, saved), loadFailed: false, fieldErrors: {}, attempted: false, status: '默认偏好已保存到本机。页内提示保持关闭。' })
      })
    }
  }
}

if (typeof Page === 'function') Page(createPageOptions())
module.exports = { createPageOptions }
