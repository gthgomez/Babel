<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->

# Skill: Android Room Database (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`, `skill_android_state_management`
**Last Verified:** 2026-04-25
**Activation:** Load for any task touching Room entities, DAOs, RoomDatabase, migrations,
repository layer, or local SQLite persistence in Android.

---

## Purpose

Room is Android's recommended local persistence library. Wrong patterns produce schema drift,
migration crashes, threading violations, and leaked queries. This skill enforces the correct
structural contract.

**Version context:** For the stable `androidx.room` line, use Room 2.8.4 unless the project overlay
pins a different supported version. Room 3.0 (`androidx.room3`) is alpha in 2026 and must not be
introduced into production Android apps without explicit migration approval.

---

## Step 1 — ENTITY RULES

Every Room entity must:
- be annotated `@Entity(tableName = "snake_case_name")`
- declare a single `@PrimaryKey` (prefer `autoGenerate = true` on an `Int` or `Long` id)
- use only types Room can store without a custom converter: `Int`, `Long`, `String`, `Boolean`, `Double`, `Float`, `ByteArray`
- store monetary values as `Int` (cents) or `Long` — never `Double` or `BigDecimal` in the entity itself
- declare foreign keys with `ForeignKey` annotations including `onDelete` policy

```kotlin
@Entity(
    tableName = "transactions",
    foreignKeys = [ForeignKey(
        entity = PaymentEntity::class,
        parentColumns = ["id"],
        childColumns = ["payment_id"],
        onDelete = ForeignKey.CASCADE
    )],
    indices = [Index("payment_id")]
)
data class TransactionEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val description: String,
    val amount_cents: Int,
    val date: String,
    val type: String
)
```

---

## Step 2 — DAO RULES

Every DAO must:
- be annotated `@Dao`
- use `@Insert`, `@Update`, `@Delete`, `@Query` annotations
- return `Flow<T>` for queries that the UI observes (live updates)
- return `Unit` or the inserted `Long` rowId for write operations
- be declared as `suspend fun` for all write operations
- never expose `Cursor` or raw SQLite types to callers

```kotlin
@Dao
interface TransactionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(entity: TransactionEntity): Long

    @Update
    suspend fun update(entity: TransactionEntity)

    @Delete
    suspend fun delete(entity: TransactionEntity)

    @Query("SELECT * FROM transactions ORDER BY date DESC")
    fun getAll(): Flow<List<TransactionEntity>>

    @Query("SELECT SUM(amount_cents) FROM transactions WHERE type = 'income'")
    fun getTotalIncomeCents(): Flow<Int?>
}
```

---

## Step 3 — DATABASE CLASS RULES

The `RoomDatabase` class must:
- be annotated `@Database(entities = [...], version = N, exportSchema = false)` for apps not tracking schema history, or `exportSchema = true` with a schema export directory for production
- be a `abstract class` extending `RoomDatabase`
- expose each DAO as an `abstract fun`
- be built as a singleton (companion object or DI module — never instantiated twice)
- use `fallbackToDestructiveMigration()` only during development; production must supply explicit `Migration` objects

```kotlin
@Database(
    entities = [IncomeEntity::class, PaymentEntity::class, TransactionEntity::class,
                BillOccurrenceEntity::class, SettingsEntity::class],
    version = 1,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun incomeDao(): IncomeDao
    abstract fun paymentDao(): PaymentDao
    abstract fun transactionDao(): TransactionDao
    abstract fun billOccurrenceDao(): BillOccurrenceDao
    abstract fun settingsDao(): SettingsDao

    companion object {
        @Volatile private var INSTANCE: AppDatabase? = null

        fun getInstance(context: Context): AppDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "app_database"
                ).build().also { INSTANCE = it }
            }
    }
}
```

---

## Step 4 — MIGRATION RULES

- Every schema change requires a numbered `Migration(from, to)` object
- Migrations run in sequence; do not skip versions
- Test migrations with `MigrationTestHelper` in instrumented tests
- Additive changes (new columns with defaults, new tables) are the safest migrations
- Dropping columns requires a full table recreation via SQLite `CREATE TABLE` + `INSERT SELECT` + `DROP TABLE` + `ALTER TABLE RENAME`

```kotlin
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL("ALTER TABLE income ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
    }
}
```

---

## Step 5 — REPOSITORY RULES

