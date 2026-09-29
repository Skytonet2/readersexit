//! readersEXIT — limit orders & DCA for NEAR memecoins.
//!
//! Custody model:
//! - Users deposit a token with `ft_transfer_call` whose `msg` describes the order.
//! - The contract forwards the tokens into its own internal account on Ref Finance.
//! - Executors call `execute` with a Ref route; the contract calls `ref.swap` with a
//!   `min_amount_out` derived from the user's order, so an executor can never fill
//!   an order below the user's price.
//! - Proceeds are credited to an internal ledger and claimed with `withdraw`.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas,
    NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(50);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_REF_SWAP: Gas = Gas::from_tgas(80);
const GAS_REF_WITHDRAW: Gas = Gas::from_tgas(60);
const GAS_REF_REGISTER: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
/// Callbacks that settle funds get extra headroom: running out of gas there would
/// leave an order stuck in Funding/Executing with its tokens unaccounted.
const GAS_SETTLE_CALLBACK: Gas = Gas::from_tgas(30);
const GAS_ON_USER_TRANSFER: Gas = Gas::from_tgas(65);
const GAS_ON_REF_WITHDRAWN: Gas = Gas::from_tgas(90);
const GAS_ON_LIST_STORAGE: Gas = Gas::from_tgas(45);

/// Minimum NEAR a user keeps on deposit to use the platform.
const MIN_ACCOUNT_STORAGE: u128 = NearToken::from_millinear(50).as_yoctonear();
/// NEAR locked per open order (released when the order closes).
const ORDER_STORAGE: u128 = NearToken::from_millinear(10).as_yoctonear();
/// NEP-145 registration cost paid to token contracts when listing a token.
const TOKEN_STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// Covers one more token in this contract's internal Ref account.
const REF_STORAGE_PER_TOKEN: u128 = NearToken::from_millinear(5).as_yoctonear();
const MAX_TOKEN_STORAGE: u128 = NearToken::from_millinear(100).as_yoctonear();

