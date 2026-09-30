package app.ui

import android.view.LayoutInflater
import android.view.View

class ThingView : View {
    fun attach(inflater: LayoutInflater) {
        HomeScreenBinding.inflate(inflater)
    }
}
