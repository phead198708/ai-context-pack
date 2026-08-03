package com.aicontextpack

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class ShareIntentTransactionStore(
  private val filesDir: File,
  private val faultInjector: FaultInjector = FaultInjector.NONE,
) {
  enum class State {
    ACCEPTED,
    IN_PROGRESS,
    COMPLETE_NEEDS_EVENT,
    FAILED_NEEDS_EVENT,
    COMPLETE,
    FAILED,
    RECOVERY_REQUIRED,
  }

  enum class TerminalResult(val wireValue: String) {
    COMPLETE("complete"),
    FAILED("failed"),
  }

  data class Transaction(
    val id: String,
    val state: State,
    val order: Long,
    val terminalResult: TerminalResult? = null,
    val terminalCode: String? = null,
  ) {
    val isNonterminal: Boolean
      get() = state != State.COMPLETE && state != State.FAILED
  }

  data class StoreIssue(val id: String, val code: String)
  data class Snapshot(
    val transactions: List<Transaction>,
    val issues: List<StoreIssue>,
  )

  enum class WritePoint { BEFORE_PARTIAL_WRITE, BEFORE_ATOMIC_RENAME }

  fun interface FaultInjector {
    fun check(point: WritePoint, destination: File, payload: String)

    companion object {
      val NONE = FaultInjector { _, _, _ -> }
    }
  }

  private val directory = File(filesDir, "ShareIntentTransactions")
  private val queueIndex = File(directory, "queue.index")

  fun snapshot(): Snapshot = try {
    withJournalLock(::snapshotLocked)
  } catch (_: Exception) {
    Snapshot(
      emptyList(),
      listOf(StoreIssue(stableIssueId("journal-lock"), "SHARE_TRANSACTION_STORE_READ_FAILED")),
    )
  }

  private fun snapshotLocked(): Snapshot {
    val issues = mutableListOf<StoreIssue>()
    if (!directory.exists()) return Snapshot(emptyList(), emptyList())
    if (!directory.isDirectory) {
      val issue = StoreIssue(stableIssueId("directory"), "SHARE_TRANSACTION_STORE_READ_FAILED")
      quarantineExternal(directory, issue, issues)
      return Snapshot(emptyList(), issues)
    }

    val stateFiles = try {
      directory.listFiles()?.filter { it.isFile && it.name.endsWith(".state") }
        ?: throw IOException("transaction directory unreadable")
    } catch (_: Exception) {
      return Snapshot(
        emptyList(),
        listOf(StoreIssue(stableIssueId("listing"), "SHARE_TRANSACTION_STORE_READ_FAILED")),
      )
    }

    val transactions = stateFiles.mapNotNull { file ->
      try {
        readState(file)
      } catch (_: IOException) {
        val issue = StoreIssue(issueIdFor(file), "SHARE_TRANSACTION_STORE_READ_FAILED")
        quarantine(file, issue, issues)
        null
      } catch (_: Exception) {
        val issue = StoreIssue(issueIdFor(file), "SHARE_TRANSACTION_SCHEMA_INVALID")
        quarantine(file, issue, issues)
        null
      }
    }.sortedWith(compareBy<Transaction> { it.order }.thenBy { it.id })

    val expectedIds = transactions.filter { it.isNonterminal }.map { it.id }
    val indexedIds = readQueueIndex(issues)
    if (indexedIds != expectedIds) {
      if (indexedIds != null) {
        issues += StoreIssue(stableIssueId("queue-mismatch"), "SHARE_TRANSACTION_SCHEMA_INVALID")
        quarantine(queueIndex, issues.last(), issues)
      }
      try {
        publishQueueIndex(expectedIds)
      } catch (_: Exception) {
        issues += StoreIssue(stableIssueId("queue-write"), "SHARE_TRANSACTION_STORE_WRITE_FAILED")
      }
    }
    return Snapshot(transactions.filter { it.isNonterminal }, issues.distinctBy { it.id to it.code })
  }

  fun acceptNew(id: String = UUID.randomUUID().toString()): Transaction {
    requireCanonicalUuid(id)
    return try {
      withJournalLock { acceptNewLocked(id) }
    } catch (error: ShareTransactionException) {
      throw error
    } catch (error: Exception) {
      throw ShareTransactionException("SHARE_TRANSACTION_STORE_WRITE_FAILED", id, error)
    }
  }

  private fun acceptNewLocked(id: String): Transaction {
    try {
      ensureDirectory()
    } catch (error: Exception) {
      throw ShareTransactionException("SHARE_TRANSACTION_STORE_WRITE_FAILED", id, error)
    }
    val current = snapshotLocked()
    if (current.issues.isNotEmpty()) {
      throw ShareTransactionException(current.issues.first().code, current.issues.first().id)
    }
    val order = try {
      (allValidTransactions().maxOfOrNull { it.order } ?: 0L) + 1L
    } catch (error: IOException) {
      throw ShareTransactionException("SHARE_TRANSACTION_STORE_READ_FAILED", id, error)
    } catch (error: Exception) {
      throw ShareTransactionException("SHARE_TRANSACTION_SCHEMA_INVALID", id, error)
    }
    val transaction = Transaction(id, State.ACCEPTED, order)
    writeNew(transaction)
    try {
      publishQueueIndex((current.transactions + transaction).sortedBy { it.order }.map { it.id })
    } catch (error: Exception) {
      throw ShareTransactionException("SHARE_TRANSACTION_STORE_WRITE_FAILED", id, error)
    }
    return transaction
  }

  fun markInProgress(id: String): Transaction = updateWithJournalLock(id) { current ->
    when (current.state) {
      State.ACCEPTED -> current.copy(state = State.IN_PROGRESS)
      State.IN_PROGRESS -> current
      else -> throw ShareTransactionException("SHARE_TRANSACTION_TRANSITION_FAILED", id)
    }
  }

  fun markRecoveryRequired(id: String): Transaction = updateWithJournalLock(id) { current ->
    when (current.state) {
      State.ACCEPTED, State.IN_PROGRESS, State.RECOVERY_REQUIRED ->
        current.copy(state = State.RECOVERY_REQUIRED)
      else -> throw ShareTransactionException("SHARE_TRANSACTION_TRANSITION_FAILED", id)
    }
  }

  fun prepareTerminal(
    id: String,
    result: TerminalResult,
    code: String? = null,
  ): Transaction = updateWithJournalLock(id) { current ->
    if (current.terminalResult != null && current.terminalResult != result) {
      throw ShareTransactionException("SHARE_TRANSACTION_TERMINAL_CONFLICT", id)
    }
    if ((current.state == State.COMPLETE || current.state == State.FAILED) &&
      current.terminalResult == result) return@updateWithJournalLock current
    current.copy(
      state = if (result == TerminalResult.COMPLETE) State.COMPLETE_NEEDS_EVENT
      else State.FAILED_NEEDS_EVENT,
      terminalResult = result,
      terminalCode = code,
    )
  }

  fun markEventPublished(id: String): Transaction = updateWithJournalLock(id) { current ->
    when (current.state) {
      State.COMPLETE_NEEDS_EVENT -> current.copy(state = State.COMPLETE)
      State.FAILED_NEEDS_EVENT -> current.copy(state = State.FAILED)
      State.COMPLETE, State.FAILED -> current
      else -> throw ShareTransactionException("SHARE_TRANSACTION_TRANSITION_FAILED", id)
    }
  }

  private fun updateWithJournalLock(
    id: String,
    transform: (Transaction) -> Transaction,
  ): Transaction {
    requireCanonicalUuid(id)
    return try {
      withJournalLock { updateLocked(id, transform) }
    } catch (error: ShareTransactionException) {
      throw error
    } catch (error: Exception) {
      throw ShareTransactionException("SHARE_TRANSACTION_TRANSITION_FAILED", id, error)
    }
  }

  private fun updateLocked(id: String, transform: (Transaction) -> Transaction): Transaction {
    val current = try {
      readState(File(directory, "$id.state"))
    } catch (error: ShareTransactionException) {
      throw error
    } catch (error: IOException) {
      throw ShareTransactionException("SHARE_TRANSACTION_STORE_READ_FAILED", id, error)
    } catch (error: Exception) {
      throw ShareTransactionException("SHARE_TRANSACTION_SCHEMA_INVALID", id, error)
    }
    val updated = transform(current)
    if (updated != current) {
      try {
        publishState(updated)
      } catch (error: Exception) {
        throw ShareTransactionException("SHARE_TRANSACTION_TRANSITION_FAILED", id, error)
      }
    }
    try {
      val ids = allValidTransactions().filter { it.isNonterminal }
        .sortedWith(compareBy<Transaction> { it.order }.thenBy { it.id })
        .map { it.id }
      publishQueueIndex(ids)
    } catch (error: Exception) {
      throw ShareTransactionException("SHARE_TRANSACTION_TRANSITION_FAILED", id, error)
    }
    return updated
  }

  private fun writeNew(transaction: Transaction) {
    val destination = File(directory, "${transaction.id}.state")
    check(!destination.exists()) { "transaction already exists" }
    try {
      publishState(transaction)
    } catch (error: Exception) {
      throw ShareTransactionException("SHARE_TRANSACTION_STORE_WRITE_FAILED", transaction.id, error)
    }
  }

  private fun allValidTransactions(): List<Transaction> {
    if (!directory.isDirectory) return emptyList()
    return (directory.listFiles() ?: throw IOException("transaction directory unreadable"))
      .filter { it.isFile && it.name.endsWith(".state") }
      .map { readState(it) }
  }

  private fun readState(file: File): Transaction {
    val values = readValues(file)
    val schema = values["schemaVersion"]
    val id = requireNotNull(values["id"])
    requireCanonicalUuid(id)
    check(file.name == "$id.state")
    val rawState = requireNotNull(values["state"])
    if (schema == "1") {
      val migratedState = if (rawState == "PUBLISHED_NEEDS_EVENT") State.COMPLETE_NEEDS_EVENT
      else State.valueOf(rawState)
      val result = when (migratedState) {
        State.COMPLETE_NEEDS_EVENT, State.COMPLETE -> TerminalResult.COMPLETE
        State.FAILED_NEEDS_EVENT, State.FAILED -> TerminalResult.FAILED
        else -> null
      }
      return Transaction(id, migratedState, file.lastModified().coerceAtLeast(1), result)
    }
    check(schema == "2")
    val state = State.valueOf(rawState)
    val terminalResult = values["terminalResult"]?.let(TerminalResult::valueOf)
    val terminalCode = values["terminalCode"]
    check(values.getValue("order").toLong() > 0)
    check((state == State.COMPLETE_NEEDS_EVENT || state == State.FAILED_NEEDS_EVENT ||
      state == State.COMPLETE || state == State.FAILED) == (terminalResult != null))
    check(terminalCode == null || terminalResult == TerminalResult.FAILED)
    return Transaction(id, state, values.getValue("order").toLong(), terminalResult, terminalCode)
  }

  private fun readQueueIndex(issues: MutableList<StoreIssue>): List<String>? {
    if (!queueIndex.exists()) return null
    return try {
      val values = readValues(queueIndex)
      check(values["schemaVersion"] == "1")
      val ids = values["ids"].orEmpty().split(',').filter { it.isNotEmpty() }
      ids.forEach(::requireCanonicalUuid)
      check(ids.distinct().size == ids.size)
      ids
    } catch (_: IOException) {
      val issue = StoreIssue(stableIssueId("queue-read"), "SHARE_TRANSACTION_STORE_READ_FAILED")
      quarantine(queueIndex, issue, issues)
      null
    } catch (_: Exception) {
      val issue = StoreIssue(stableIssueId("queue-schema"), "SHARE_TRANSACTION_SCHEMA_INVALID")
      quarantine(queueIndex, issue, issues)
      null
    }
  }

  private fun readValues(file: File): Map<String, String> =
    file.readLines().associate { line ->
      val parts = line.split('=', limit = 2)
      check(parts.size == 2 && parts[0].isNotEmpty())
      parts[0] to parts[1]
    }

  private fun publishState(transaction: Transaction) {
    val payload = buildString {
      append("schemaVersion=2\n")
      append("id=${transaction.id}\n")
      append("state=${transaction.state.name}\n")
      append("order=${transaction.order}\n")
      transaction.terminalResult?.let { append("terminalResult=${it.name}\n") }
      transaction.terminalCode?.let {
        check(stableCode.matches(it))
        append("terminalCode=$it\n")
      }
    }
    publish(File(directory, "${transaction.id}.state"), payload)
  }

  private fun publishQueueIndex(ids: List<String>) {
    ensureDirectory()
    val payload = "schemaVersion=1\nids=${ids.joinToString(",")}\n"
    publish(queueIndex, payload)
  }

  private fun publish(destination: File, payload: String) {
    val partial = File(
      requireNotNull(destination.parentFile),
      "${destination.name}.${UUID.randomUUID()}.partial",
    )
    try {
      faultInjector.check(WritePoint.BEFORE_PARTIAL_WRITE, destination, payload)
      partial.writeText(payload)
      faultInjector.check(WritePoint.BEFORE_ATOMIC_RENAME, destination, payload)
      check(partial.renameTo(destination))
    } finally {
      partial.delete()
    }
  }

  private fun ensureDirectory() {
    check(directory.mkdirs() || directory.isDirectory)
  }

  private fun <T> withJournalLock(block: () -> T): T {
    val lockFile = File(filesDir, journalLockFileName)
    val lockKey = runCatching { lockFile.canonicalPath }.getOrElse { lockFile.absolutePath }
    return processLocks.computeIfAbsent(lockKey) { ReentrantLock() }.withLock {
      check(filesDir.mkdirs() || filesDir.isDirectory)
      RandomAccessFile(lockFile, "rw").use { handle ->
        handle.channel.lock().use { block() }
      }
    }
  }

  private fun quarantine(file: File, issue: StoreIssue, issues: MutableList<StoreIssue>) {
    if (!file.exists()) {
      issues += issue
      return
    }
    val destination = File(file.parentFile, "${file.name}.${UUID.randomUUID()}.invalid")
    if (!file.renameTo(destination)) {
      issues += StoreIssue(issue.id, "SHARE_TRANSACTION_QUARANTINE_FAILED")
    } else {
      issues += issue
    }
  }

  private fun quarantineExternal(file: File, issue: StoreIssue, issues: MutableList<StoreIssue>) {
    val destination = File(filesDir, "${file.name}.${UUID.randomUUID()}.invalid")
    if (!file.renameTo(destination)) {
      issues += StoreIssue(issue.id, "SHARE_TRANSACTION_QUARANTINE_FAILED")
    } else {
      issues += issue
    }
  }

  private fun issueIdFor(file: File): String {
    val name = file.name.removeSuffix(".state")
    return runCatching { UUID.fromString(name).toString() }.getOrElse { stableIssueId(file.name) }
  }

  private fun stableIssueId(key: String): String = UUID.nameUUIDFromBytes(
    "ai-context-pack:share-transaction:$key".toByteArray(StandardCharsets.UTF_8),
  ).toString()

  private fun requireCanonicalUuid(value: String) {
    require(UUID.fromString(value).toString() == value.lowercase())
  }

  companion object {
    private const val journalLockFileName = ".share-intent-transactions.lock"
    private val processLocks = ConcurrentHashMap<String, ReentrantLock>()
    private val stableCode = Regex("^[A-Z][A-Z0-9_]{2,80}$")
  }
}

internal class ShareTransactionException(
  val stableCode: String,
  val transactionId: String,
  cause: Throwable? = null,
) : Exception(stableCode, cause)
