//! Caesura registry — the list of gates the board reads.
//!
//! Anyone who owns a gate registers it here with one transaction. The registry asks the
//! gate for its state (`get_state`) and keeps the entry only if the caller is the owner that
//! gate names. The board reads `list_gates` and then reads each gate itself; the registry
//! holds names, never results.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

const EVENT_STANDARD: &str = "caesura-registry";
const EVENT_VERSION: &str = "1.0.0";
/// Covers the entry's storage; anything attached above it is returned.
const ENTRY_DEPOSIT: NearToken = NearToken::from_millinear(10);
const VIEW_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
const MAX_LABEL: usize = 80;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Gates,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct GateEntry {
    pub gate: AccountId,
    pub owner: AccountId,
    pub label: String,
    pub registered_by: AccountId,
    pub registered_at_ms: u64,
}

/// The part of a gate's `get_state` answer the registry reads. Other fields are ignored.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct GateOwner {
    pub owner: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    gates: IterableMap<AccountId, GateEntry>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Event<'a, T: Serialize> {
    standard: &'a str,
    version: &'a str,
    event: &'a str,
    data: T,
}

fn emit<T: Serialize>(event: &str, data: T) {
    let e = Event { standard: EVENT_STANDARD, version: EVENT_VERSION, event, data };
    env::log_str(&format!("EVENT_JSON:{}", near_sdk::serde_json::to_string(&e).unwrap()));
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RefusedEvent<'a> {
    gate: &'a AccountId,
    by: &'a AccountId,
    reason: &'a str,
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, gates: IterableMap::new(StorageKey::Gates) }
    }

    /// Register a gate you own. Attach at least 0.01 NEAR; the registry asks the gate who
    /// owns it and keeps the entry only if that is you. The deposit above the entry's cost,
    /// or all of it on a refusal, comes back.
    #[payable]
    pub fn register(&mut self, gate: AccountId, label: String) -> Promise {
        require!(label.chars().count() <= MAX_LABEL, "label is at most 80 characters");
        require!(!self.gates.contains_key(&gate), "already registered; unregister first");
        let deposit = env::attached_deposit();
        require!(deposit >= ENTRY_DEPOSIT, "attach at least 0.01 NEAR for the entry's storage");
        let by = env::predecessor_account_id();
        Promise::new(gate.clone())
            .function_call("get_state".to_string(), b"{}".to_vec(), NearToken::from_near(0), VIEW_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_gate_state(gate, label, by, U128(deposit.as_yoctonear())),
            )
    }

    #[private]
    pub fn on_gate_state(
        &mut self,
        gate: AccountId,
        label: String,
        by: AccountId,
        deposit: U128,
        #[callback_result] result: Result<GateOwner, PromiseError>,
    ) -> bool {
        let deposit = NearToken::from_yoctonear(deposit.0);
        let refuse = |reason: &str| {
            emit("refused", RefusedEvent { gate: &gate, by: &by, reason });
            let _ = Promise::new(by.clone()).transfer(deposit);
            false
        };
        let state = match result {
            Ok(s) => s,
            Err(_) => return refuse("the gate did not answer get_state"),
        };
        if state.owner != by {
            return refuse("the caller is not the gate's owner");
        }
        let entry = GateEntry {
            gate: gate.clone(),
            owner: state.owner,
            label,
            registered_by: by.clone(),
            registered_at_ms: env::block_timestamp_ms(),
        };
        self.gates.insert(gate, entry.clone());
        emit("register", &entry);
        if let Some(change) = deposit.checked_sub(ENTRY_DEPOSIT) {
            if !change.is_zero() {
                let _ = Promise::new(by).transfer(change);
            }
        }
        true
    }

    /// The account that registered a gate, or the registry's owner, can remove it.
    pub fn unregister(&mut self, gate: AccountId) {
        let entry = self.gates.get(&gate).cloned().unwrap_or_else(|| env::panic_str("not registered"));
        let caller = env::predecessor_account_id();
        require!(caller == entry.registered_by || caller == self.owner, "only the registrant or the registry owner");
        self.gates.remove(&gate);
        emit("unregister", &entry);
    }

    // ------------------------------------------------------------------ views

    pub fn get_gate(&self, gate: AccountId) -> Option<GateEntry> {
        self.gates.get(&gate).cloned()
    }

    pub fn list_gates(&self, from: Option<u32>, limit: Option<u32>) -> Vec<GateEntry> {
        let from = from.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50) as usize;
        let mut v: Vec<GateEntry> = self.gates.values().cloned().collect();
        v.sort_by_key(|e| e.registered_at_ms);
        v.into_iter().skip(from).take(limit).collect()
    }

    pub fn count(&self) -> u32 {
        self.gates.len()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(predecessor: AccountId, deposit: NearToken, ms: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("gates.caesura.testnet".parse().unwrap())
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit)
            .block_timestamp(ms * 1_000_000);
        testing_env!(b.build());
    }

    fn registry() -> Registry {
        Registry::new(accounts(0))
    }

    fn gate() -> AccountId {
        "pause.caesura.testnet".parse().unwrap()
    }

    #[test]
    fn register_keeps_the_entry_when_the_caller_owns_the_gate() {
        let mut r = registry();
        ctx(accounts(1), ENTRY_DEPOSIT, 1_000);
        r.register(gate(), "the first gate".into());
        ctx("gates.caesura.testnet".parse().unwrap(), NearToken::from_near(0), 1_001);
        let kept = r.on_gate_state(gate(), "the first gate".into(), accounts(1), U128(ENTRY_DEPOSIT.as_yoctonear()), Ok(GateOwner { owner: accounts(1) }));
        assert!(kept);
        let e = r.get_gate(gate()).unwrap();
        assert_eq!(e.owner, accounts(1));
        assert_eq!(e.registered_by, accounts(1));
        assert_eq!(e.label, "the first gate");
        assert_eq!(e.registered_at_ms, 1_001);
        assert_eq!(r.count(), 1);
    }

    #[test]
    fn register_refuses_when_the_caller_is_not_the_owner() {
        let mut r = registry();
        ctx("gates.caesura.testnet".parse().unwrap(), NearToken::from_near(0), 1);
        let kept = r.on_gate_state(gate(), "x".into(), accounts(2), U128(ENTRY_DEPOSIT.as_yoctonear()), Ok(GateOwner { owner: accounts(1) }));
        assert!(!kept);
        assert!(r.get_gate(gate()).is_none());
        assert_eq!(r.count(), 0);
    }

    #[test]
    fn register_refuses_when_the_gate_does_not_answer() {
        let mut r = registry();
        ctx("gates.caesura.testnet".parse().unwrap(), NearToken::from_near(0), 1);
        let kept = r.on_gate_state(gate(), "x".into(), accounts(1), U128(ENTRY_DEPOSIT.as_yoctonear()), Err(PromiseError::Failed));
        assert!(!kept);
        assert_eq!(r.count(), 0);
    }

    #[test]
    #[should_panic(expected = "attach at least 0.01 NEAR")]
    fn register_needs_the_deposit() {
        let mut r = registry();
        ctx(accounts(1), NearToken::from_near(0), 1);
        r.register(gate(), "x".into());
    }

    #[test]
    #[should_panic(expected = "already registered")]
    fn register_twice_is_refused() {
        let mut r = registry();
        ctx("gates.caesura.testnet".parse().unwrap(), NearToken::from_near(0), 1);
        r.on_gate_state(gate(), "x".into(), accounts(1), U128(ENTRY_DEPOSIT.as_yoctonear()), Ok(GateOwner { owner: accounts(1) }));
        ctx(accounts(1), ENTRY_DEPOSIT, 2);
        r.register(gate(), "again".into());
    }

    #[test]
    fn unregister_by_registrant_and_by_registry_owner_only() {
        let mut r = registry();
        ctx("gates.caesura.testnet".parse().unwrap(), NearToken::from_near(0), 1);
        r.on_gate_state(gate(), "x".into(), accounts(1), U128(ENTRY_DEPOSIT.as_yoctonear()), Ok(GateOwner { owner: accounts(1) }));
        let other: AccountId = "gap.caesura.testnet".parse().unwrap();
        r.on_gate_state(other.clone(), "y".into(), accounts(1), U128(ENTRY_DEPOSIT.as_yoctonear()), Ok(GateOwner { owner: accounts(1) }));
        assert_eq!(r.count(), 2);
        ctx(accounts(1), NearToken::from_near(0), 2);
        r.unregister(gate());
        ctx(accounts(0), NearToken::from_near(0), 3);
        r.unregister(other);
        assert_eq!(r.count(), 0);
    }

    #[test]
    #[should_panic(expected = "only the registrant or the registry owner")]
    fn a_stranger_cannot_unregister() {
        let mut r = registry();
        ctx("gates.caesura.testnet".parse().unwrap(), NearToken::from_near(0), 1);
        r.on_gate_state(gate(), "x".into(), accounts(1), U128(ENTRY_DEPOSIT.as_yoctonear()), Ok(GateOwner { owner: accounts(1) }));
        ctx(accounts(3), NearToken::from_near(0), 2);
        r.unregister(gate());
    }

    #[test]
    fn list_is_in_registration_order() {
        let mut r = registry();
        let a: AccountId = "b.caesura.testnet".parse().unwrap();
        let b: AccountId = "a.caesura.testnet".parse().unwrap();
        ctx("gates.caesura.testnet".parse().unwrap(), NearToken::from_near(0), 10);
        r.on_gate_state(a.clone(), "first".into(), accounts(1), U128(ENTRY_DEPOSIT.as_yoctonear()), Ok(GateOwner { owner: accounts(1) }));
        ctx("gates.caesura.testnet".parse().unwrap(), NearToken::from_near(0), 20);
        r.on_gate_state(b.clone(), "second".into(), accounts(2), U128(ENTRY_DEPOSIT.as_yoctonear()), Ok(GateOwner { owner: accounts(2) }));
        let l = r.list_gates(None, None);
        assert_eq!(l.iter().map(|e| e.gate.clone()).collect::<Vec<_>>(), vec![a, b]);
        assert_eq!(r.list_gates(Some(1), Some(5)).len(), 1);
    }
}
