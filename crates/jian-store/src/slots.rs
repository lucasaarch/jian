//! Slots: how tenants are spread over gateway instances, and the leases that say who serves what.
//!
//! A tenant belongs to one of [`SLOT_COUNT`] slots, by a hash of its id that never changes
//! ([`slot_of`]). A slot is owned by at most one instance at a time, through a row of
//! `platform.slot_leases` with an expiry. Everything here is SQL against that table; the loop that
//! calls it every few seconds, and the decision to stop serving, are in `jian-server`.
//!
//! # Why two instances never own a slot together
//!
//! Every change of owner is one conditional `UPDATE` of one row, decided by Postgres under the
//! row's lock: a slot is taken only while it is free or its lease has run out, and renewed only
//! by the instance named in it while the lease is still valid. Time is the database's own `now()`
//! in both cases, never an instance's clock. The instance side then stops serving a slot before
//! the lease can have run out (see `SlotOwnership` in `jian-server`), so the window in which the
//! old owner still serves and the new one has already taken over does not exist.
//!
//! # Share of the slots
//!
//! Each call counts the instances that are alive and not draining, and aims for
//! `ceil(1024 / alive)` slots. An instance above its share lets go of the excess a few slots per
//! call ([`SlotOptions::release_batch`]), so tenants move gradually, and one below it takes free
//! or expired slots up to its share. One instance alone aims for all 1024, which is the whole of a
//! self-hosted install.

use std::fmt;
use std::time::Duration;

use crate::{Database, StoreError, TenantId};

/// How many slots there are. Part of [`slot_of`]: changing it moves every tenant, so it is a
/// migration of its own and not a setting. The migration `0004_slot_leases` makes this many rows.
pub const SLOT_COUNT: u16 = 1024;

/// One of the [`SLOT_COUNT`] slots a tenant can fall into.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SlotId(u16);

impl SlotId {
    /// The slot with this number, or `None` when it is not below [`SLOT_COUNT`].
    #[must_use]
    pub fn new(number: u16) -> Option<Self> {
        (number < SLOT_COUNT).then_some(Self(number))
    }

    /// The number, from 0 to [`SLOT_COUNT`] minus one.
    #[must_use]
    pub fn get(self) -> u16 {
        self.0
    }

    /// The number as an index into a table of [`SLOT_COUNT`] entries.
    #[must_use]
    pub fn index(self) -> usize {
        usize::from(self.0)
    }
}

impl fmt::Display for SlotId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// The slot a tenant belongs to: FNV-1a (64 bits) over the id's UTF-8 bytes, its two halves
/// folded together, modulo [`SLOT_COUNT`].
///
/// Written out here and not taken from `std::hash`, because `DefaultHasher` is allowed to change
/// between Rust versions, and a tenant that moved slot on an upgrade would be served by two
/// instances at once during a rolling deploy. A test pins known values. The fold keeps the high
/// bits in play: FNV's low bits alone cluster for ids that differ only in their last characters.
#[must_use]
pub fn slot_of(tenant: &TenantId) -> SlotId {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let hash = tenant.as_str().bytes().fold(OFFSET, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(PRIME)
    });
    let slot = (hash ^ (hash >> 32)) % u64::from(SLOT_COUNT);
    // The remainder is below 1024, so it always fits.
    SlotId(u16::try_from(slot).unwrap_or(0))
}

/// One running gateway process. Made at start-up and gone when the process is: nothing about it
/// survives a restart, and a restarted gateway is a new instance.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct InstanceId(String);

impl InstanceId {
    /// A random version 4 UUID.
    pub fn generate() -> Result<Self, StoreError> {
        let mut bytes = [0u8; 16];
        crate::secrets::random_bytes(&mut bytes)?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Ok(Self(format_uuid(&bytes)))
    }

    /// The instance Postgres printed for a `uuid` column; `None` for anything else.
    pub(crate) fn from_row(text: &str) -> Option<Self> {
        is_uuid_text(text).then(|| Self(text.to_ascii_lowercase()))
    }

