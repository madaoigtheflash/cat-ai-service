const api = require('../../services/api')
const online = require('../../services/online')
const identity = require('../../services/identity')

Page({
  data: {
    cloudEnv: api.CLOUD_ENV,
    model: 'MiniMax-M3',
    testing: false,
    testStatus: '',
    testMessage: '',
    keyConfigured: false,
    onlineStatus: '待检测',
    identityStatus: '待检测'
  },

  async testConnection() {
    this.setData({
      testing: true,
      testStatus: '',
      testMessage: '',
      keyConfigured: false,
      onlineStatus: '检测中',
      identityStatus: '检测中'
    })
    try {
      const results = await Promise.allSettled([api.health(), online.health(), identity.health()])
      const aiResult = results[0].status === 'fulfilled' ? results[0].value : null
      const onlineResult = results[1].status === 'fulfilled' ? results[1].value : null
      const identityResult = results[2].status === 'fulfilled' ? results[2].value : null
      const configured = Boolean(aiResult && aiResult.modelConfigured)
      const onlineReady = Boolean(onlineResult && onlineResult.ownerSecretConfigured)
      const identityReady = Boolean(identityResult && identityResult.ownerSecretConfigured)
      const workerReady = Boolean(identityResult && (identityResult.workerConfigured || identityResult.mode === 'model_candidate'))
      const allReady = configured && onlineReady && identityReady
      this.setData({
        keyConfigured: configured,
        onlineStatus: onlineReady ? '已连接' : onlineResult ? '缺少云端密钥' : '函数未部署',
        identityStatus: identityReady
          ? (workerReady ? '模型候选模式' : '人工确认模式')
          : identityResult ? '缺少云端密钥' : '函数未部署',
        testStatus: allReady ? 'success' : 'partial',
        testMessage: allReady
          ? `基础云服务已连接，模型 ${aiResult.model || this.data.model} 已配置；同猫功能当前为${workerReady ? '模型候选模式' : '人工确认模式'}。`
          : '检测到未完成的云端配置。请按部署文档补齐函数、集合或云端密钥；本地档案不受影响。'
      })
    } catch (error) {
      this.setData({
        testStatus: 'failed',
        onlineStatus: '检测失败',
        identityStatus: '检测失败',
        testMessage: error.message || '云环境连接失败'
      })
    } finally {
      this.setData({ testing: false })
    }
  }
})
