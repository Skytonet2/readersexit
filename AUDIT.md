# readersEXIT security review

Internal review of `contract/src/lib.rs` plus the keeper and deployment setup, done
2026-09-29. **This is not a professional audit.** Get one before promoting widely.

Live contract: `readersexit.near` · code hash `2WZ9xNDd8yJoKGtzjoN2sBBV8mgfPont8tyEx41CZq9B`
(owner `skyto.near`, 1% fee to `readersofee.near`). 15/15 unit tests pass.

## Fixed (deployed)

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | `amount_out * fee_bps` overflows u128 above ~3.4e36 raw output (cheap 24-decimal memes). The panic lands in `on_executed` *after* the swap succeeded, stranding the order in `Executing` with its output uncredited. | 256-bit `mul_div`; `filled_out` uses saturating add. Test: 1e38 output. |
| 2 | Medium | `promise_result_checked(.., 1024).is_ok()` treated a successful result longer than 1 KB as a failure. | `promise_ok()` treats only `PromiseError::Failed` as failure. |
| 3 | Medium | Settlement callbacks (`on_order_funded`, `on_executed`) had 15 Tgas; running out strands funds. | 30 Tgas (`GAS_SETTLE_CALLBACK`). |
| 4 | Medium | A malicious listed token can call `ft_on_transfer` with a spoofed `sender_id`, and anyone could `expire`. Together: unbounded junk balances written into a victim's account until their orders can't settle. | `expire` restricted to keepers, owner and the order owner. |
| 5 | Low | Admin methods didn't require 1 yoctoNEAR, so a function-call key could call them. | `assert_one_yocto` on `remove_token`, `redeposit_to_ref`, `add_keeper`, `remove_keeper`, `set_fee`, `set_paused`, `set_owner`. |

## Mitigated off-chain

| # | Severity | Finding | Status |
|---|---|---|---|
| 7b | High | DCA orders without a max price rely on the keeper's slippage bound. | Web app: one-click max-price presets (+10/25/50%) and a warning when none is set. |
| 8 | Medium | Balance entries and treasury credits grow storage that nobody pays for. | Keeper logs a `WARNING` when the contract has < 1 NEAR free (currently 2.0) or the keeper < 0.3 NEAR (currently 0.98). Check with `railway logs --service keeper`. |
| — | Medium | Public RPC rate limits stalled the keeper. | Keeper uses paid FastNEAR with free failover; auth errors fail over too; keys never appear in logs. |

## Open: needs the owner

### 6. Contract full-access key — Critical (trust)
`readersexit.near` holds a full-access key stored as a plain file on the owner's PC
(`~/.near-credentials/mainnet/readersexit.near.json`). Whoever has that file can deploy
new code and take all escrowed funds.
- **Now:** back up that file offline; keep it off shared or cloud-synced folders.
- **When stable:** either move control to a multisig (upgrades need several signers),
  or delete the key so the code can never change:
  `near delete-key readersexit.near <public key> --networkId mainnet`.
  Deleting is **irreversible**: no more bug fixes or listings via redeploy. Only do it
  after a professional audit.

### 7. Keeper full-access key on Railway — High · **Done 2026-09-29**
Railway now holds function-call key `ed25519:3P2me7barRfTJJusQnZTGGCgmBc6HMWC37nt2wiT9UHJ`
(receiver `readersexit.near`, methods `execute`/`expire`, 100 NEAR allowance). The
full-access key `ed25519:4B6x…5k6X` exists only on the owner's PC. To rotate again:
```powershell
.\scripts\rotate-keeper-key.ps1
```
It generates a key limited to `execute` / `expire` on `readersexit.near` (100 NEAR gas
allowance), adds it on-chain, and sets it on Railway. The full-access key stays on this
PC as the recovery key. Re-run with a new key when the allowance runs low.

### 9. wNEAR withdrawals — **Verified 2026-09-29**
Withdrawals pass `skip_unwrap_near: true` to Ref. Confirmed on mainnet: `skyto.near`
withdrew 4.8908 wNEAR and the contract emitted its success event (`withdraw`, emitted only
after the transfer to the user succeeds), so Ref returned wNEAR, not native NEAR.
Meme withdrawals (4illia, two claims) also succeeded.

### Low, accepted
- Anyone can spam failing `execute` calls on a limit order, blocking cancel for ~2 blocks at a time.
- A token with a non-standard `ft_resolve_transfer` can orphan its own deposits (only that token).
- `set_owner` is single-step: double-check the account ID.
- Anyone can create spoofed (worthless) orders against a victim via a malicious listed token,
  using up their order slots; the victim can cancel them.