    /// The UUID as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for InstanceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Whether the text has the shape Postgres prints a `uuid` in: 36 characters, hexadecimal digits
/// and four dashes.
pub(crate) fn is_uuid_text(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn format_uuid(bytes: &[u8; 16]) -> String {
    use std::fmt::Write as _;
    let mut text = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        // Writing to a `String` cannot fail.
        let _ = write!(text, "{byte:02x}");
    }
    text
}

/// How leases are timed and how fast slots move between instances.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlotOptions {
    /// How long a lease lasts after each renewal. An instance that cannot renew within this
    /// loses its slots, and another takes them: it is how long a crashed instance's tenants wait.
    pub lease: Duration,
    /// How often an instance renews. Well under `lease`, so that a few missed renewals in a row
    /// are survived: a third of it is the usual.
    pub renew_every: Duration,
    /// The most slots an instance above its share lets go of in one renewal. Moving tenants a
    /// few at a time keeps a new instance's arrival from reconnecting half the fleet at once.
    pub release_batch: u16,
}

impl Default for SlotOptions {
    fn default() -> Self {
        Self {
            lease: Duration::from_secs(30),
            renew_every: Duration::from_secs(10),
            release_batch: 128,
        }
    }
}

/// A slot an instance holds, with the epoch it was given at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeldSlot {
    /// The slot.
    pub slot: SlotId,
    /// The slot's epoch when this instance took it. It rises each time the slot changes hands,
    /// so it orders the owners the slot has had.
    pub epoch: i64,
}

/// What one round of [`Database::claim_slots`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotClaim {
    /// Every slot the instance holds now, each with a lease running from this round.
    pub held: Vec<HeldSlot>,
    /// How many instances are alive and not draining, this one included.
    pub live_instances: u16,
    /// The share this instance aims for: `ceil(1024 / live_instances)`.
    pub target: u16,
    /// How many slots were taken in this round.
    pub acquired: u16,
    /// How many were let go of in this round because the instance was above its share.
    pub released: u16,
}

/// A row of the lease table, for whoever has to find the instance that serves a tenant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotRow {
    /// The slot.
    pub slot: SlotId,
    /// The instance that holds the lease; `None` when free. A lease that has run out still names
    /// its last owner here: look at `live`.
    pub owner: Option<InstanceId>,
    /// How many times the slot has changed hands.
    pub epoch: i64,
    /// Whether the lease is still running at the database's `now()`.
    pub live: bool,
}

