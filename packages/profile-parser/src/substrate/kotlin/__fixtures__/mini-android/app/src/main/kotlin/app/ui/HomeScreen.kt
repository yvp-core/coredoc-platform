package app.ui

import androidx.compose.runtime.Composable

@Composable
fun AppNav(nav: NavHostController) {
    NavHost(nav, "home") {
        composable("home") { HomeScreen() }
    }
}

@Composable
fun HomeScreen() {
    Column {
        Panel()
    }
}

@Composable
fun Panel() {}
