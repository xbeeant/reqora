//! Pure-logic services that make up the sending chain.
//!
//! `http` is the entry point; everything else is either a dependency of it or
//! shares its wire types. `mock` and `dynamic` live here because
//! `template::resolve` -> `dynamic` -> `mock::{eval_token, format_date, Prng}`
//! are part of the same dependency closure. The update trust-root rules
//! (public key / URL policy) now live in the dependency-free `crate::trust`
//! instead, so `config` no longer has to depend on this whole service module.

pub mod auth;
pub mod body_store;
pub mod cookies;
pub mod dynamic;
pub mod http;
pub mod mock;
pub mod postman;
pub mod response_body;
pub mod sse;
pub mod template;
pub mod timing;
#[cfg(feature = "update")]
pub mod update;
