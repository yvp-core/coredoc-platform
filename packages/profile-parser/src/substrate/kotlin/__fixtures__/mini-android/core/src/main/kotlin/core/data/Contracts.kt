package core.data

interface Repo {
    fun load(): String
}

class RepoImpl : Repo {
    override fun load(): String = "impl"
}

class RepoAlt : Repo {
    override fun load(): String = "alt"
}

interface Clock {
    fun now(): Long
}

class ClockImpl : Clock {
    override fun now(): Long = 0L
}

class Consumer(private val repo: Repo, private val clock: Clock) {
    fun run(): String {
        clock.now()
        return repo.load()
    }
}
