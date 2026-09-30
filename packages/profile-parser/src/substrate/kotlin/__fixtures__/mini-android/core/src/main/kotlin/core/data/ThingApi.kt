package core.data

import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Url

interface ThingApi {

    @GET("things/{id}")
    fun getThing(@Path("id") id: String): ThingRow

    @GET("things")
    fun listThings(@Query("since") since: String): List<ThingRow>

    @GET
    fun fetchRaw(@Url url: String): ThingRow
}