const MAX_OPEN_ORDERS: usize = 50;
const MAX_HOPS: usize = 3;
const MIN_DCA_INTERVAL_SEC: u64 = 60;
const MAX_FEE_BPS: u16 = 100;
const BPS: u128 = 10_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Keepers,
    Tokens,
    Orders,
    Accounts,
    // Append only: variants are storage prefixes, reordering would orphan data.
    Referrers,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum OrderStatus {
    /// Tokens received, being forwarded to Ref.
    Funding,
    /// Waiting for execution.
    Open,
    /// A swap is in flight.
    Executing,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OrderKind {
    /// Swap the whole amount once `amount_in -> >= min_amount_out` is possible.
    Limit {
        min_amount_out: U128,
        expires_at_sec: Option<u64>,
    },
    /// Swap `amount_per_swap` every `interval_sec` until the deposit is used up.
    /// `min_out_per_swap` (0 = none) acts as a max-price guard.
    Dca {
        amount_per_swap: U128,
        interval_sec: u64,
        min_out_per_swap: U128,
        next_exec_at_sec: u64,
        swaps_done: u32,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub owner_id: AccountId,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub remaining_in: U128,
    pub filled_out: U128,
    pub kind: OrderKind,
    pub status: OrderStatus,
    pub created_at_sec: u64,
}

/// The `msg` passed to `ft_transfer_call`.
#[near(serializers = [json])]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OrderRequest {
    Limit {
        token_out: AccountId,
        min_amount_out: U128,
        expires_at_sec: Option<u64>,
    },
    Dca {
        token_out: AccountId,
        amount_per_swap: U128,
        interval_sec: u64,
        min_out_per_swap: Option<U128>,
        start_at_sec: Option<u64>,
    },
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RouteHop {
    pub pool_id: u64,
    pub token_out: AccountId,
}

/// Ref Finance `SwapAction`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SwapAction {
    pub pool_id: u64,
    pub token_in: AccountId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_in: Option<U128>,
    pub token_out: AccountId,
    pub min_amount_out: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Account {
    pub storage_deposit: u128,
    pub order_ids: Vec<u64>,
    pub balances: BTreeMap<AccountId, u128>,
}

impl Account {
    fn storage_locked(&self) -> u128 {
        MIN_ACCOUNT_STORAGE + self.order_ids.len() as u128 * ORDER_STORAGE
    }
    fn storage_available(&self) -> u128 {
        self.storage_deposit.saturating_sub(self.storage_locked())
    }
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct TokenBalance {
    pub token_id: AccountId,
    pub balance: U128,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub ref_exchange_id: AccountId,
    pub treasury_id: AccountId,
    pub fee_bps: u16,
    pub paused: bool,
    pub next_order_id: u64,
    pub open_orders: u32,
    pub min_account_storage: U128,
    pub order_storage: U128,
    pub referral_share_bps: u16,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128>;
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[ext_contract(ext_ref)]
#[allow(dead_code)]
trait RefExchange {
    fn swap(&mut self, actions: Vec<SwapAction>, referral_id: Option<AccountId>) -> U128;
    fn withdraw(
        &mut self,
        token_id: AccountId,
        amount: U128,
        unregister: Option<bool>,
        skip_unwrap_near: Option<bool>,
    );
    fn register_tokens(&mut self, token_ids: Vec<AccountId>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    ref_exchange_id: AccountId,
    treasury_id: AccountId,
    fee_bps: u16,
    paused: bool,
    next_order_id: u64,
    keepers: IterableSet<AccountId>,
    tokens: IterableSet<AccountId>,
    orders: IterableMap<u64, Order>,
    accounts: LookupMap<AccountId, Account>,
    /// user -> referrer, set once on the user's first order that names one.
    referrers: LookupMap<AccountId, AccountId>,
    /// Share of the protocol fee paid to the user's referrer (5000 = half).
    referral_share_bps: u16,
}

/// State layout before referrals (v1, deployed until the referral upgrade).
/// Only read by `migrate`; keep until every deployment has migrated.
#[near(serializers = [borsh])]
struct ContractV1 {
    owner_id: AccountId,
    ref_exchange_id: AccountId,
    treasury_id: AccountId,
    fee_bps: u16,
    paused: bool,
    next_order_id: u64,
    keepers: IterableSet<AccountId>,
    tokens: IterableSet<AccountId>,
    orders: IterableMap<u64, Order>,
    accounts: LookupMap<AccountId, Account>,
}

const DEFAULT_REFERRAL_SHARE_BPS: u16 = 5_000;

fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

uint::construct_uint! {
    pub struct U256(4);
}

/// a * b / c with a 256-bit intermediate (meme tokens often have 24 decimals).
fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(c)).as_u128()
}

fn is_promise_success() -> bool {
    require!(env::promise_results_count() == 1, "Expected one promise result");
    promise_ok(0)
}

/// Only an actual failure counts: a successful result longer than the read limit
/// (`TooLong`) is still a success.
fn promise_ok(index: u64) -> bool {
    !matches!(env::promise_result_checked(index, 1024), Err(PromiseError::Failed))
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "readersexit", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        ref_exchange_id: AccountId,
        treasury_id: Option<AccountId>,
        fee_bps: Option<u16>,
    ) -> Self {
        let fee_bps = fee_bps.unwrap_or(0);
        require!(fee_bps <= MAX_FEE_BPS, "Fee too high");
        Self {
            treasury_id: treasury_id.unwrap_or_else(|| owner_id.clone()),
            owner_id,
            ref_exchange_id,
            fee_bps,
            paused: false,
            next_order_id: 0,
            keepers: IterableSet::new(StorageKey::Keepers),
            tokens: IterableSet::new(StorageKey::Tokens),
            orders: IterableMap::new(StorageKey::Orders),
            accounts: LookupMap::new(StorageKey::Accounts),
            referrers: LookupMap::new(StorageKey::Referrers),
            referral_share_bps: DEFAULT_REFERRAL_SHARE_BPS,
        }
    }

    /// One-time upgrade from the v1 layout: keeps every collection (same storage
    /// prefixes) and adds referrals. Call via deploy + `migrate` in one transaction.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV1 = env::state_read().unwrap_or_else(|| env::panic_str("No v1 state to migrate"));
        Self {
            owner_id: old.owner_id,
            ref_exchange_id: old.ref_exchange_id,
            treasury_id: old.treasury_id,
            fee_bps: old.fee_bps,
            paused: old.paused,
            next_order_id: old.next_order_id,
            keepers: old.keepers,
            tokens: old.tokens,
            orders: old.orders,
            accounts: old.accounts,
            referrers: LookupMap::new(StorageKey::Referrers),
            referral_share_bps: DEFAULT_REFERRAL_SHARE_BPS,
        }
    }

    // ---------------------------------------------------------------- storage

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> StorageBalance {
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let mut acc = self.accounts.get(&account_id).cloned().unwrap_or_default();
        acc.storage_deposit += env::attached_deposit().as_yoctonear();
        require!(
            acc.storage_deposit >= MIN_ACCOUNT_STORAGE,
            "Minimum storage deposit is 0.05 NEAR"
        );
        let balance = Self::storage_balance(&acc);
        self.accounts.insert(account_id, acc);
        balance
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let mut acc = self.get_account(&account_id);
        let available = acc.storage_available();
        let amount = amount.map(|a| a.0).unwrap_or(available);
        require!(amount <= available, "Amount exceeds available storage balance");
        acc.storage_deposit -= amount;
        let balance = Self::storage_balance(&acc);
        self.accounts.insert(account_id.clone(), acc);
        if amount > 0 {
            Promise::new(account_id).transfer(NearToken::from_yoctonear(amount)).detach();
        }
        balance
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.get(&account_id).map(Self::storage_balance)
    }

    // ------------------------------------------------------------- orders

    /// NEP-141 receiver. `msg` is a JSON `OrderRequest`.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(!self.paused, "readersEXIT is paused");
        let token_in = env::predecessor_account_id();
        require!(self.tokens.contains(&token_in), "Token is not listed");
        require!(amount.0 > 0, "Amount must be positive");
        let request: OrderRequest =
            serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("Invalid order msg"));

        let mut acc = self.accounts.get(&sender_id).cloned().unwrap_or_else(|| {
            env::panic_str("Account not registered: call storage_deposit first")
        });
        require!(acc.order_ids.len() < MAX_OPEN_ORDERS, "Too many open orders");
        require!(
            acc.storage_available() >= ORDER_STORAGE,
            "Insufficient storage deposit for a new order"
        );

        let now = now_sec();
        let (token_out, kind) = match request {
            OrderRequest::Limit { token_out, min_amount_out, expires_at_sec } => {
                require!(min_amount_out.0 > 0, "min_amount_out must be positive");
                if let Some(exp) = expires_at_sec {
                    require!(exp > now, "Expiry is in the past");
                }
                (token_out, OrderKind::Limit { min_amount_out, expires_at_sec })
            }
            OrderRequest::Dca {
                token_out,
                amount_per_swap,
                interval_sec,
                min_out_per_swap,
                start_at_sec,
            } => {
                require!(
                    amount_per_swap.0 > 0 && amount_per_swap.0 <= amount.0,
                    "Invalid amount_per_swap"
                );
                require!(interval_sec >= MIN_DCA_INTERVAL_SEC, "Interval too short");
                (
                    token_out,
                    OrderKind::Dca {
                        amount_per_swap,
                        interval_sec,
                        min_out_per_swap: min_out_per_swap.unwrap_or(U128(0)),
                        next_exec_at_sec: start_at_sec.unwrap_or(now).max(now),
                        swaps_done: 0,
                    },
                )
            }
        };
        require!(self.tokens.contains(&token_out), "Output token is not listed");
        require!(token_out != token_in, "token_in and token_out must differ");

        let id = self.next_order_id;
        self.next_order_id += 1;
        let order = Order {
            id,
            owner_id: sender_id.clone(),
            token_in: token_in.clone(),
            token_out,
            amount_in: amount,
            remaining_in: amount,
            filled_out: U128(0),
            kind,
            status: OrderStatus::Funding,
            created_at_sec: now,
        };
        acc.order_ids.push(id);
        self.accounts.insert(sender_id, acc);
        self.orders.insert(id, order);

        PromiseOrValue::Promise(
            ext_ft::ext(token_in)
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER_CALL)
                .ft_transfer_call(self.ref_exchange_id.clone(), amount, None, String::new())
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_SETTLE_CALLBACK)
                        .on_order_funded(id, amount),
                ),
        )
    }

    /// Returns the unused amount back to the token's `ft_resolve_transfer`,
    /// which refunds it to the user.
    #[private]
    pub fn on_order_funded(
        &mut self,
        order_id: u64,
        amount: U128,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> U128 {
        let used = used.map(|u| u.0).unwrap_or(0).min(amount.0);
        let mut order = self.orders.get(&order_id).cloned().expect("Order not found");
        if used == 0 {
            self.close_order(&order);
            emit("order_funding_failed", json!({ "order_id": order_id }));
            return amount;
        }
        order.amount_in = U128(used);
        order.remaining_in = U128(used);
        order.status = OrderStatus::Open;
        emit("order_created", json!(order));
        self.orders.insert(order_id, order);
        U128(amount.0 - used)
    }

    /// Execute (a slice of) an order through a Ref route.
    /// Limit orders can be executed by anyone — the contract enforces the price.
    /// DCA orders are keeper-only, since the keeper supplies the slippage bound.
    pub fn execute(
        &mut self,
        order_id: u64,
        route: Vec<RouteHop>,
        min_amount_out: Option<U128>,
    ) -> Promise {
        require!(!self.paused, "readersEXIT is paused");
        require!(!route.is_empty() && route.len() <= MAX_HOPS, "Route must have 1-3 hops");
        let mut order = self.orders.get(&order_id).cloned().expect("Order not found");
        require!(order.status == OrderStatus::Open, "Order is not open");

        let caller = env::predecessor_account_id();
        let now = now_sec();
        let (amount_in, user_min_net) = match &order.kind {
            OrderKind::Limit { min_amount_out, expires_at_sec } => {
                if let Some(exp) = expires_at_sec {
                    require!(now < *exp, "Order expired");
                }
                (order.remaining_in.0, min_amount_out.0)
            }
            OrderKind::Dca { amount_per_swap, min_out_per_swap, next_exec_at_sec, .. } => {
                require!(self.is_keeper(&caller), "Only keepers can execute DCA orders");
                require!(now >= *next_exec_at_sec, "DCA interval not reached");
                let amount = amount_per_swap.0.min(order.remaining_in.0);
                (amount, mul_div(min_out_per_swap.0, amount, amount_per_swap.0))
            }
        };
        // Users set their minimum net of protocol fee; gross it up for the swap.
        let user_min_gross = if self.fee_bps == 0 || user_min_net == 0 {
            user_min_net
        } else {
            let denom = BPS - self.fee_bps as u128;
            mul_div(user_min_net, BPS, denom) + 1
        };
        let final_min = user_min_gross.max(min_amount_out.map(|m| m.0).unwrap_or(0));
        require!(final_min > 0, "A positive min_amount_out is required");

        let mut actions = Vec::with_capacity(route.len());
        let mut token_in = order.token_in.clone();
        for (i, hop) in route.iter().enumerate() {
            let last = i + 1 == route.len();
            actions.push(SwapAction {
                pool_id: hop.pool_id,
                token_in: token_in.clone(),
                amount_in: if i == 0 { Some(U128(amount_in)) } else { None },
                token_out: hop.token_out.clone(),
                min_amount_out: U128(if last { final_min } else { 0 }),
            });
            token_in = hop.token_out.clone();
        }
        require!(token_in == order.token_out, "Route must end in the order's token_out");

        order.status = OrderStatus::Executing;
        self.orders.insert(order_id, order);

        ext_ref::ext(self.ref_exchange_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_REF_SWAP)
            .swap(actions, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SETTLE_CALLBACK)
                    .on_executed(order_id, U128(amount_in), caller),
            )
    }

    #[private]
    pub fn on_executed(
        &mut self,
        order_id: u64,
        amount_in: U128,
        executor_id: AccountId,
        #[callback_result] result: Result<U128, PromiseError>,
    ) -> U128 {
        let mut order = self.orders.get(&order_id).cloned().expect("Order not found");
        let amount_out = match result {
            Ok(out) => out.0,
            Err(_) => {
                order.status = OrderStatus::Open;
                self.orders.insert(order_id, order);
                emit("order_execution_failed", json!({ "order_id": order_id }));
                return U128(0);
            }
        };

        // 256-bit math: `amount_out * fee_bps` overflows u128 for low-priced 24-decimal
        // memes (~3.4e36 raw out), and a panic here would strand an already-executed swap.
        let fee = mul_div(amount_out, self.fee_bps as u128, BPS);
        let user_out = amount_out - fee;
        let owner = order.owner_id.clone();
        // Referrer's cut comes out of the protocol fee, never out of the user's output.
        let referrer = self.referrers.get(&owner).cloned();
        let referral_fee = match &referrer {
            Some(_) => mul_div(fee, self.referral_share_bps as u128, BPS),
            None => 0,
        };
        if let Some(r) = &referrer {
            self.credit(r, &order.token_out, referral_fee);
        }
        let treasury = self.treasury_id.clone();
        self.credit(&treasury, &order.token_out, fee - referral_fee);
        self.credit(&owner, &order.token_out, user_out);

        order.remaining_in = U128(order.remaining_in.0 - amount_in.0);
        // Display-only running total; must never panic in this callback.
        order.filled_out = U128(order.filled_out.0.saturating_add(user_out));
        emit(
            "order_executed",
            json!({
                "order_id": order_id,
                "owner_id": owner,
                "executor_id": executor_id,
                "token_in": order.token_in,
                "token_out": order.token_out,
                "amount_in": amount_in,
                "amount_out": U128(user_out),
                "fee": U128(fee),
                "referrer_id": referrer,
                "referral_fee": U128(referral_fee),
            }),
        );

        let done = match &mut order.kind {
            OrderKind::Limit { .. } => true,
            OrderKind::Dca { interval_sec, next_exec_at_sec, swaps_done, .. } => {
                *swaps_done += 1;
                *next_exec_at_sec = now_sec() + *interval_sec;
                order.remaining_in.0 == 0
            }
        };
        if done {
            // Dust left from a limit order (never, today) goes back to the owner.
            if order.remaining_in.0 > 0 {
                self.credit(&owner, &order.token_in, order.remaining_in.0);
            }
            self.close_order(&order);
            emit("order_completed", json!({ "order_id": order_id }));
        } else {
            order.status = OrderStatus::Open;
            self.orders.insert(order_id, order);
        }
        U128(user_out)
    }

    /// Cancel an open order; the unspent input becomes claimable via `withdraw`.
    #[payable]
    pub fn cancel(&mut self, order_id: u64) {
        assert_one_yocto();
        let order = self.orders.get(&order_id).cloned().expect("Order not found");
        require!(order.owner_id == env::predecessor_account_id(), "Not your order");
        self.refund_and_close(order, "order_cancelled");
    }

    /// Close an expired limit order; funds go to the owner's balance.
    /// Restricted to keepers and the order owner: otherwise anyone could pair spoofed
    /// orders (from a malicious listed token) with `expire` to bloat a victim's account.
    pub fn expire(&mut self, order_id: u64) {
        let order = self.orders.get(&order_id).cloned().expect("Order not found");
        let caller = env::predecessor_account_id();
        require!(
            caller == order.owner_id || self.is_keeper(&caller),
            "Only keepers or the order owner can expire"
        );
        match order.kind {
            OrderKind::Limit { expires_at_sec: Some(exp), .. } if now_sec() >= exp => {}
            _ => env::panic_str("Order has not expired"),
        }
        self.refund_and_close(order, "order_expired");
    }

    // ------------------------------------------------------------- withdrawals

    /// Withdraw a claimable balance to the caller's wallet.
    /// The caller must be storage-registered on the token contract.
    #[payable]
    pub fn withdraw(&mut self, token_id: AccountId, amount: Option<U128>) -> Promise {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let mut acc = self.get_account(&account_id);
        let balance = acc.balances.get(&token_id).copied().unwrap_or(0);
        let amount = amount.map(|a| a.0).unwrap_or(balance);
        require!(amount > 0 && amount <= balance, "Insufficient balance");
        if amount == balance {
            acc.balances.remove(&token_id);
        } else {
            acc.balances.insert(token_id.clone(), balance - amount);
        }
        self.accounts.insert(account_id.clone(), acc);

        ext_ref::ext(self.ref_exchange_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_REF_WITHDRAW)
            .withdraw(token_id.clone(), U128(amount), None, Some(true))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_REF_WITHDRAWN)
                    .on_ref_withdrawn(account_id, token_id, U128(amount)),
            )
    }

    #[private]
    pub fn on_ref_withdrawn(
        &mut self,
        account_id: AccountId,
        token_id: AccountId,
        amount: U128,
    ) -> PromiseOrValue<bool> {
        if !is_promise_success() {
            self.credit(&account_id, &token_id, amount.0);
            emit("withdraw_failed", json!({ "account_id": account_id, "token_id": token_id, "amount": amount }));
            return PromiseOrValue::Value(false);
        }
        PromiseOrValue::Promise(
            ext_ft::ext(token_id.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(account_id.clone(), amount, Some("readersEXIT withdrawal".into()))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_USER_TRANSFER)
                        .on_user_transfer(account_id, token_id, amount),
                ),
        )
    }

    #[private]
    pub fn on_user_transfer(&mut self, account_id: AccountId, token_id: AccountId, amount: U128) -> bool {
        if is_promise_success() {
            emit("withdraw", json!({ "account_id": account_id, "token_id": token_id, "amount": amount }));
            return true;
        }
        // Transfer failed (usually: user not registered on the token). Re-credit and
        // park the tokens back in Ref so the ledger stays backed.
        self.credit(&account_id, &token_id, amount.0);
        ext_ft::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(self.ref_exchange_id.clone(), amount, None, String::new())
            .detach();
        emit("withdraw_failed", json!({ "account_id": account_id, "token_id": token_id, "amount": amount }));
        false
    }

    // -------------------------------------------------------------- referrals

    /// Bind the caller's referrer. Permanent and first-wins; only the user can set their
    /// own (order messages are spoofable by malicious tokens, so they never bind).
    /// Returns false (no panic) if already bound, so it's safe to batch into any tx.
    pub fn set_referrer(&mut self, referrer_id: AccountId) -> bool {
        let user = env::predecessor_account_id();
        if referrer_id == user || self.referrers.contains_key(&user) {
            return false;
        }
        self.referrers.insert(user.clone(), referrer_id.clone());
        emit("referral_set", json!({ "account_id": user, "referrer_id": referrer_id }));
        true
    }

    pub fn get_referrer(&self, account_id: AccountId) -> Option<AccountId> {
        self.referrers.get(&account_id).cloned()
    }

    // ---------------------------------------------------------------- listing

    /// Permissionless listing of any NEP-141 token (including freshly launched ones).
    /// Attach `token_storage` (the token's `storage_balance_bounds().min`, default
    /// 0.00125 NEAR) plus 0.005 NEAR for this contract's storage on Ref.
    /// Anything that fails is refunded to the caller.
    #[payable]
    pub fn list_token(&mut self, token_id: AccountId, token_storage: Option<U128>) -> Promise {
        require!(!self.paused, "readersEXIT is paused");
        require!(!self.tokens.contains(&token_id), "Token already listed");
        let token_storage = token_storage.map(|s| s.0).unwrap_or(TOKEN_STORAGE.as_yoctonear());
        require!(token_storage <= MAX_TOKEN_STORAGE, "token_storage too high");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= token_storage + REF_STORAGE_PER_TOKEN,
            "Attach token_storage + 0.005 NEAR"
        );
        let ref_storage = attached - token_storage;
        ext_ft::ext(token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(token_storage))
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(env::current_account_id()), Some(true))
            .and(
                ext_ref::ext(self.ref_exchange_id.clone())
                    .with_attached_deposit(NearToken::from_yoctonear(ref_storage))
                    .with_static_gas(GAS_STORAGE_DEPOSIT)
                    .storage_deposit(Some(env::current_account_id()), None),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_LIST_STORAGE)
                    .on_list_storage(
                        token_id,
                        env::predecessor_account_id(),
                        U128(token_storage),
                        U128(ref_storage),
                    ),
            )
    }

    #[private]
    pub fn on_list_storage(
        &mut self,
        token_id: AccountId,
        lister_id: AccountId,
        token_storage: U128,
        ref_storage: U128,
    ) -> PromiseOrValue<bool> {
        let token_ok = promise_ok(0);
        let ref_ok = promise_ok(1);
        if !(token_ok && ref_ok) {
            // Failed receipts return their deposit to this contract; pass it back.
            let refund = if token_ok { 0 } else { token_storage.0 } + if ref_ok { 0 } else { ref_storage.0 };
            if refund > 0 {
                Promise::new(lister_id).transfer(NearToken::from_yoctonear(refund)).detach();
            }
            emit("token_list_failed", json!({ "token_id": token_id, "not_a_token": !token_ok }));
            return PromiseOrValue::Value(false);
        }
        PromiseOrValue::Promise(
            ext_ref::ext(self.ref_exchange_id.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_REF_REGISTER)
                .register_tokens(vec![token_id.clone()])
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_token_registered(token_id, lister_id),
                ),
        )
    }

    #[private]
    pub fn on_token_registered(&mut self, token_id: AccountId, lister_id: AccountId) -> bool {
        if !is_promise_success() {
            emit("token_list_failed", json!({ "token_id": token_id, "not_a_token": false }));
            return false;
        }
        self.tokens.insert(token_id.clone());
        emit("token_listed", json!({ "token_id": token_id, "lister_id": lister_id }));
        true
    }

    // ------------------------------------------------------------------ admin

    /// List tokens: registers this contract on each token and on Ref.
    /// Attach 0.00125 NEAR per token.
    #[payable]
    pub fn add_tokens(&mut self, token_ids: Vec<AccountId>) {
        self.assert_owner();
        require!(!token_ids.is_empty() && token_ids.len() <= 10, "1-10 tokens per call");
        require!(
            env::attached_deposit().as_yoctonear()
                >= TOKEN_STORAGE.as_yoctonear() * token_ids.len() as u128,
            "Attach 0.00125 NEAR per token"
        );
        // Independent fire-and-forget calls: the runtime forbids returning a joint (`and`) promise.
        ext_ref::ext(self.ref_exchange_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_REF_REGISTER)
            .register_tokens(token_ids.clone())
            .detach();
        for token_id in token_ids {
            self.tokens.insert(token_id.clone());
            ext_ft::ext(token_id)
                .with_attached_deposit(TOKEN_STORAGE)
                .with_static_gas(GAS_STORAGE_DEPOSIT)
                .storage_deposit(Some(env::current_account_id()), Some(true))
                .detach();
        }
    }

    #[payable]
    pub fn remove_token(&mut self, token_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.tokens.remove(&token_id);
    }

    /// Top up this contract's storage on Ref (needed before `add_tokens`).
    #[payable]
    pub fn ref_storage_deposit(&mut self) -> Promise {
        self.assert_owner();
        ext_ref::ext(self.ref_exchange_id.clone())
            .with_attached_deposit(env::attached_deposit())
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(env::current_account_id()), None)
    }

    /// Recovery: push stray tokens held by this contract back into Ref.
    #[payable]
    pub fn redeposit_to_ref(&mut self, token_id: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        ext_ft::ext(token_id)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(self.ref_exchange_id.clone(), amount, None, String::new())
    }

    #[payable]
    pub fn add_keeper(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.keepers.insert(account_id);
    }

    #[payable]
    pub fn remove_keeper(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.keepers.remove(&account_id);
    }

    #[payable]
    pub fn set_fee(&mut self, fee_bps: u16, treasury_id: Option<AccountId>) {
        assert_one_yocto();
        self.assert_owner();
        require!(fee_bps <= MAX_FEE_BPS, "Fee too high");
        self.fee_bps = fee_bps;
        if let Some(t) = treasury_id {
            self.treasury_id = t;
        }
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        assert_one_yocto();
        self.assert_owner();
        self.paused = paused;
    }

    #[payable]
    pub fn set_owner(&mut self, owner_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.owner_id = owner_id;
    }

    /// Share of the protocol fee paid to referrers (5000 = half of the fee).
    #[payable]
    pub fn set_referral_share(&mut self, referral_share_bps: u16) {
        assert_one_yocto();
        self.assert_owner();
        require!(referral_share_bps as u128 <= BPS, "Share cannot exceed 100% of the fee");
        self.referral_share_bps = referral_share_bps;
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            ref_exchange_id: self.ref_exchange_id.clone(),
            treasury_id: self.treasury_id.clone(),
            fee_bps: self.fee_bps,
            paused: self.paused,
            next_order_id: self.next_order_id,
            open_orders: self.orders.len(),
            min_account_storage: U128(MIN_ACCOUNT_STORAGE),
            order_storage: U128(ORDER_STORAGE),
            referral_share_bps: self.referral_share_bps,
        }
    }

    pub fn get_tokens(&self) -> Vec<AccountId> {
        self.tokens.iter().cloned().collect()
    }

    pub fn get_keepers(&self) -> Vec<AccountId> {
        self.keepers.iter().cloned().collect()
    }

    pub fn get_order(&self, order_id: u64) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    pub fn get_orders(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Order> {
        self.orders
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .cloned()
            .collect()
    }

    pub fn get_account_orders(&self, account_id: AccountId) -> Vec<Order> {
        self.accounts
            .get(&account_id)
            .map(|acc| acc.order_ids.iter().filter_map(|id| self.orders.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    pub fn get_balances(&self, account_id: AccountId) -> Vec<TokenBalance> {
        self.accounts
            .get(&account_id)
            .map(|acc| {
                acc.balances
                    .iter()
                    .map(|(t, b)| TokenBalance { token_id: t.clone(), balance: U128(*b) })
                    .collect()
            })
            .unwrap_or_default()
    }

    // --------------------------------------------------------------- internal

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Owner only");
    }

    fn is_keeper(&self, account_id: &AccountId) -> bool {
        *account_id == self.owner_id || self.keepers.contains(account_id)
    }

    fn get_account(&self, account_id: &AccountId) -> Account {
        self.accounts
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Account not registered"))
    }

    fn storage_balance(acc: &Account) -> StorageBalance {
        StorageBalance { total: U128(acc.storage_deposit), available: U128(acc.storage_available()) }
    }

    fn credit(&mut self, account_id: &AccountId, token_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let mut acc = self.accounts.get(account_id).cloned().unwrap_or_default();
        *acc.balances.entry(token_id.clone()).or_insert(0) += amount;
        self.accounts.insert(account_id.clone(), acc);
    }

    fn close_order(&mut self, order: &Order) {
        self.orders.remove(&order.id);
        if let Some(acc) = self.accounts.get_mut(&order.owner_id) {
            acc.order_ids.retain(|id| *id != order.id);
        }
    }

    fn refund_and_close(&mut self, order: Order, event: &str) {
        require!(order.status == OrderStatus::Open, "Order is busy, try again shortly");
        self.credit(&order.owner_id, &order.token_in, order.remaining_in.0);
        self.close_order(&order);
        emit(event, json!({ "order_id": order.id, "refunded": order.remaining_in }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: AccountId, deposit: u128, ts_sec: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("readersexit.near"))
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts_sec * 1_000_000_000);
        testing_env!(b.build());
    }

    fn setup() -> Contract {
        ctx(accounts(0), 0, 1_000);
        let mut c = Contract::new(accounts(0), acc("v2.ref-finance.near"), None, Some(30));
        c.tokens.insert(acc("wrap.near"));
        c.tokens.insert(acc("blackdragon.tkn.near"));
        ctx(accounts(1), MIN_ACCOUNT_STORAGE + ORDER_STORAGE * 2, 1_000);
        c.storage_deposit(None);
        c
    }

    fn create(c: &mut Contract, msg: serde_json::Value, amount: u128) -> u64 {
        ctx(acc("wrap.near"), 0, 1_000);
        let _ = c.ft_on_transfer(accounts(1), U128(amount), msg.to_string());
        let id = c.next_order_id - 1;
        ctx(acc("readersexit.near"), 0, 1_000);
        let unused = c.on_order_funded(id, U128(amount), Ok(U128(amount)));
        assert_eq!(unused.0, 0);
        id
    }

    #[test]
    fn limit_order_lifecycle() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"1000000"}),
            100,
        );
        assert_eq!(c.get_order(id).unwrap().status, OrderStatus::Open);

        ctx(accounts(3), 0, 1_001);
        let hop = RouteHop { pool_id: 7, token_out: acc("blackdragon.tkn.near") };
        let _ = c.execute(id, vec![hop], None);
        assert_eq!(c.get_order(id).unwrap().status, OrderStatus::Executing);

        ctx(acc("readersexit.near"), 0, 1_001);
        let out = c.on_executed(id, U128(100), accounts(3), Ok(U128(2_000_000)));
        assert_eq!(out.0, 2_000_000 - 6_000); // 30 bps
        assert!(c.get_order(id).is_none());
        let bal = c.get_balances(accounts(1));
        assert_eq!(bal[0].balance.0, 1_994_000);
        assert_eq!(c.get_balances(accounts(0))[0].balance.0, 6_000);
    }

    #[test]
    fn failed_swap_reopens_order() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"5"}),
            100,
        );
        ctx(accounts(3), 0, 1_001);
        let _ = c.execute(id, vec![RouteHop { pool_id: 1, token_out: acc("blackdragon.tkn.near") }], None);
        ctx(acc("readersexit.near"), 0, 1_001);
        c.on_executed(id, U128(100), accounts(3), Err(PromiseError::Failed));
        assert_eq!(c.get_order(id).unwrap().status, OrderStatus::Open);
    }

    #[test]
    #[should_panic(expected = "Route must end")]
    fn route_must_end_in_token_out() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"5"}),
            100,
        );
        ctx(accounts(3), 0, 1_001);
        let _ = c.execute(id, vec![RouteHop { pool_id: 1, token_out: acc("usdt.tether-token.near") }], None);
    }

    #[test]
    fn dca_runs_in_slices() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"dca","token_out":"blackdragon.tkn.near","amount_per_swap":"40","interval_sec":3600}),
            100,
        );
        let hop = || vec![RouteHop { pool_id: 7, token_out: acc("blackdragon.tkn.near") }];
        for (i, t) in [1_000u64, 4_600, 8_200].iter().enumerate() {
            ctx(accounts(0), 0, *t);
            let _ = c.execute(id, hop(), Some(U128(1)));
            ctx(acc("readersexit.near"), 0, *t);
            c.on_executed(id, U128(if i < 2 { 40 } else { 20 }), accounts(0), Ok(U128(10_000)));
        }
        assert!(c.get_order(id).is_none());
    }

    #[test]
    #[should_panic(expected = "DCA interval not reached")]
    fn dca_respects_interval() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"dca","token_out":"blackdragon.tkn.near","amount_per_swap":"40","interval_sec":3600}),
            100,
        );
        let hop = || vec![RouteHop { pool_id: 7, token_out: acc("blackdragon.tkn.near") }];
        ctx(accounts(0), 0, 1_000);
        let _ = c.execute(id, hop(), Some(U128(1)));
        ctx(acc("readersexit.near"), 0, 1_000);
        c.on_executed(id, U128(40), accounts(0), Ok(U128(10)));
        ctx(accounts(0), 0, 1_100);
        let _ = c.execute(id, hop(), Some(U128(1)));
    }

    #[test]
    #[should_panic(expected = "Only keepers")]
    fn dca_is_keeper_only() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"dca","token_out":"blackdragon.tkn.near","amount_per_swap":"40","interval_sec":3600}),
            100,
        );
        ctx(accounts(4), 0, 1_000);
        let _ = c.execute(id, vec![RouteHop { pool_id: 7, token_out: acc("blackdragon.tkn.near") }], Some(U128(1)));
    }

    #[test]
    fn cancel_credits_remaining_and_frees_storage() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"5"}),
            100,
        );
        assert_eq!(c.storage_balance_of(accounts(1)).unwrap().available.0, ORDER_STORAGE);
        ctx(accounts(1), 1, 1_001);
        c.cancel(id);
        assert_eq!(c.get_balances(accounts(1))[0].balance.0, 100);
        assert_eq!(c.storage_balance_of(accounts(1)).unwrap().available.0, ORDER_STORAGE * 2);
    }

    fn ctx_with_results(results: Vec<near_sdk::PromiseResult>) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("readersexit.near"))
            .predecessor_account_id(acc("readersexit.near"))
            .block_timestamp(1_000 * 1_000_000_000);
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    #[test]
    fn permissionless_listing() {
        let mut c = setup();
        let new_meme = acc("fresh.meme-cooking.near");
        ctx(accounts(4), TOKEN_STORAGE.as_yoctonear() + REF_STORAGE_PER_TOKEN, 1_000);
        let _ = c.list_token(new_meme.clone(), None);
        assert!(!c.tokens.contains(&new_meme), "not listed until registered on Ref");

        let ok = || near_sdk::PromiseResult::Successful(b"{}".to_vec());
        ctx_with_results(vec![ok(), ok()]);
        let _ = c.on_list_storage(new_meme.clone(), accounts(4), U128(1), U128(1));
        ctx_with_results(vec![ok()]);
        assert!(c.on_token_registered(new_meme.clone(), accounts(4)));
        assert!(c.get_tokens().contains(&new_meme));
    }

    #[test]
    fn listing_a_non_token_fails() {
        let mut c = setup();
        let ok = near_sdk::PromiseResult::Successful(b"{}".to_vec());
        ctx_with_results(vec![near_sdk::PromiseResult::Failed, ok]);
        match c.on_list_storage(acc("not-a-token.near"), accounts(4), U128(1), U128(1)) {
            PromiseOrValue::Value(listed) => assert!(!listed),
            _ => panic!("expected no follow-up promise"),
        }
        assert!(!c.get_tokens().contains(&acc("not-a-token.near")));
    }

    #[test]
    #[should_panic(expected = "Attach token_storage")]
    fn listing_requires_deposit() {
        let mut c = setup();
        ctx(accounts(4), 1, 1_000);
        let _ = c.list_token(acc("fresh.meme-cooking.near"), None);
    }

    #[test]
    fn fee_math_does_not_overflow_on_huge_outputs() {
        // A low-priced 24-decimal meme: 1e38 raw out would overflow `out * 100` in u128.
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"1"}),
            100,
        );
        ctx(accounts(3), 0, 1_001);
        let _ = c.execute(id, vec![RouteHop { pool_id: 7, token_out: acc("blackdragon.tkn.near") }], None);
        ctx(acc("readersexit.near"), 0, 1_001);
        let huge: u128 = 100_000_000_000_000_000_000_000_000_000_000_000_000; // 1e38
        let out = c.on_executed(id, U128(100), accounts(3), Ok(U128(huge)));
        assert_eq!(out.0, huge - huge / 10_000 * 30); // 30 bps fee, exact since 1e38 % 1e4 == 0
        assert_eq!(c.get_balances(accounts(1))[0].balance.0, out.0);
    }

    #[test]
    #[should_panic(expected = "Only keepers or the order owner")]
    fn strangers_cannot_expire() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"5","expires_at_sec":1_500}),
            100,
        );
        ctx(accounts(4), 0, 2_000);
        c.expire(id);
    }

    #[test]
    fn keeper_can_expire() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"5","expires_at_sec":1_500}),
            100,
        );
        ctx(accounts(0), 0, 2_000); // owner counts as keeper
        c.expire(id);
        assert_eq!(c.get_balances(accounts(1))[0].balance.0, 100);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn admin_calls_need_one_yocto() {
        let mut c = setup();
        ctx(accounts(0), 0, 1_000);
        c.set_fee(50, None);
    }

    #[test]
    fn referrer_gets_half_the_fee() {
        let mut c = setup();
        ctx(accounts(1), 0, 1_000);
        assert!(c.set_referrer(accounts(5)));
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"1000000"}),
            100,
        );
        ctx(accounts(3), 0, 1_001);
        let _ = c.execute(id, vec![RouteHop { pool_id: 7, token_out: acc("blackdragon.tkn.near") }], None);
        ctx(acc("readersexit.near"), 0, 1_001);
        let out = c.on_executed(id, U128(100), accounts(3), Ok(U128(2_000_000)));
        // 30 bps fee = 6000: user unchanged, referrer and treasury split the fee.
        assert_eq!(out.0, 1_994_000);
        assert_eq!(c.get_balances(accounts(1))[0].balance.0, 1_994_000);
        assert_eq!(c.get_balances(accounts(5))[0].balance.0, 3_000);
        assert_eq!(c.get_balances(accounts(0))[0].balance.0, 3_000);
    }

    #[test]
    fn referral_binding_is_permanent_and_not_self() {
        let mut c = setup();
        ctx(accounts(1), 0, 1_000);
        assert!(!c.set_referrer(accounts(1)), "self-referral ignored");
        assert_eq!(c.get_referrer(accounts(1)), None);
        assert!(c.set_referrer(accounts(5)));
        assert!(!c.set_referrer(accounts(4)), "first referrer wins");
        assert_eq!(c.get_referrer(accounts(1)), Some(accounts(5)));
    }

    #[test]
    fn no_referrer_means_full_fee_to_treasury() {
        let mut c = setup();
        let id = create(
            &mut c,
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"1000000"}),
            100,
        );
        ctx(accounts(3), 0, 1_001);
        let _ = c.execute(id, vec![RouteHop { pool_id: 7, token_out: acc("blackdragon.tkn.near") }], None);
        ctx(acc("readersexit.near"), 0, 1_001);
        c.on_executed(id, U128(100), accounts(3), Ok(U128(2_000_000)));
        assert_eq!(c.get_balances(accounts(0))[0].balance.0, 6_000);
    }

    #[test]
    fn migrate_from_v1_keeps_state() {
        ctx(acc("readersexit.near"), 0, 1_000);
        let mut v1 = ContractV1 {
            owner_id: accounts(0),
            ref_exchange_id: acc("v2.ref-finance.near"),
            treasury_id: acc("readersofee.near"),
            fee_bps: 100,
            paused: false,
            next_order_id: 7,
            keepers: IterableSet::new(StorageKey::Keepers),
            tokens: IterableSet::new(StorageKey::Tokens),
            orders: IterableMap::new(StorageKey::Orders),
            accounts: LookupMap::new(StorageKey::Accounts),
        };
        v1.tokens.insert(acc("wrap.near"));
        v1.keepers.insert(acc("keeper.skyto.near"));
        let mut balances = BTreeMap::new();
        balances.insert(acc("wrap.near"), 42u128);
        v1.accounts.insert(accounts(1), Account { storage_deposit: MIN_ACCOUNT_STORAGE, order_ids: vec![], balances });
        v1.tokens.flush();
        v1.keepers.flush();
        v1.accounts.flush();
        env::state_write(&v1);

        let c = Contract::migrate();
        let cfg = c.get_config();
        assert_eq!(cfg.owner_id, accounts(0));
        assert_eq!(cfg.treasury_id, acc("readersofee.near"));
        assert_eq!(cfg.fee_bps, 100);
        assert_eq!(cfg.next_order_id, 7);
        assert_eq!(cfg.referral_share_bps, 5_000);
        assert_eq!(c.get_tokens(), vec![acc("wrap.near")]);
        assert_eq!(c.get_keepers(), vec![acc("keeper.skyto.near")]);
        assert_eq!(c.get_balances(accounts(1))[0].balance.0, 42);
        assert_eq!(c.get_referrer(accounts(1)), None);
    }

    #[test]
    fn funding_failure_refunds() {
        let mut c = setup();
        ctx(acc("wrap.near"), 0, 1_000);
        let _ = c.ft_on_transfer(
            accounts(1),
            U128(100),
            json!({"type":"limit","token_out":"blackdragon.tkn.near","min_amount_out":"5"}).to_string(),
        );
        ctx(acc("readersexit.near"), 0, 1_000);
        let unused = c.on_order_funded(0, U128(100), Err(PromiseError::Failed));
        assert_eq!(unused.0, 100);
        assert!(c.get_order(0).is_none());
    }
}