The repository layer must:
- wrap all DAO calls; no ViewModel or UI layer imports Room types directly
- expose `Flow<T>` for observable data, `suspend fun` for writes
- handle `withContext(Dispatchers.IO)` if needed, though Room already dispatches to a background thread for suspend functions
- never expose entities directly to the UI — map to domain models when business logic differs from storage shape

```kotlin
class LedgerRepository(private val db: AppDatabase) {
    val allTransactions: Flow<List<TransactionEntity>> = db.transactionDao().getAll()

    suspend fun insertTransaction(entity: TransactionEntity) {
        db.transactionDao().insert(entity)
    }

    suspend fun getBalanceCents(): Int {
        return db.settingsDao().getValue("current_balance")?.toIntOrNull() ?: 0
    }
}
```

---

## Step 6 — COMMON FAILURE CASES

| Failure | Why it happens | Prevention |
|---------|----------------|------------|
| Migration crash on update | schema changed without a `Migration` object | always bump version + add Migration before shipping |
| Threading violation crash | called DAO synchronously on main thread | all write ops must be `suspend`; reads must return `Flow` |
| Stale UI data | used `List<T>` return instead of `Flow<List<T>>` | use `Flow` for any query the UI observes |
| Duplicate singletons | `RoomDatabase` instantiated in multiple places | enforce singleton via companion object or DI |
| Monetary precision loss | stored `Double` for money | always use `Int` cents or `Long` cents |
| Foreign key violations | no `ForeignKey` annotation or missing index | declare FK constraints and `@Index` on FK columns |

---

---

## Step 7 — FIELD SPECIFICATION FIDELITY

When the task prompt specifies exact field names, types, or defaults for an entity, those specifications
are the authoritative contract. Do NOT substitute plausible-sounding alternatives.

**Before writing any entity file:**
1. Re-read the task prompt's field list for that entity.
2. Map each specified field exactly — same name, same Kotlin type, same nullability, same default.
3. Do not add fields not in the spec. Do not rename fields to camelCase if the spec uses snake_case.

Common substitution mistakes to avoid:

| Task says | Do NOT write | Write this instead |
|-----------|-------------|-------------------|
| `name: String` | `source: String` or `title: String` | `val name: String` |
| `amount_cents: Int` | `amountCents: Long` or `amount: Double` | `val amount_cents: Int` |
| `next_date: String` | `date: Long` or `dueDate: Instant` | `val next_date: String` |
| `key: String` (PK) | `id: Int` | `@PrimaryKey val key: String` |
| `is_active: Int = 1` | `isActive: Boolean = true` | `val is_active: Int = 1` |
| `is_paid: Int = 0` | `isPaid: Boolean = false` | `val is_paid: Int = 0` |

**The field names in the task prompt are the schema contract. Follow them literally.**

---

## Hard Rules

1. All monetary amounts are stored as `Int` cents — no `Double`, no `Float`, no `BigDecimal` in entities.
2. Write operations are `suspend fun` in the DAO.
3. Observable queries return `Flow<T>`, never raw `List<T>`.
4. The database is a singleton.
5. Every schema version bump ships with an explicit `Migration` object.
6. The UI layer never imports Room DAO or entity types directly — access goes through the repository.
7. Entity fields are written exactly as specified in the task — name, type, nullability, default value. No substitutions.

---

## Kotlin `Result<T>` API Reference

Repository and domain functions that return `Result<T>` follow these exact method names.
Using the wrong method compiles but produces the wrong value silently.

| Intent | Correct method | Returns | WRONG alternatives |
|--------|---------------|---------|-------------------|
| Get the success value (or null) | `result.getOrNull()` | `T?` | ~~`result.value`~~, ~~`result.get()`~~ |
| Get the failure message | `result.exceptionOrNull()?.message` | `String?` | ~~`result.getOrNull()`~~ (returns `T?`, not the error), ~~`result.error`~~ |
| Get failure exception | `result.exceptionOrNull()` | `Throwable?` | ~~`result.exception`~~ |
| Check if successful | `result.isSuccess` | `Boolean` | ~~`result.isOk`~~ |
| Check if failed | `result.isFailure` | `Boolean` | ~~`result.isErr`~~ |
| Get value or throw | `result.getOrThrow()` | `T` | ~~`result.get()`~~ |
| Get value or default | `result.getOrDefault(default)` | `T` | ~~`result.orElse(default)`~~ |

**Common mistake to avoid:** When displaying a validation error message from a `Result<Int>`,
use `result.exceptionOrNull()?.message` — NOT `result.getOrNull()`. `getOrNull()` returns the
`Int` success value (or null), never the error string.
