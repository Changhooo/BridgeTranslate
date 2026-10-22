param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$pluginPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'bridge-translate-cc'))
$claudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$settingsPath = Join-Path $claudeHome 'settings.json'
if (-not $Uninstall -and -not (Test-Path (Join-Path $pluginPath '.claude-plugin/plugin.json'))) { throw 'Plugin files are missing. Extract the entire package first.' }
New-Item -ItemType Directory -Path $claudeHome -Force | Out-Null
if (Test-Path $settingsPath) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $settings -or $settings -isnot [PSCustomObject]) { throw 'settings.json must contain a JSON object. No changes made.' }
} else { $settings = New-Object PSObject }
if (-not $settings.PSObject.Properties['env']) { $settings | Add-Member -NotePropertyName env -NotePropertyValue (New-Object PSObject) }
if ($settings.env -isnot [PSCustomObject]) { throw 'The env field must be a JSON object. No changes made.' }
$current = if ($settings.env.PSObject.Properties['CLAUDE_CODE_PLUGIN_DIRS']) { [string]$settings.env.CLAUDE_CODE_PLUGIN_DIRS } else { '' }
$paths = @($current -split ';' | Where-Object { $_ -and ($_ -ne $pluginPath) })
if (-not $Uninstall) { $paths += $pluginPath }
$settings.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIRS -NotePropertyValue ($paths -join ';') -Force
if (Test-Path $settingsPath) { Copy-Item -LiteralPath $settingsPath -Destination ($settingsPath + '.bridge-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-ffff')) }
$json = $settings | ConvertTo-Json -Depth 100
$tempPath = $settingsPath + '.bridge-tmp-' + [Guid]::NewGuid().ToString('N')
[System.IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tempPath -Destination $settingsPath -Force
if ($Uninstall) { Write-Host 'Bridge Translate CC path removed. Restart Claude Desktop. Plugin settings/credentials have not been deleted.' }
else { Write-Host 'Bridge Translate CC registered. Restart Claude Desktop, open a local Code session, then enter /bridge. Keep this package at its current path.' }
