const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createService } = require('../services/companion')
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const event = dataset => ({ currentTarget: { dataset } })
function fixture() {
  const values = {}, calls = [], app = { globalData: { cloudReady: true } }
  const wx = {
    getStorageSync: key => clone(values[key]),
    setStorageSync: (key,value) => { values[key] = clone(value) },
    env:{USER_DATA_PATH:'http://usr'},
    navigateTo: value => calls.push(['navigate',value.url]),
    switchTab: value => calls.push(['tab',value.url]),
    showModal: value => { wx.modal = value },
    chooseMedia: value => { wx.media = value },
    chooseLocation: value => { wx.location = value }
  }
  const box = { wx, module:{exports:{}}, console }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/storage.js'),'utf8'),box)
  const storage = box.module.exports
  storage.persistImage = async () => 'http://usr/cat.jpg'
  const service = createService({storage,io:wx})
  let definition, remoteCall = async () => ({text:'云端测试回复',source:'cloud'})
  let identifyCall = async () => ({breed:'田园猫',coat_color:'橘白'})
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/home/index.js'),'utf8'),{
    wx, getApp:()=>app, Page:value=>{definition=value},
    require(name) {
      if(name==='../../services/companion') return service
      if(name==='../../utils/storage') return storage
      if(name==='../../services/companion-remote') return {reply:(...args)=>{calls.push(['remote',...args]);return remoteCall(...args)}}
      if(name==='../../services/api') return {identify:(...args)=>{calls.push(['identify',...args]);return identifyCall(...args)},normalizeIdentifyResult:value=>value}
      if(name==='../../utils/social-handoff') return require('../utils/social-handoff')
      throw Error(name)
    }, console
  })
  const page = {...definition,data:clone(definition.data),setData(patch){Object.assign(this.data,clone(patch))}}
  page.onLoad()
  return {page,service,storage,wx,calls,app,values,remote:fn=>{remoteCall=fn},identify:fn=>{identifyCall=fn}}
}
test('prompt only fills input; local conversation prepares a draft before confirmed storage',async()=>{
  const f=fixture()
  f.page.usePrompt(event({text:'登记猫咪叫奶糖'}))
  assert.equal(f.service.listMessages().length,0)
  assert.equal(f.storage.listPets().length,0)
  await f.page.send()
  assert.ok(f.page.data.draft, f.page.data.error)
  assert.equal(f.page.data.draft.fields.name,'奶糖')
  assert.equal(f.storage.listPets().length,0)
  f.page.confirmDraft(); f.page.confirmDraft()
  assert.equal(f.storage.listPets().length,1)
  assert.ok(f.page.data.savedPetId)
  assert.equal(f.calls.length,0)
})
test('cancel leaves conversation but no pet and existing pending draft is not replaced',async()=>{
  const f=fixture()
  f.page.makeDraft(event({kind:'pet'}))
  const id=f.page.data.draft.id
  f.page.onInput({detail:{value:'登记猫咪叫另一个'}})
  await f.page.send()
  assert.equal(f.page.data.draft.id,id)
  f.page.cancelDraft()
  assert.equal(f.storage.listPets().length,0)
  assert.equal(f.service.listMessages().length,2)
})
test('cloud mode needs affirmative consent and does not auto-request',()=>{
  const f=fixture()
  f.page.changeMode(); f.wx.modal.success({confirm:false})
  assert.equal(f.page.data.cloudMode,false)
  f.page.changeMode(); f.wx.modal.success({confirm:true})
  assert.equal(f.page.data.cloudMode,true)
  assert.equal(f.calls.length,0)
})
test('failed remote retry keeps original snapshot and preserves a newer unsent message',async()=>{
  const f=fixture(); let attempt=0
  f.remote(async()=>{if(++attempt===1)throw Error('失败');return {text:'云端已回复',source:'cloud'}})
  f.page.data.cloudMode=true
  f.page.onInput({detail:{value:'旧消息'}});await f.page.send()
  assert.equal(f.service.listMessages().length,0)
  assert.equal(f.page.data.input,'旧消息')
  f.page.onInput({detail:{value:'新草稿'}});await f.page.retryRemote()
  assert.equal(f.page.data.input,'新草稿')
  assert.equal(f.service.getComposerDraft(),'新草稿')
  assert.deepEqual(f.calls.filter(row=>row[0]==='remote').map(row=>row[1]),['旧消息','旧消息'])
  assert.equal(f.service.listMessages()[0].text,'旧消息')
  assert.equal(f.storage.listPets().length,0)
})
test('busy send is coalesced and model instructions never become entity writes',async()=>{
  const f=fixture();let finish
  f.remote(()=>new Promise(resolve=>{finish=resolve}))
  f.page.data.cloudMode=true
  f.page.onInput({detail:{value:'登记猫咪叫奶糖'}})
  const request=f.page.send(); await f.page.send()
  assert.equal(f.calls.filter(row=>row[0]==='remote').length,1)
  finish({text:'请自行检查确认卡',source:'cloud'});await request
  assert.equal(f.service.getDraft(),null)
  assert.equal(f.storage.listPets().length,0)
})
test('photo choice is local only; explicit identify prepares editable unsaved suggestion',async()=>{
  const f=fixture()
  f.page.choosePhoto();f.wx.media.success({tempFiles:[{tempFilePath:'http://tmp/photo.jpg'}]})
  assert.equal(f.calls.length,0)
  await f.page.identifyPhoto()
  assert.equal(f.calls.filter(row=>row[0]==='identify').length,1)
  assert.equal(f.page.data.draft.fields.breed,'田园猫')
  assert.equal(f.storage.listPets().length,0)
})
test('identification failure preserves chosen photo without fabricated result',async()=>{
  const f=fixture();f.page.data.pendingPhoto='http://tmp/photo.jpg'
  f.identify(async()=>{throw Error('识别服务失败')})
  await f.page.identifyPhoto()
  assert.equal(f.page.data.pendingPhoto,'http://tmp/photo.jpg')
  assert.equal(f.service.getDraft(),null)
  assert.match(f.page.data.error,/失败/)
})
test('map choice never retains returned address or exact coordinates',()=>{
  const f=fixture();f.storage.savePet({id:'cat1',name:'奶糖'})
  f.page.makeDraft(event({kind:'location'}));f.page.choosePlace()
  f.wx.location.success({latitude:31.234567,longitude:121.456789,name:'私人地址',address:'私人门牌123号'})
  const draft=f.service.getDraft()
  assert.notEqual(draft.fields.latitude,31.234567)
  assert.doesNotMatch(JSON.stringify(f.values),/私人门牌|私人地址|31.234567|121.456789/)
  f.page.onDraftInput({currentTarget:{dataset:{field:'areaText'}},detail:{value:'公园附近'}})
  f.page.confirmDraft()
  assert.equal(f.service.listLocations().length,1)
})
test('sharing opens explicit composer and does not publish the conversation',async()=>{
  const f=fixture()
  f.page.onInput({detail:{value:'登记猫咪叫奶糖'}});await f.page.send();f.page.confirmDraft()
  f.page.shareSaved()
  assert.match(f.calls[0][1],/^\/pages\/social-compose\/index\?petId=/)
  assert.equal(f.calls.length,1)
})
test('templates bind existing handlers and safe keyboard container is explicit',()=>{
  const f=fixture(), wxml=fs.readFileSync(path.join(__dirname,'../pages/home/index.wxml'),'utf8')
  for(const binding of wxml.matchAll(/bind[\w-]+="([a-zA-Z]+)"/g)) assert.equal(typeof f.page[binding[1]],'function',binding[1])
  assert.doesNotMatch(wxml,/&amp;&amp;|\.trim\(\)/)
  f.page.onKeyboard({detail:{height:290}})
  assert.equal(f.page.data.keyboardHeight,290)
  f.page.onHide(); assert.equal(f.page.data.keyboardHeight,0)
})
test('long local history is bounded before optional remote call, not a permanent send blocker',async()=>{
  const f=fixture()
  f.service.send('长'.repeat(1001))
  f.page.data.cloudMode=true
  f.page.onInput({detail:{value:'你好'}}); await f.page.send()
  const remote=f.calls.find(row=>row[0]==='remote')
  assert.ok(remote)
  assert.ok(remote[2].every(message=>message.content.length<=1000))
  assert.equal(f.page.data.error,'')
})
test('failed message write immediately recovers persisted draft while preserving input',async()=>{
  const f=fixture(), write=f.wx.setStorageSync
  let failed=false
  f.wx.setStorageSync=(key,value)=>{
    if(key==='catai_companion_messages_v1'&&!failed){failed=true;throw Error('消息保存失败')}
    write(key,value)
  }
  f.page.onInput({detail:{value:'登记猫咪叫奶糖'}});await f.page.send()
  assert.equal(f.page.data.draft.fields.name,'奶糖')
  assert.equal(f.page.data.input,'登记猫咪叫奶糖')
  assert.match(f.page.data.error,/消息保存失败/)
  assert.equal(f.storage.listPets().length,0)
  f.page.cancelDraft()
  assert.equal(f.page.data.draft,null)
  assert.equal(f.storage.listPets().length,0)
})
test('full message history still exposes pending draft for explicit confirmation without resend',async()=>{
  const f=fixture()
  f.wx.setStorageSync('catai_companion_messages_v1',{schema:1,messages:Array.from({length:2000},(_,i)=>({
    id:'old_'+i,role:'user',text:'原有消息',time:1,label:'你',localOnly:true
  }))})
  f.page.onInput({detail:{value:'登记猫咪叫奶糖'}});await f.page.send()
  assert.equal(f.page.data.draft.fields.name,'奶糖')
  assert.equal(f.page.data.input,'登记猫咪叫奶糖')
  assert.match(f.page.data.error,/2000/)
  assert.equal(f.storage.listPets().length,0)
  f.page.confirmDraft();f.page.confirmDraft()
  assert.equal(f.storage.listPets().length,1)
  assert.equal(f.service.listMessages().length,2000)
})
test('new text relationship draft invalidates previous cat share shortcut',async()=>{
  const f=fixture()
  for(const name of ['奶糖','团子']){
    f.page.onInput({detail:{value:'登记猫咪叫'+name}});await f.page.send();f.page.confirmDraft()
  }
  assert.ok(f.page.data.savedPetId)
  f.page.onInput({detail:{value:'奶糖是团子的妈妈'}});await f.page.send()
  assert.equal(f.page.data.savedPetId,'')
  f.page.shareSaved()
  assert.equal(f.calls.length,0)
})
test('photo draft invalidates old share; newly confirmed cat becomes the sole share target',async()=>{
  const f=fixture()
  f.page.onInput({detail:{value:'登记猫咪叫奶糖'}});await f.page.send();f.page.confirmDraft()
  f.page.data.pendingPhoto='http://tmp/cat.jpg';await f.page.identifyPhoto()
  assert.equal(f.page.data.savedPetId,'')
  f.page.shareSaved()
  assert.equal(f.calls.filter(row=>row[0]==='navigate').length,0)
  f.page.onDraftInput({currentTarget:{dataset:{field:'name'}},detail:{value:'团子'}})
  f.page.confirmDraft();f.page.shareSaved()
  assert.equal(f.calls.filter(row=>row[0]==='navigate').length,1)
  assert.ok(f.calls.find(row=>row[0]==='navigate')[1].includes(encodeURIComponent(f.page.data.savedPetId)))
})
