//! Caesura gate — keys for agents that cannot act alone.
//!
//! One seat proposes, a second seat held apart assays, and this contract, which holds the
//! only keys, releases an action when both agree and the policy passes. Every decision,
//! including every refusal, is recorded and can carry the root of an evidence bundle.
//!
//! Authorisation is by access key: the two seat keys are function-call keys that live on
//! this contract's own account, each scoped by the protocol to its method; the contract
//! additionally checks which key signed (`env::signer_account_pk()`).

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde::Serialize;
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue, PublicKey,
};
use std::num::NonZeroU128;

const EVENT_STANDARD: &str = "caesura";
const EVENT_VERSION: &str = "1.0.0";
const DAY_MS: u64 = 86_400_000;
const SEAT_ALLOWANCE: NearToken = NearToken::from_millinear(250);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Proposals,
    Roots,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub max_per_action: U128,
    pub max_per_day: U128,
    pub cooldown_ms: u64,
    pub receivers: Vec<AccountId>,
    /// Allowed function names on the receivers; the empty string allows a plain transfer.
    pub methods: Vec<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    pub receiver_id: AccountId,
    pub method_name: Option<String>,
    pub args_base64: Option<Base64VecU8>,
    pub deposit: U128,
    pub gas_tgas: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub model: String,
    pub request_hash: String,
    pub response_hash: String,
    pub signing_address: String,
    pub signature: String,
    pub signature_kind: String,
    pub signing_algo: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub approve: bool,
    pub reason: String,
    pub assay_kappa: String,
    pub receipt: Receipt,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Proposed,
    Executed,
    Refused,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub action: Action,
    pub proposal_kappa: String,
    pub receipt: Receipt,
    pub proposed_at_ms: u64,
    pub status: Status,
    pub verdict: Option<Verdict>,
    pub refusal: Option<String>,
    pub executed_at_ms: Option<u64>,
    pub root: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RootRecord {
    pub proposal_id: u64,
    pub round: String,
    pub root: String,
    pub committed_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct GateState {
    pub owner: AccountId,
    pub paused: bool,
    pub proposer_key: Option<PublicKey>,
    pub assayer_key: Option<PublicKey>,
    pub day_index: u64,
    pub spent_today: U128,
    pub last_executed_ms: u64,
    pub proposals: u64,
    pub roots: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Gate {
    owner: AccountId,
    paused: bool,
    policy: Policy,
    proposer_key: Option<PublicKey>,
    assayer_key: Option<PublicKey>,
    proposals: IterableMap<u64, Proposal>,
    next_id: u64,
    roots: Vector<RootRecord>,
    day_index: u64,
    spent_today: u128,
    last_executed_ms: u64,
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
struct ProposeEvent<'a> {
    id: u64,
    receiver_id: &'a AccountId,
    deposit: U128,
    proposal_kappa: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct AssayEvent<'a> {
    id: u64,
    status: &'a Status,
    reason: &'a str,
    assay_kappa: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RootEvent<'a> {
    id: u64,
    round: &'a str,
    root: &'a str,
}

#[near]
impl Gate {
    #[init]
    pub fn new(owner: AccountId, policy: Policy) -> Self {
        Self {
            owner,
            paused: false,
            policy,
            proposer_key: None,
            assayer_key: None,
            proposals: IterableMap::new(StorageKey::Proposals),
            next_id: 0,
            roots: Vector::new(StorageKey::Roots),
            day_index: 0,
            spent_today: 0,
            last_executed_ms: 0,
        }
    }

    // ------------------------------------------------------------------ seats

    /// The proposer seat records an action it wants taken. Nothing moves here.
    pub fn propose(&mut self, action: Action, proposal_kappa: String, receipt: Receipt) -> u64 {
        self.require_seat(&self.proposer_key.clone(), "proposer");
        require!(proposal_kappa.starts_with("sha256:") && proposal_kappa.len() == 71, "proposal_kappa must be sha256:<64 hex>");
        let id = self.next_id;
        self.next_id += 1;
        let now = env::block_timestamp_ms();
        emit("propose", ProposeEvent { id, receiver_id: &action.receiver_id, deposit: action.deposit, proposal_kappa: &proposal_kappa });
        self.proposals.insert(
            id,
            Proposal {
                id,
                action,
                proposal_kappa,
                receipt,
                proposed_at_ms: now,
                status: Status::Proposed,
                verdict: None,
                refusal: None,
                executed_at_ms: None,
                root: None,
            },
        );
        id
    }

    /// The assayer seat, held apart, returns its verdict. The gate then applies the policy.
    /// Approve + pass releases the action; anything else is a refusal with a named reason.
    pub fn assay(&mut self, id: u64, verdict: Verdict) -> PromiseOrValue<String> {
        self.require_seat(&self.assayer_key.clone(), "assayer");
        let mut p = self.proposals.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(p.status == Status::Proposed, "proposal already decided");
        let now = env::block_timestamp_ms();
        let refusal = self.policy_refusal(&p.action, &verdict, now);
        let assay_kappa = verdict.assay_kappa.clone();
        p.verdict = Some(verdict);
        match refusal {
            Some(reason) => {
                p.status = Status::Refused;
                p.refusal = Some(reason.clone());
                emit("assay", AssayEvent { id, status: &Status::Refused, reason: &reason, assay_kappa: &assay_kappa });
                self.proposals.insert(id, p);
                PromiseOrValue::Value("refused".to_string())
            }
            None => {
                let deposit = p.action.deposit.0;
                self.roll_day(now);
                self.spent_today += deposit;
                self.last_executed_ms = now;
                p.status = Status::Executed;
                p.executed_at_ms = Some(now);
                emit("assay", AssayEvent { id, status: &Status::Executed, reason: "", assay_kappa: &assay_kappa });
                let promise = Self::build_promise(&p.action);
                self.proposals.insert(id, p);
                PromiseOrValue::Promise(
                    promise.then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_executed(id)),
                )
            }
        }
    }

    /// Seals the round: the run root of the evidence bundle for this proposal.
    pub fn commit_root(&mut self, id: u64, round: String, root: String) {
        let by_owner = env::predecessor_account_id() == self.owner;
        if !by_owner {
            self.require_seat(&self.assayer_key.clone(), "assayer");
        }
        require!(root.starts_with("sha256:") && root.len() == 71, "root must be sha256:<64 hex>");
        let mut p = self.proposals.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(p.status != Status::Proposed, "round not decided yet");
        require!(p.root.is_none(), "root already committed");
        let now = env::block_timestamp_ms();
        p.root = Some(root.clone());
        self.proposals.insert(id, p);
        self.roots.push(RootRecord { proposal_id: id, round: round.clone(), root: root.clone(), committed_at_ms: now });
        emit("root", RootEvent { id, round: &round, root: &root });
    }

    #[private]
    pub fn on_executed(&mut self, id: u64, #[callback_result] result: Result<(), PromiseError>) -> String {
        let mut p = self.proposals.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such proposal"));
        let status = if result.is_ok() { Status::Executed } else { Status::Failed };
        if status == Status::Failed {
            // the spend did not happen; give the day's budget back
            self.spent_today = self.spent_today.saturating_sub(p.action.deposit.0);
        }
        p.status = status.clone();
        emit("executed", AssayEvent { id, status: &status, reason: "", assay_kappa: "" });
        self.proposals.insert(id, p);
        match status {
            Status::Executed => "executed".into(),
            _ => "failed".into(),
        }
    }

    // ------------------------------------------------------------------ owner

    pub fn set_policy(&mut self, policy: Policy) {
        self.require_owner();
        self.policy = policy.clone();
        emit("policy", policy);
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.require_owner();
        self.paused = paused;
        emit("pause", paused);
    }

    /// Installs the two seat keys on this account as function-call keys scoped to their
    /// methods. The previous seat keys, if any, are deleted in the same batch.
    pub fn set_seat_keys(&mut self, proposer_key: PublicKey, assayer_key: PublicKey) -> Promise {
        self.require_owner();
        require!(proposer_key != assayer_key, "the two seats must hold different keys");
        let me = env::current_account_id();
        let mut promise = Promise::new(me.clone());
        if let Some(old) = self.proposer_key.take() {
            if old != proposer_key && old != assayer_key {
                promise = promise.delete_key(old);
            }
        }
        if let Some(old) = self.assayer_key.take() {
            if old != proposer_key && old != assayer_key {
                promise = promise.delete_key(old);
            }
        }
        let allowance = Allowance::Limited(NonZeroU128::new(SEAT_ALLOWANCE.as_yoctonear()).unwrap());
        promise = promise
            .add_access_key_allowance(proposer_key.clone(), allowance, me.clone(), "propose".to_string())
            .add_access_key_allowance(assayer_key.clone(), allowance, me, "assay,commit_root".to_string());
        self.proposer_key = Some(proposer_key.clone());
        self.assayer_key = Some(assayer_key.clone());
        emit("keys", (proposer_key, assayer_key));
        promise
    }

    // ------------------------------------------------------------------ views

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_state(&self) -> GateState {
        GateState {
            owner: self.owner.clone(),
            paused: self.paused,
            proposer_key: self.proposer_key.clone(),
            assayer_key: self.assayer_key.clone(),
            day_index: self.day_index,
            spent_today: U128(self.spent_today),
            last_executed_ms: self.last_executed_ms,
            proposals: self.next_id,
            roots: self.roots.len() as u64,
        }
    }

    pub fn get_proposal(&self, id: u64) -> Option<Proposal> {
        self.proposals.get(&id).cloned()
    }

    pub fn list_proposals(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Proposal> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(20);
        (from..self.next_id.min(from + limit)).filter_map(|i| self.proposals.get(&i).cloned()).collect()
    }

    pub fn list_roots(&self, from: Option<u32>, limit: Option<u32>) -> Vec<RootRecord> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(20);
        self.roots.iter().skip(from as usize).take(limit as usize).cloned().collect()
    }

    // ------------------------------------------------------------------ internals

    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn require_seat(&self, key: &Option<PublicKey>, seat: &str) {
        require!(env::predecessor_account_id() == env::current_account_id(), "seat calls come through the gate's own keys");
        match key {
            Some(k) => require!(env::signer_account_pk() == *k, format!("not the {} key", seat)),
            None => env::panic_str("seat keys not set"),
        }
    }

    fn roll_day(&mut self, now_ms: u64) {
        let day = now_ms / DAY_MS;
        if day != self.day_index {
            self.day_index = day;
            self.spent_today = 0;
        }
    }

    /// The first failing check names the refusal. Order: paused, verdict, receiver, method,
    /// cap_action, cap_day, cooldown.
    fn policy_refusal(&self, action: &Action, verdict: &Verdict, now_ms: u64) -> Option<String> {
        if self.paused {
            return Some("paused".into());
        }
        if !verdict.approve {
            return Some(format!("verdict: {}", verdict.reason));
        }
        if !self.policy.receivers.contains(&action.receiver_id) {
            return Some("receiver".into());
        }
        let method = action.method_name.clone().unwrap_or_default();
        if !self.policy.methods.contains(&method) {
            return Some("method".into());
        }
        let deposit = action.deposit.0;
        if deposit > self.policy.max_per_action.0 {
            return Some("cap_action".into());
        }
        let spent = if now_ms / DAY_MS == self.day_index { self.spent_today } else { 0 };
        if spent + deposit > self.policy.max_per_day.0 {
            return Some("cap_day".into());
        }
        if self.last_executed_ms != 0 && now_ms < self.last_executed_ms + self.policy.cooldown_ms {
            return Some("cooldown".into());
        }
        None
    }

    fn build_promise(action: &Action) -> Promise {
        let p = Promise::new(action.receiver_id.clone());
        match &action.method_name {
            None => p.transfer(NearToken::from_yoctonear(action.deposit.0)),
            Some(name) if name.is_empty() => p.transfer(NearToken::from_yoctonear(action.deposit.0)),
            Some(name) => p.function_call(
                name.clone(),
                action.args_base64.clone().map(|a| a.0).unwrap_or_default(),
                NearToken::from_yoctonear(action.deposit.0),
                Gas::from_tgas(action.gas_tgas.unwrap_or(30)),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn pk(n: u8) -> PublicKey {
        let mut b = vec![0u8; 33];
        b[0] = 0; // ed25519
        b[32] = n;
        PublicKey::try_from(b).unwrap()
    }
    fn policy() -> Policy {
        Policy {
            max_per_action: U128(NearToken::from_millinear(500).as_yoctonear()),
            max_per_day: U128(NearToken::from_near(2).as_yoctonear()),
            cooldown_ms: 1_000,
            receivers: vec![acct("compute.testnet"), acct("shop.testnet")],
            methods: vec!["".into(), "buy_credits".into()],
        }
    }
    fn receipt(kind: &str) -> Receipt {
        Receipt {
            model: "stub".into(),
            request_hash: "0".repeat(64),
            response_hash: "1".repeat(64),
            signing_address: "stub".into(),
            signature: "".into(),
            signature_kind: kind.into(),
            signing_algo: "ed25519".into(),
        }
    }
    fn action(to: &str, millinear: u128) -> Action {
        Action { receiver_id: acct(to), method_name: None, args_base64: None, deposit: U128(NearToken::from_millinear(millinear).as_yoctonear()), gas_tgas: None }
    }
    fn kappa(c: char) -> String {
        format!("sha256:{}", c.to_string().repeat(64))
    }
    fn ctx(pred: &str, signer_pk: PublicKey, ms: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acct("gate.testnet")).predecessor_account_id(acct(pred)).signer_account_pk(signer_pk).block_timestamp(ms * 1_000_000);
        b
    }
    fn gate_with_keys() -> Gate {
        testing_env!(ctx("owner.testnet", pk(9), 0).build());
        let mut g = Gate::new(acct("owner.testnet"), policy());
        g.set_seat_keys(pk(1), pk(2));
        g
    }
    fn verdict(approve: bool, reason: &str) -> Verdict {
        Verdict { approve, reason: reason.into(), assay_kappa: kappa('b'), receipt: receipt("stub") }
    }

    #[test]
    fn propose_then_approve_executes() {
        let mut g = gate_with_keys();
        testing_env!(ctx("gate.testnet", pk(1), 10_000).build());
        let id = g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
        assert_eq!(id, 0);
        testing_env!(ctx("gate.testnet", pk(2), 11_000).build());
        match g.assay(0, verdict(true, "fits policy")) {
            PromiseOrValue::Promise(_) => {}
            PromiseOrValue::Value(v) => panic!("expected a promise, got {}", v),
        }
        let p = g.get_proposal(0).unwrap();
        assert_eq!(p.status, Status::Executed);
        assert_eq!(g.get_state().spent_today.0, NearToken::from_millinear(100).as_yoctonear());
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"assay\"") && l.contains("Executed")));
    }

    #[test]
    fn assayer_no_is_a_refusal_leaf() {
        let mut g = gate_with_keys();
        testing_env!(ctx("gate.testnet", pk(1), 10_000).build());
        g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), 11_000).build());
        match g.assay(0, verdict(false, "intent mismatch")) {
            PromiseOrValue::Value(v) => assert_eq!(v, "refused"),
            _ => panic!("expected a value"),
        }
        let p = g.get_proposal(0).unwrap();
        assert_eq!(p.status, Status::Refused);
        assert_eq!(p.refusal.as_deref(), Some("verdict: intent mismatch"));
        assert_eq!(g.get_state().spent_today.0, 0);
    }

    #[test]
    fn policy_refuses_drain_even_when_assayer_approves() {
        let mut g = gate_with_keys();
        testing_env!(ctx("gate.testnet", pk(1), 10_000).build());
        g.propose(action("attacker.testnet", 50_000), kappa('a'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), 11_000).build());
        g.assay(0, verdict(true, "sure"));
        assert_eq!(g.get_proposal(0).unwrap().refusal.as_deref(), Some("receiver"));
        // over the per-action cap to an allowed receiver
        testing_env!(ctx("gate.testnet", pk(1), 12_000).build());
        g.propose(action("compute.testnet", 600), kappa('c'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), 13_000).build());
        g.assay(1, verdict(true, "sure"));
        assert_eq!(g.get_proposal(1).unwrap().refusal.as_deref(), Some("cap_action"));
    }

    #[test]
    fn day_cap_and_cooldown() {
        let mut g = gate_with_keys();
        let mut t = 10_000u64;
        for i in 0..4u64 {
            testing_env!(ctx("gate.testnet", pk(1), t).build());
            g.propose(action("compute.testnet", 500), kappa('a'), receipt("stub"));
            t += 2_000;
            testing_env!(ctx("gate.testnet", pk(2), t).build());
            g.assay(i, verdict(true, "ok"));
            t += 2_000;
            assert_eq!(g.get_proposal(i).unwrap().status, Status::Executed, "round {}", i);
        }
        testing_env!(ctx("gate.testnet", pk(1), t).build());
        g.propose(action("compute.testnet", 500), kappa('a'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), t + 2_000).build());
        g.assay(4, verdict(true, "ok"));
        assert_eq!(g.get_proposal(4).unwrap().refusal.as_deref(), Some("cap_day"));
        // next day: fresh budget, but the cooldown bites if too quick
        let next_day = (t / DAY_MS + 1) * DAY_MS;
        testing_env!(ctx("gate.testnet", pk(1), next_day).build());
        g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), next_day + 10).build());
        g.assay(5, verdict(true, "ok"));
        assert_eq!(g.get_proposal(5).unwrap().status, Status::Executed);
        testing_env!(ctx("gate.testnet", pk(1), next_day + 20).build());
        g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), next_day + 30).build());
        g.assay(6, verdict(true, "ok"));
        assert_eq!(g.get_proposal(6).unwrap().refusal.as_deref(), Some("cooldown"));
    }

    #[test]
    fn pause_is_a_leaf_too() {
        let mut g = gate_with_keys();
        testing_env!(ctx("owner.testnet", pk(9), 5_000).build());
        g.set_paused(true);
        testing_env!(ctx("gate.testnet", pk(1), 10_000).build());
        g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), 11_000).build());
        g.assay(0, verdict(true, "ok"));
        assert_eq!(g.get_proposal(0).unwrap().refusal.as_deref(), Some("paused"));
    }

    #[test]
    #[should_panic(expected = "not the proposer key")]
    fn assayer_key_cannot_propose() {
        let mut g = gate_with_keys();
        testing_env!(ctx("gate.testnet", pk(2), 10_000).build());
        g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
    }

    #[test]
    #[should_panic(expected = "seat calls come through the gate's own keys")]
    fn outside_caller_cannot_assay() {
        let mut g = gate_with_keys();
        testing_env!(ctx("gate.testnet", pk(1), 10_000).build());
        g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
        testing_env!(ctx("someone.testnet", pk(2), 11_000).build());
        g.assay(0, verdict(true, "ok"));
    }

    #[test]
    fn root_commits_once_after_decision() {
        let mut g = gate_with_keys();
        testing_env!(ctx("gate.testnet", pk(1), 10_000).build());
        g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), 11_000).build());
        g.assay(0, verdict(false, "no"));
        g.commit_root(0, "r1".into(), kappa('f'));
        let roots = g.list_roots(None, None);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].root, kappa('f'));
        assert_eq!(g.get_proposal(0).unwrap().root, Some(kappa('f')));
    }

    #[test]
    #[should_panic(expected = "round not decided yet")]
    fn root_needs_a_decision() {
        let mut g = gate_with_keys();
        testing_env!(ctx("gate.testnet", pk(1), 10_000).build());
        g.propose(action("compute.testnet", 100), kappa('a'), receipt("stub"));
        testing_env!(ctx("gate.testnet", pk(2), 11_000).build());
        g.commit_root(0, "r1".into(), kappa('f'));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn seats_cannot_change_policy() {
        let mut g = gate_with_keys();
        testing_env!(ctx("gate.testnet", pk(1), 10_000).build());
        g.set_policy(policy());
    }
}
