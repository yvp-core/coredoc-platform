package app.di

import core.data.Clock
import core.data.ClockImpl
import core.data.OtherApi
import core.data.Repo
import core.data.RepoAlt
import core.data.RepoImpl

fun appModule() {
    single(named("api")) { Retrofit.Builder().baseUrl("https://host.test/api/v2").build() }
    single { get<Retrofit>(named("api")).create(OtherApi::class.java) }
    single<Repo> { RepoImpl() }
    single<Repo> { RepoAlt() }
    single<Clock> { ClockImpl() }
}
