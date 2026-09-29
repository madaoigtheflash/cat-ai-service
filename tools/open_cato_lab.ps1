param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('capture','care-planner','house-goals','focus','expenses','journal','social-followup','companion','sync-contract','encounter-review','relationship-observe','knowledge-action')]
  [string]$Variant,
  [string]$WorktreesRoot = 'C:/Users/13622/.codex/worktrees',
  [string]$WechatCli = 'D:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$labRepo = Join-Path $WorktreesRoot ('cato-' + $Variant + '/cat-ai-service')
$labRepo = (Resolve-Path -LiteralPath $labRepo).Path
$labProject = Join-Path $labRepo 'miniapp'
$labBranch = (& git -C $labRepo branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $labBranch -ne ('codex/cato-lab/' + $Variant)) { throw '工作树分支不匹配，停止打开。' }
$labProjectConfig = Get-Content -LiteralPath (Join-Path $labProject 'project.config.json') -Raw | ConvertFrom-Json
$labAppConfig = Get-Content -LiteralPath (Join-Path $labProject 'app.json') -Raw | ConvertFrom-Json
$labModeSource = Get-Content -LiteralPath (Join-Path $labProject 'config/cato-lab.js') -Raw
if ($labProjectConfig.appid -ne 'touristappid' -or $labAppConfig.pages[0] -ne 'pages/cato-lab/index' -or $labModeSource -notmatch 'enabled\s*:\s*true') { throw '离线游客实验条件不满足，停止打开。' }
Write-Output ('离线审计分支：' + $labBranch)
Write-Output ('项目目录：' + $labProject)
if ($CheckOnly) { return }
if (-not (Test-Path -LiteralPath $WechatCli -PathType Leaf)) { throw '找不到微信开发者工具 CLI，请用 -WechatCli 指定路径。' }
& $WechatCli open --project $labProject
if ($LASTEXITCODE -ne 0) { throw ('微信开发者工具打开失败：' + $LASTEXITCODE) }
