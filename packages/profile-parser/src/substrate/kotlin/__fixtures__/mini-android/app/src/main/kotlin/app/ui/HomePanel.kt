package app.ui

import androidx.fragment.app.Fragment

class HomePanel : Fragment() {

    private val flavored: Flavored = Flavored()

    fun refresh(): String {
        setContentView(R.layout.home_screen)
        return flavored.ping()
    }
}
