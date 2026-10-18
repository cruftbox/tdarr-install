# Builds hevc-flow.json (Input File -> Custom JS Function) with hevc-convert.js embedded.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$code = Get-Content -Raw -LiteralPath (Join-Path $here 'hevc-convert.js')
$flow = [ordered]@{
  _id         = 'hevc_project'
  name        = 'HEVC project'
  description = 'Rules in tdarr.md, Requirement 5. Code in flow/hevc-convert.js.'
  tags        = ''
  flowPlugins = @(
    [ordered]@{ name = 'Input File'; sourceRepo = 'Community'; pluginName = 'inputFile'; version = '1.0.0'; id = 'input'; position = @{ x = 400; y = 0 }; inputsDB = @{}; fpEnabled = $true }
    [ordered]@{ name = 'HEVC convert'; sourceRepo = 'Community'; pluginName = 'customFunction'; version = '1.0.0'; id = 'hevc'; position = @{ x = 400; y = 150 }; inputsDB = @{ code = $code }; fpEnabled = $true }
  )
  flowEdges   = @(
    [ordered]@{ source = 'input'; sourceHandle = '1'; target = 'hevc'; targetHandle = $null; id = 'e1' }
  )
}
$flow | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $here 'hevc-flow.json') -Encoding utf8NoBOM
