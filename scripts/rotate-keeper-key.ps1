# Swap the Railway keeper from its full-access key to a function-call key that can
# only call `execute` and `expire` on the readersEXIT contract (audit item 7).
#
#   .\scripts\rotate-keeper-key.ps1
#
# Needs: near-cli (JS) with keeper.skyto.near's full-access key in ~/.near-credentials,
# and the Railway CLI logged in and linked to readersexit-keeper.
# The full-access key stays on this PC as the account's recovery key; keep it offline.
param(
  [string]$KeeperId = "keeper.skyto.near",
  [string]$ContractId = "readersexit.near",
  [string]$Network = "mainnet",
  # Gas budget (NEAR) the key may spend before it needs re-adding. Each execute pre-pays
  # ~0.02 NEAR of gas, so 100 NEAR covers roughly 5,000 executions.
  [string]$Allowance = "100"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$keyFile = Join-Path $root "keeper\keeper-fc.key.json"
if (Test-Path $keyFile) { throw "$keyFile already exists. Delete it first if you really want a new key." }

# 1. Generate the key pair locally; keep a copy next to the keeper (gitignored, never uploaded).
Push-Location (Join-Path $root "keeper")
try { $json = node scripts/gen-key.mjs } finally { Pop-Location }
if ($LASTEXITCODE -ne 0 -or -not $json) { throw "key generation failed" }
[IO.File]::WriteAllText($keyFile, $json)
$kp = $json | ConvertFrom-Json
Write-Host "New restricted key: $($kp.public_key)" -ForegroundColor Green

# 2. Register it on the keeper account, limited to execute/expire on the contract.
& near add-key $KeeperId $kp.public_key --contractId $ContractId --methodNames execute expire --allowance $Allowance --networkId $Network
if ($LASTEXITCODE -ne 0) { throw "near add-key failed; nothing was changed on Railway" }

# 3. Point the Railway keeper at the new key (Railway redeploys automatically).
Push-Location $root
try {
  & railway variables --service keeper --set "KEEPER_PRIVATE_KEY=$($kp.private_key)"
  if ($LASTEXITCODE -ne 0) { throw "railway variables failed; the new key is added on-chain but Railway still uses the old one" }
} finally {
  Pop-Location
  Remove-Variable kp, json -ErrorAction SilentlyContinue
}

Write-Host "`nDone. Railway is redeploying with the restricted key." -ForegroundColor Green
Write-Host "Check: railway logs --service keeper   (should say 'as $KeeperId', not 'dry run')"
Write-Host "Local copy of the restricted key: $keyFile"
