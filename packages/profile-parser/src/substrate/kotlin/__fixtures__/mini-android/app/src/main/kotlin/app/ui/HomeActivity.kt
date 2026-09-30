package app.ui

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import core.data.ThingRepo

@Keep
class HomeActivity : AppCompatActivity() {

    @Keep
    val tag: String = "home"

    private val repo: ThingRepo = ThingRepo()

    @Keep
    fun onCreate(@Keep state: Bundle?) {
        setContentView(R.layout.home_screen)
        repo.load()
        showDetail()
    }

    fun showDetail() {
        startActivity(Intent(this, DetailActivity::class.java))
    }
}
