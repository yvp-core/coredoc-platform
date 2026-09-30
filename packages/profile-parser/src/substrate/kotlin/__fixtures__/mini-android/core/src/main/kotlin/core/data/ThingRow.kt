package core.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = ThingRow.TABLE_NAME)
data class ThingRow(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "thing_label") val label: String
) {
    companion object {
        const val TABLE_NAME = "things"
    }
}
