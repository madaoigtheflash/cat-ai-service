param([int]$Port = 9480)
$companionRoot = Split-Path -Parent $PSScriptRoot
$companionProject = Join-Path $companionRoot 'miniapp'
$wechatCli = 'D:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat'
if (-not (Test-Path -LiteralPath $wechatCli)) { throw '未找到微信开发者工具 CLI，请修改脚本中的安装路径。' }
Write-Host '打开对话收敛开发版。不会上传版本、部署云函数或重置本机数据。'
& $wechatCli auto --project $companionProject --auto-port $Port --trust-project