impl Database {
    /// One round for `me`: counts as alive, lets go of the excess above its share, renews the
    /// leases it holds and takes free or expired slots up to its share. All in one transaction,
    /// so a round either happened whole or not at all, and the database's `now()` is the same
    /// throughout.
    ///
    /// A slot whose lease had already run out when this round started is taken again with a new
    /// epoch even if `me` was its owner, because the instance had stopped serving it by then and
    /// somebody else may have held it in between.
    pub async fn claim_slots(
        &self,
        me: &InstanceId,
        options: &SlotOptions,
    ) -> Result<SlotClaim, StoreError> {
        const ACTION: &str = "claim slots";
        let lease = options.lease.as_secs_f64();
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query(
            "INSERT INTO instances (id) VALUES ($1::text::uuid) \
             ON CONFLICT (id) DO UPDATE SET heartbeat_at = now()",
        )
        .bind(me.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        // Long after it stopped counting, so a pause does not erase an instance that is back.
        sqlx::query(
            "DELETE FROM instances WHERE heartbeat_at < now() - $1::float8 * 10 * interval '1 second'",
        )
        .bind(lease)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let alive: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM instances \
             WHERE NOT draining AND heartbeat_at > now() - $1::float8 * interval '1 second'",
        )
        .bind(lease)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let live_instances = u16::try_from(alive.max(1)).unwrap_or(u16::MAX);
        let target = SLOT_COUNT.div_ceil(live_instances);

        let holding: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM slot_leases WHERE owner = $1::text::uuid AND expires_at > now()",
        )
        .bind(me.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let holding = u16::try_from(holding).unwrap_or(SLOT_COUNT);

        let excess = holding.saturating_sub(target).min(options.release_batch);
        let mut released = 0;
        if excess > 0 {
            // From the highest slot down: a newcomer takes from the lowest free one up, so the
            // two do not keep colliding on the same rows.
            let freed = sqlx::query(
                "UPDATE slot_leases SET owner = NULL, expires_at = NULL WHERE slot IN ( \
                 SELECT slot FROM slot_leases WHERE owner = $1::text::uuid AND expires_at > now() \
                 ORDER BY slot DESC LIMIT $2 FOR UPDATE)",
            )
            .bind(me.as_str())
            .bind(i64::from(excess))
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            released = u16::try_from(freed.rows_affected()).unwrap_or(u16::MAX);
        }

        let renewed: Vec<(i32, i64)> = sqlx::query_as(
            "UPDATE slot_leases SET expires_at = now() + $2::float8 * interval '1 second' \
             WHERE owner = $1::text::uuid AND expires_at > now() RETURNING slot, epoch",
        )
        .bind(me.as_str())
        .bind(lease)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let mut held = held_slots(renewed);

        let wanted = target.saturating_sub(u16::try_from(held.len()).unwrap_or(SLOT_COUNT));
        let mut acquired = 0;
        if wanted > 0 {
            // SKIP LOCKED: a row another instance is taking right now is not waited for, there
            // are others. The outer WHERE repeats the condition, so a row that changed between
            // the choice and the update is left alone.
            let taken: Vec<(i32, i64)> = sqlx::query_as(
                "UPDATE slot_leases SET owner = $1::text::uuid, epoch = epoch + 1, \
                 expires_at = now() + $2::float8 * interval '1 second' \
                 WHERE slot IN ( \
                   SELECT slot FROM slot_leases WHERE owner IS NULL OR expires_at <= now() \
                   ORDER BY slot LIMIT $3 FOR UPDATE SKIP LOCKED) \
                 AND (owner IS NULL OR expires_at <= now()) RETURNING slot, epoch",
            )
            .bind(me.as_str())
            .bind(lease)
            .bind(i64::from(wanted))
            .fetch_all(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            let taken = held_slots(taken);
            acquired = u16::try_from(taken.len()).unwrap_or(u16::MAX);
            held.extend(taken);
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        held.sort_by_key(|held| held.slot);
        Ok(SlotClaim {
            held,
            live_instances,
            target,
            acquired,
            released,
        })
    }

    /// Stops `me` counting as an instance that will take slots, at once, so the others aim for
    /// a larger share while it winds down. Its leases stay until
    /// [`release_instance`](Database::release_instance).
    pub async fn mark_instance_draining(&self, me: &InstanceId) -> Result<(), StoreError> {
        const ACTION: &str = "mark an instance as draining";
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query(
            "INSERT INTO instances (id, draining) VALUES ($1::text::uuid, true) \
             ON CONFLICT (id) DO UPDATE SET draining = true",
        )
        .bind(me.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Lets go of every slot `me` holds and forgets the instance, so another takes the slots on
    /// its next round without waiting for the leases to run out. Returns how many were freed.
    /// Epochs are left as they are: the next owner raises them.
    pub async fn release_instance(&self, me: &InstanceId) -> Result<u64, StoreError> {
        const ACTION: &str = "release an instance's slots";
        let mut tx = self.platform_tx(ACTION).await?;
        let freed = sqlx::query(
            "UPDATE slot_leases SET owner = NULL, expires_at = NULL WHERE owner = $1::text::uuid",
        )
        .bind(me.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        sqlx::query("DELETE FROM instances WHERE id = $1::text::uuid")
            .bind(me.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(freed)
    }

    /// Every slot with its owner, epoch and whether the lease still runs, ordered by slot.
    pub async fn slot_rows(&self) -> Result<Vec<SlotRow>, StoreError> {
        const ACTION: &str = "read the slot leases";
        let mut tx = self.platform_tx(ACTION).await?;
        let rows: Vec<(i32, Option<String>, i64, bool)> = sqlx::query_as(
            "SELECT slot, owner::text, epoch, COALESCE(expires_at > now(), false) \
             FROM slot_leases ORDER BY slot",
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(rows
            .into_iter()
            .filter_map(|(slot, owner, epoch, live)| {
                Some(SlotRow {
                    slot: SlotId::new(u16::try_from(slot).ok()?)?,
                    owner: owner.as_deref().and_then(InstanceId::from_row),
                    epoch,
                    live,
                })
            })
            .collect())
    }
}

fn held_slots(rows: Vec<(i32, i64)>) -> Vec<HeldSlot> {
    rows.into_iter()
        .filter_map(|(slot, epoch)| {
            Some(HeldSlot {
                slot: SlotId::new(u16::try_from(slot).ok()?)?,
                epoch,
            })
        })
        .collect()
}
