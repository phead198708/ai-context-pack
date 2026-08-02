package com.aicontextpack

import java.io.File
import java.util.UUID

internal class ShareIntentTransactionStore(private val filesDir: File) {
  enum class State { ACCEPTED, IN_PROGRESS, PUBLISHED_NEEDS_EVENT, COMPLETE, FAILED, RECOVERY_REQUIRED }
  data class Transaction(val id: String, val state: State)

  private val directory = File(filesDir, "ShareIntentTransactions")
  private val active = File(directory, "active")

  fun acceptNew(): Transaction {
    val transaction = writeState(Transaction(UUID.randomUUID().toString(), State.ACCEPTED))
    publish(File(directory, "active.partial"), active, "schemaVersion=1\nid=${transaction.id}\n")
    return transaction
  }

  fun restored(): Transaction? {
    val activeValues = readValues(active) ?: return null
    val transaction = readState(requireNotNull(activeValues["id"]))
    if (transaction.state == State.ACCEPTED || transaction.state == State.IN_PROGRESS) {
      if (File(filesDir, "Inbox/${transaction.id}/manifest.json").isFile)
        return writeState(transaction.copy(state = State.PUBLISHED_NEEDS_EVENT))
      if (File(filesDir, "InboxStaging/${transaction.id}").exists())
        return writeState(transaction.copy(state = State.RECOVERY_REQUIRED))
    }
    return transaction
  }

  fun transition(id: String, state: State): Transaction {
    readState(id)
    return writeState(Transaction(id, state))
  }

  private fun readState(id: String): Transaction {
    require(UUID.fromString(id).toString() == id)
    val values = requireNotNull(readValues(File(directory, "$id.state")))
    require(values["id"] == id)
    return Transaction(id, State.valueOf(requireNotNull(values["state"])))
  }

  private fun readValues(file: File): Map<String, String>? {
    if (!file.exists()) return null
    val values = file.readLines().associate { line ->
      val (key, value) = line.split('=', limit = 2)
      key to value
    }
    require(values["schemaVersion"] == "1")
    return values
  }

  private fun writeState(transaction: Transaction): Transaction {
    check(directory.mkdirs() || directory.isDirectory)
    val partial = File(directory, "${transaction.id}.partial")
    val stateFile = File(directory, "${transaction.id}.state")
    val payload = "schemaVersion=1\nid=${transaction.id}\nstate=${transaction.state.name}\n"
    publish(partial, stateFile, payload)
    return transaction
  }

  private fun publish(partial: File, destination: File, payload: String) {
    try {
      partial.writeText(payload)
      check(partial.renameTo(destination))
    } finally {
      partial.delete()
    }
  }
}
