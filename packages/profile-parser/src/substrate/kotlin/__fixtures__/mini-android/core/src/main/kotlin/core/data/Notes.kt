package core.data

open class Note : RealmObject() {
    var id: Int = 0
    var tag: Tag? = null
}

open class Tag : RealmObject() {
    var id: Int = 0
}

class NoteRepo(private val realm: Realm) {

    fun load(): Note? = realm.where(Note::class.java).findFirst()

    fun wipe() {
        executeTransaction { }
    }

    fun store(note: Note) {
        val n: Note = note
        n.save()
    }
}
