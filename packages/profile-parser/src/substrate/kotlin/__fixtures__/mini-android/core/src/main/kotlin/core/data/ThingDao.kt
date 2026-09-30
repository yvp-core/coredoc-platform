package core.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Transaction

@Dao
abstract class ThingDao {

    companion object {
        const val TABLE = "things"
    }

    @Query("SELECT * FROM ${TABLE}")
    abstract fun all(): List<ThingRow>

    @Insert
    abstract fun put(row: ThingRow)

    @Transaction
    abstract fun both()

    @Query("PRAGMA user_version")
    abstract fun version(): Int
}
