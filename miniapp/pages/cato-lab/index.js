const config = require('../../config/cato-lab')
const { createStore } = require('../../services/cato-lab')
Page({
  data: { ...config, error: '' },
  openExperiment() {
    if (!/^\/pages\/cato-[a-z-]+\/index$/.test(config.entry)) return
    wx.navigateTo({ url: config.entry, fail: () => this.setData({ error: '实验页面未能打开，请核对分支及编译结果。' }) })
  },
  resetExperiment() {
    wx.showModal({ title: '清空本实验数据？', content: '仅清空此方案的本机实验记录，不删除原版猫咪档案或云端数据。',
      success: result => {
        if (!result.confirm) return
        try { createStore(config.variant).reset(); wx.showToast({ title: '本实验已重置', icon: 'none' }) }
        catch (_) { this.setData({ error: '重置失败，原记录可能仍保留，请稍后重试。' }) }
      }
    })
  }
})
