param()
$pwdPlain = 'change_me_123!'
$secure = ConvertTo-SecureString $pwdPlain -AsPlainText -Force
$pfxPath = Join-Path (Get-Location) 'build\\codesign.pfx'
if (!(Test-Path (Split-Path $pfxPath))) { New-Item -ItemType Directory -Path (Split-Path $pfxPath) | Out-Null }
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=VA Trackme (Self-Signed)' -KeyExportPolicy Exportable -KeySpec Signature -NotAfter (Get-Date).AddYears(10) -CertStoreLocation 'Cert:\\CurrentUser\\My'
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure -Force
$link = 'file:///' + ($pfxPath -replace '\\\\','/')
Write-Output $pfxPath
Write-Output $link
