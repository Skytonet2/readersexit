# Deploy + configure readersEXIT with the JS near-cli (npm i -g near-cli).
#
#   .\contract\deploy.ps1
#   .\contract\deploy.ps1 -ContractId readersexit.skyto.near -FeeBps 10
#   .\contract\deploy.ps1 -Resume     # already initialized: upgrade code, then list tokens + keeper
#
# Prerequisites: both accounts' keys in ~/.near-credentials/<network>/
#   (owner: `near login --networkId mainnet`; contract: created with `near create-account`).
param(
  [string]$Network = "mainnet",
  [string]$ContractId = "readersexit.near",
  [string]$OwnerId = "skyto.near",
  [string]$KeeperId = "keeper.skyto.near",
  [int]$FeeBps = 0,
  [string[]]$Tokens,
  [switch]$Resume
)
$ErrorActionPreference = "Stop"

if ($Network -eq "mainnet") {
  $RefId = "v2.ref-finance.near"
  if (-not $Tokens) {
    $Tokens = @("wrap.near", "usdt.tether-token.near", "blackdragon.tkn.near", "ftv2.nekotoken.near",
      "token.lonkingnearbackto2024.near", "token.0xshitzu.near", "intel.tkn.near", "slush.tkn.near", "hat.tkn.near")
  }
} else {
  $RefId = "ref-finance-101.testnet"
  if (-not $Tokens) { $Tokens = @("wrap.testnet") }
}

# PowerShell 5.1 strips bare double quotes from native-command arguments.
function Json($obj) { (ConvertTo-Json $obj -Compress -Depth 5) -replace '"', '\"' }

# Resolve the CLI itself (PowerShell function names are case-insensitive, so a helper
# named like the CLI would call itself).
$NearCli = (Get-Command near -CommandType ExternalScript, Application | Select-Object -First 1).Source
if (-not $NearCli) { throw "near-cli not found (npm i -g near-cli)" }

function Invoke-Near {
  & $NearCli @args
  if ($LASTEXITCODE -ne 0) { throw "near $($args[0]) failed" }
}

Push-Location $PSScriptRoot
try {
  cargo near build non-reproducible-wasm --no-abi
  if ($LASTEXITCODE -ne 0) { throw "build failed" }

  Write-Host "`n== Deploying to $ContractId" -ForegroundColor Green
  if ($Resume) {
    # Code-only upgrade; state (owner, Ref storage) is kept.
    Invoke-Near deploy $ContractId target/near/readers_exit.wasm --networkId $Network --force
  } else {
    $init = Json @{ owner_id = $OwnerId; ref_exchange_id = $RefId; fee_bps = $FeeBps }
    Invoke-Near deploy $ContractId target/near/readers_exit.wasm --initFunction new --initArgs $init --networkId $Network

    Write-Host "`n== Funding Ref storage" -ForegroundColor Green
    Invoke-Near call $ContractId ref_storage_deposit "{}" --useAccount $OwnerId --deposit 0.1 --gas 50000000000000 --networkId $Network
  }

  Write-Host "`n== Listing tokens" -ForegroundColor Green
  for ($i = 0; $i -lt $Tokens.Count; $i += 10) {
    $batch = @($Tokens[$i..([Math]::Min($i + 9, $Tokens.Count - 1))])
    $deposit = ($batch.Count * 0.00125).ToString([Globalization.CultureInfo]::InvariantCulture)
    Invoke-Near call $ContractId add_tokens (Json @{ token_ids = $batch }) --useAccount $OwnerId --deposit $deposit --gas 300000000000000 --networkId $Network
  }

  Write-Host "`n== Adding keeper $KeeperId" -ForegroundColor Green
  Invoke-Near call $ContractId add_keeper (Json @{ account_id = $KeeperId }) --useAccount $OwnerId --depositYocto 1 --networkId $Network

  Write-Host "`n== Done" -ForegroundColor Green
  Invoke-Near view $ContractId get_config "{}" --networkId $Network
} finally {
  Pop-Location
}
