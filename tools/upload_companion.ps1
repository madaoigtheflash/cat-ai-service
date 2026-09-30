[CmdletBinding()]
param(
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version = '2.1.0',
  [ValidateLength(1, 180)]
  [string]$Description = '小桃陪伴互动与排版更新；确认登记猫咪、关系及本机粗位置；保留主动社区分享。',
  [switch]$Upload
)

function Get-SafeUploadDiagnostic {
  param([object[]]$Diagnostics, [int]$ExitCode, [bool]$ReceiptPresent)
  # Keep only fixed categories and bounded numeric error codes. Never persist
  # arbitrary CLI lines, URLs, headers, account IDs, paths, tokens or messages.
  $diagnosticText = (@($Diagnostics | ForEach-Object { [string]$_ }) -join "`n") -replace '\x1B\[[0-?]*[ -/]*[@-~]', ''
  $errorCodes = @([regex]::Matches($diagnosticText, '(?i)\b(?:errcode|errorcode|error_code)\s*["'':= ]+(-?\d{1,7})\b') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique | Select-Object -First 12)
  return [ordered]@{
    cliExitCode = $ExitCode
    receiptPresent = $ReceiptPresent
    diagnosticLineCount = @($Diagnostics).Count
    signals = [ordered]@{
      errorMarker = [bool]($diagnosticText -match '(?i)\[error\]|\bfailed\b|\bfailure\b|失败')
      uploadSuccessMarker = [bool]($diagnosticText -match '(?i)upload success|[√✔]\s*upload\b|上传成功')
      loginMentioned = [bool]($diagnosticText -match '(?i)\blogin\b|登录')
      permissionMentioned = [bool]($diagnosticText -match '(?i)permission|forbidden|unauthori[sz]ed|权限')
      timeoutMentioned = [bool]($diagnosticText -match '(?i)timeout|timed out|超时')
      connectionMentioned = [bool]($diagnosticText -match '(?i)ECONN|connection|连接')
      argumentMentioned = [bool]($diagnosticText -match '(?i)invalid argument|unknown argument|missing required|参数')
      compileMentioned = [bool]($diagnosticText -match '(?i)compile|编译')
    }
    numericErrorCodes = $errorCodes
  }
}

$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
$releaseProject = Join-Path $releaseRoot 'miniapp'
$wechatCli = 'D:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat'
if (-not (Test-Path -LiteralPath $wechatCli -PathType Leaf)) { throw '未找到微信开发者工具 CLI。' }
if ($Description -match '[\r\n]') { throw '更新说明必须为单行文字。' }

$projectConfig = Get-Content -LiteralPath (Join-Path $releaseProject 'project.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($projectConfig.appid -ne 'wx1112379224ace9f9') { throw 'AppID 不匹配，停止上传。' }
if ($projectConfig.setting.urlCheck -ne $true) { throw '正式包必须启用 urlCheck。' }
$ignoredFolders = @($projectConfig.packOptions.ignore | Where-Object { $_.type -eq 'folder' } | ForEach-Object { $_.value })
foreach ($requiredFolder in @('cloudfunctions', '.miniprogram-ci', 'tests')) {
  if ($ignoredFolders -notcontains $requiredFolder) { throw "上传包未排除 $requiredFolder。" }
}

$capabilityOutput = & node -e "const p=require('node:path'), root=process.argv[1]; console.log(JSON.stringify({release:require(p.join(root,'config/companion-release.js')), lab:require(p.join(root,'config/cato-lab.js'))}));" $releaseProject
if ($LASTEXITCODE -ne 0) { throw '无法读取本地发布能力开关。' }
$capability = $capabilityOutput | ConvertFrom-Json
if ($capability.release.cloudDialogueEnabled -ne $false) { throw '本次发布不允许开启云端文字对话。' }
if ($capability.lab.enabled -ne $false) { throw '实验离线模式尚未关闭。' }
if ($capability.release.version -ne $Version) { throw '上传版本与 companion-release.js 不一致。' }

$privateConfigPath = Join-Path $releaseProject 'project.private.config.json'
if (Test-Path -LiteralPath $privateConfigPath -PathType Leaf) {
  $privateConfig = Get-Content -LiteralPath $privateConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($privateConfig.setting -and $privateConfig.setting.urlCheck -eq $false) {
    throw '项目私有设置覆盖了 urlCheck，请先在开发者工具启用域名校验。'
  }
}

$revision = & git -C $releaseRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw '无法核对 Git 提交。' }
Write-Host "本地预检通过：猫猫小屋 $Version，源提交 $revision。"
Write-Host "项目目录：$releaseProject"
if (-not $Upload) {
  Write-Host '尚未上传。完成测试并提交源代码后，加 -Upload 才会上传开发版本；不会提审或正式发布。'
  return
}

