<#
.SYNOPSIS
  Backward-compatible live starter. Prefer start_swebench_pro.ps1 -Profile.
#>
param(
  [Parameter(Mandatory = $true)][string]$Dataset,
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [string]$Model = 'deepseek-v4-flash',
  [int]$Limit = 3,
  [int]$EarlyStop = 5,
  [int]$AgentTimeoutMs = 0,
  [int]$FailToPassTimeoutMs = 900000
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$profile = if ($Limit -eq 1) { 'gate0-canary' } elseif ($Limit -ge 20) { 'waveA-20' } else { 'remeasure-3' }

& (Join-Path $here 'start_swebench_pro.ps1') `
  -Profile $profile `
  -Dataset $Dataset `
  -EvidenceDir $EvidenceDir `
  -Model $Model `
  -Limit $Limit `
  -EarlyStop $EarlyStop `
  -AgentTimeoutMs $AgentTimeoutMs `
  -FailToPassTimeoutMs $FailToPassTimeoutMs
