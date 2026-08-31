const api = require('../../services/api')
const online = require('../../services/online')
const identity = require('../../services/identity')

Page({
  data: {
    cloudEnv: api.CLOUD_ENV,
    testing: false,
    testStatus: '',
    testMessage: '',
    photoStatus: '主动使用时检测',
    onlineStatus: '待检测',
    identityStatus: '待检测'
  },

  async testConnection() {
    this.setData({
      testing: true,
      testStatus: '',
      testMessage: '',
      onlineStatus: '检测中',
      identityStatus: '检测中'
    })
    try {
      const results = await Promise.allSettled([online.health(), identity.health()])
      const onlineResult = results[0].status === 'fulfilled' ? results[0].value : null
      const identityResult = results[1].status === 'fulfilled' ? results[1].value : null
      const onlineReady = Boolean(onlineResult && onlineResult.ownerSecretConfigured)
      const identityReady = Boolean(identityResult && identityResult.ownerSecretConfigured)
      const workerReady = Boolean(identityResult && (identityResult.workerConfigured || identityResult.mode === 'model_candidate'))
      const allReady = onlineReady && identityReady
      this.setData({
        onlineStatus: onlineReady ? '已连接' : onlineResult ? '缺少云端配置' : '函数未部署',
        identityStatus: identityReady
          ? (workerReady ? '候选整理可用' : '人工核对可用')
          : identityResult ? '缺少云端配置' : '函数未部署',
        testStatus: allReady ? 'success' : 'partial',
        testMessage: allReady
          ? `邀请小屋与同猫核对服务已连接；同猫功能当前为${workerReady ? '候选整理模式' : '人工核对模式'}。照片识猫会在你主动选图后单独检测。`
          : '检测到未完成的云端配置。请按部署文档补齐函数、集合或服务凭据；本地档案和内置知识不受影响。'
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