$sourceChanges = @(& git -C $releaseRoot status --porcelain -- miniapp tools/upload_companion.ps1)
if ($LASTEXITCODE -ne 0) { throw '无法核对工作区状态。' }
if ($sourceChanges.Count -gt 0) { throw '小程序或上传脚本仍有未提交修改。先测试、提交，再上传可追溯版本。' }

$uploadDirectory = Join-Path $releaseRoot 'artifacts/companion-release'
New-Item -ItemType Directory -Path $uploadDirectory -Force | Out-Null
$uploadInfo = Join-Path $uploadDirectory ("upload-$Version-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
Write-Host '开始上传开发版本。微信登录或开发者权限不足时将停止，不自动登录、不提审。'
# Drain CLI diagnostics without printing account/session context. The IDE shows
# actionable upload errors; the ignored JSON result records successful package info.
$savedErrorAction = $ErrorActionPreference
try {
  # Windows PowerShell 5 otherwise treats redirected native stderr warnings as
  # terminating errors before LASTEXITCODE can be checked.
  $ErrorActionPreference = 'Continue'
  $cliDiagnostics = @(& $wechatCli upload --project $releaseProject --version $Version --desc $Description --info-output $uploadInfo 2>&1)
  $uploadExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $savedErrorAction }
$receiptPresent = Test-Path -LiteralPath $uploadInfo -PathType Leaf
$diagnosticSummary = [ordered]@{
  schemaVersion = 1
  recordedAtUtc = [DateTime]::UtcNow.ToString('o')
  version = $Version
  sourceCommit = [string]$revision
  outcome = 'not_confirmed_check_platform'
  diagnostics = Get-SafeUploadDiagnostic -Diagnostics $cliDiagnostics -ExitCode $uploadExit -ReceiptPresent $receiptPresent
}
$diagnosticPath = [IO.Path]::ChangeExtension($uploadInfo, '.status.json')
[IO.File]::WriteAllText($diagnosticPath, ($diagnosticSummary | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
$cliDiagnostics = $null
Write-Host "已保存脱敏诊断：$diagnosticPath（仅固定状态与数值错误码，无原始日志）。"
# This CLI catches upload errors without setting a nonzero exit status. Zero
# alone is not evidence of success; preserve the receipt + platform checks.
if ($uploadExit -ne 0) { throw "微信 CLI 上传失败（退出码 $uploadExit）。请在开发者工具检查登录、开发者权限和错误提示。" }
if (-not $receiptPresent) { throw 'CLI 未返回上传结果文件，不能确认上传成功；请在公众平台核对，勿直接重复上传。' }
$uploadResult = Get-Content -LiteralPath $uploadInfo -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $uploadResult.size -or $uploadResult.size.total -le 0) { throw '上传结果缺少有效包大小，请在公众平台核对；不能据此确认成功。' }
$diagnosticSummary.outcome = 'cli_receipt_valid_platform_check_required'
[IO.File]::WriteAllText($diagnosticPath, ($diagnosticSummary | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Write-Host "CLI 已返回开发版本上传成功，包大小 $($uploadResult.size.total) 字节。结果：$uploadInfo"
Write-Host '请在公众平台核对版本号和更新说明。尚未提交审核、尚未正式发布。'
