package core.data

import retrofit2.http.POST

interface OtherApi {

    @POST("others")
    fun addOther(body: String): ThingRow
}
