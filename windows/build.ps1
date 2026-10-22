$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
 dotnet run --project .\BridgeTranslate.Checks -c Release
 if ($LASTEXITCODE -ne 0) { throw 'Core checks failed.' }
 dotnet publish .\BridgeTranslate.App -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
 if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
 Write-Host 'Published application: BridgeTranslate.App\bin\Release\net8.0-windows\win-x64\publish'
} finally { Pop-Location }
