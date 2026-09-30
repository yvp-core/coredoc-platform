package core.data

import retrofit2.Retrofit

object Registry {
    fun keyOf(name: String): String = name
}

enum class Status {
    OK,
    FAILED;

    fun isOk(): Boolean = this == OK
}

fun ThingRow.describe(): String = label

fun format(value: String): String = value

fun format(value: Int): String = value.toString()

class ThingRepo {

    private val api: ThingApi =
        Retrofit.Builder().baseUrl("https://host.test/api/v1/").build().create(ThingApi::class.java)

    fun load(): ThingRow = api.getThing("1")

    fun raw(): ThingRow = api.fetchRaw("https://host.test/other")

    fun listen() {
        register(object : Callback {
            override fun onDone() {
                api.listThings("now")
                Registry.keyOf("done")
            }
        })
    }

    fun register(callback: Callback) {}
}

class OtherRepo(private val other: OtherApi) {
    fun push() {
        other.addOther("body")
    }
}
