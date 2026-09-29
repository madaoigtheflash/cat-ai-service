'use strict'
module.exports = function assertCloudAllowed() {
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && app.globalData && app.globalData.catoLabOffline) {
    throw new Error('此分支为离线审计实验，不连接生产云端；没有发送或上传。')
  }
}
