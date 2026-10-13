# License: Apache-2.0 — see LICENSE
param(
  [Parameter(Mandatory = $true)][int]$ElectronProcessId,
  [Parameter(Mandatory = $true)][string]$ProjectRoot
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native project picker requires Windows' }
$project = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not (Test-Path -LiteralPath $project -PathType Container)) { throw 'Fixture project is not a directory' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$automation = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$processCondition = [System.Windows.Automation.PropertyCondition]::new($automation::ProcessIdProperty, $ElectronProcessId)
$deadline = [DateTime]::UtcNow.AddSeconds(45)
$dialog = $null
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = $automation::RootElement.FindAll($scope::Children, $processCondition)
  foreach ($candidate in $windows) {
    if ($candidate.Current.Name -eq 'Open project' -and $candidate.Current.ClassName -eq '#32770') {
      $dialog = $candidate
      break
    }
  }
  if ($null -ne $dialog) { break }
  Start-Sleep -Milliseconds 200
}
if ($null -eq $dialog) { throw 'Owned Open project dialog (#32770) not found within 45 seconds' }
$pathCondition = [System.Windows.Automation.PropertyCondition]::new($automation::AutomationIdProperty, '1148')
$pathControl = $dialog.FindFirst($scope::Descendants, $pathCondition)
if ($null -eq $pathControl) { throw 'Folder path control (1148) unavailable in owned dialog' }
$valuePattern = $null
if (-not $pathControl.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { throw 'Folder path ValuePattern unavailable' }
$valuePattern.SetValue($project)
$selectCondition = [System.Windows.Automation.PropertyCondition]::new($automation::AutomationIdProperty, '1')
$selectControl = $dialog.FindFirst($scope::Descendants, $selectCondition)
if ($null -eq $selectControl) { throw 'Select folder control (1) unavailable in owned dialog' }
$invokePattern = $null
if (-not $selectControl.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) { throw 'Select folder InvokePattern unavailable' }
$invokePattern.Invoke()
