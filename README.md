# readersEXIT

Limit orders and DCA for NEAR memecoins. Set your exit, stack the dip.

Users escrow tokens in the readersEXIT contract. Orders fill through Ref Finance
when the price is right (limit) or on a schedule (DCA). The contract enforces the
user's minimum output on-chain, so no executor can fill an order at a worse price.

```
readersEXIT/
├── contract/   Rust NEAR contract (near-sdk 5): escrow, order book, Ref execution
├── keeper/     Node bot that watches orders and executes them
├── web/        React + Vite app (wallet selector, order form, exit wall)
└── shared/     TS shared by web + keeper: RPC helpers, Ref router, types
```

## How it works

1. **Place an order.** The user calls `ft_transfer_call` on the input token with the
   readersEXIT contract as the receiver. The `msg` field carries the order:
   ```json
   {"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"…","expires_at_sec":null}
   {"type":"dca","token_out":"blackdragon.tkn.near","amount_per_swap":"…","interval_sec":3600,"min_out_per_swap":null,"start_at_sec":null}
   ```
   The contract forwards the tokens to its own deposit on Ref. If that fails, the
   user is refunded in the same transaction.
2. **Execute.** `execute(order_id, route, min_amount_out)` calls `ref.swap` with a
   1–3 hop route. The last hop's `min_amount_out` is the larger of the user's
   minimum (grossed up for the protocol fee) and the executor's value.
   - Limit orders: **anyone** can execute them, because the price is enforced by the contract.
   - DCA orders: **keepers only**, because the keeper supplies the slippage bound.
     An optional `min_out_per_swap` gives the user a max-price guard.
3. **Claim.** Proceeds go to an internal ledger. `withdraw(token_id)` pulls them from
   Ref and sends them to the user. If the user isn't registered on that token, the
   transfer fails and the balance is re-credited. `cancel` and `expire` move the
   unspent input back to the same claimable balance.

Storage: users keep a refundable NEAR deposit (0.05 NEAR, plus 0.01 per open order).
The web app adds it automatically on the first order.

## Contract

```bash
cd contract
cargo test                                   # unit tests
cargo near build reproducible-wasm           # verifiable build in Docker -> target/near/readers_exit.wasm
```

Deploy **only reproducible builds** to mainnet. They run inside the pinned
`sourcescan/cargo-near` image in `Cargo.toml`. Anyone can rebuild the exact deployed
wasm from the commit that `contract_source_metadata` points to. The build also embeds
the ABI, so NearBlocks can show typed methods. Commit and push before building,
because the metadata records the commit hash.

On Windows, unit tests need `AWS_LC_SYS_PREBUILT_NASM=1`. Quick local
`non-reproducible-wasm` builds also need `--no-abi`, because ABI generation can't link
on MSVC (the Docker build doesn't have this problem).

To verify on NearBlocks, go to the contract page, then **Contract Code → Verify and Publish**.
### Deploy

```powershell
.\contract\deploy.ps1   # defaults: readersexit.near, owner skyto.near, keeper keeper.skyto.near, mainnet
```

This deploys the contract and funds its Ref storage. It then lists the default
tokens: wNEAR, USDt, BLACKDRAGON, NEKO, LONK, SHITZU, INTEL, SLUSH and HAT. Override
the list with `-Tokens a.near,b.near`.

**Any token can be listed by anyone**, including brand-new launches from meme.cooking,
tkn.near and similar launchpads. Call `list_token(token_id, token_storage?)` and attach
the token's storage minimum plus 0.005 NEAR for Ref storage (about 0.0063 NEAR in total).
The contract registers itself on the token and on Ref, then lists the token. If the
account isn't a token, the deposit is refunded. The web app searches every token Ref
knows about, accepts any pasted contract ID, and offers the listing on first use.

Owner methods (all except `add_tokens` / `ref_storage_deposit` require exactly 1 yoctoNEAR attached, e.g. `--depositYocto 1`): `add_tokens`, `remove_token`, `add_keeper`, `remove_keeper`,
`set_fee` (max 1%; live at 1% to `skyto.near`), `set_paused`, `set_owner`, `ref_storage_deposit`, and
`redeposit_to_ref` (recovery).

Views: `get_config`, `get_tokens`, `get_orders`, `get_order`,
`get_account_orders`, `get_balances`, `storage_balance_of`, `get_keepers`.

## Keeper

```bash
cd keeper
cp .env.example .env     # set CONTRACT_ID, KEEPER_ACCOUNT_ID, KEEPER_PRIVATE_KEY
npm install
npm start
```

Every `POLL_MS`, the keeper loads the open orders and quotes each one against Ref.
It checks direct pools plus 2-hop routes through wNEAR, USDt and USDC, all read
on-chain. It executes when the limit is reachable or a DCA slice is due, sets
`min_amount_out` to the quote minus `SLIPPAGE_BPS`, and closes expired limit
orders. Without keys it runs in dry-run mode and only logs what it would do.

Register the keeper account with `add_keeper` so it can run DCA orders.

## Web

```bash
cd web
cp .env.example .env     # VITE_NETWORK, VITE_CONTRACT_ID
npm install
npm run dev
```

- **Limit**: pick a pair and set a price (shown as "1 meme = P NEAR"). Nudge
  buttons move the price relative to market, and you can set an expiry.
- **DCA**: set the total, the number of buys, the interval and an optional max price.
- **Exit wall**: all resting limit orders on the pair. Asks are exits, bids are dip-buys.
- **Your orders / Claimable**: progress, cancel-and-withdraw, claim, unwrap wNEAR.

If the contract isn't deployed yet, the app still loads live Ref quotes for the
default meme list. Placing orders stays disabled until the contract is live.

## Indexer & API

The same image runs as a second Railway service with `ROLE=indexer`. It uses Railway
Postgres, reads every contract event from FastNEAR's transaction API (only settled,
successful receipts), and serves `readersexit.com/api/*` through a Vercel rewrite:

| Endpoint | Returns |
|---|---|
| `/api/stats` | traders, orders, fills, total USD volume |
| `/api/leaderboard?campaign=<id>` | top 100 by USD volume (all-time without `campaign`) |
| `/api/campaigns` | campaigns with `upcoming` / `active` / `ended` status |
| `/api/profile/<account>` | volume, fills, fees, referrer, referral earnings, campaign rank |
| `/api/history/<account>?before=<iso>` | the account's events, newest first |
| `/api/referrals/<account>` | traders referred, their volume, what you earned |

**Volume rule** (resists wash trading and manipulated prices): a fill against
NEAR/USDt/USDC counts the NEAR/stable amount actually moved. Meme-to-meme fills count
the lower of the two sides. Anything that can't be priced on both sides counts as zero.

**Competitions** are one-off campaigns in the indexer's `CAMPAIGNS` variable (JSON, see
`keeper/.env.example`). Edit it in Railway and the leaderboard updates without a code
deploy. Prizes are paid manually.

## Referrals

`?ref=<account>` links are remembered in the browser (first link wins). They're bound
on-chain by `set_referrer` in the user's next contract transaction. The user always
signs it themselves, so order messages can never bind a referrer (malicious tokens
could spoof them). From then on, `referral_share_bps` (default 5000 = half) of the 1%
fee on every fill goes straight to the referrer's claimable balance.

## Notes

- Execution and quotes use Ref v2 (`v2.ref-finance.near`) `swap` / `get_return`.
- Default RPC is FastNEAR's free endpoint. Set `RPC_URL` / `VITE_RPC_URL` for production.
- The contract is unaudited. Get it reviewed before holding real user funds.
